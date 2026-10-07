package localcomfy

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

type Executor struct {
	Client    *Client
	Resources Resources
	Ledger    Ledger
}

// Admit is read-only: selection, frozen revision, switch and native references
// are checked again immediately before a new submission, never during recovery.
func (e Executor) Admit(ctx context.Context, mode string, selection Selection, refs []Resource) (Selection, error) {
	if !recipePattern.MatchString(selection.RecipeID) || (mode != "image" && mode != "video") {
		return selection, fail(400, "invalid_local_comfy_input", "本地配方任务参数无效")
	}
	config, err := e.Client.Config(ctx)
	if err != nil {
		return selection, err
	}
	if !config.Configured {
		return selection, fail(503, "adapter_not_configured", "尚未配置本地生成适配器")
	}
	if !config.GenerationEnabled {
		return selection, fail(403, "generation_disabled", "本地生成开关已关闭；本次没有提交GPU作业")
	}
	recipes, err := e.Client.Recipes(ctx)
	if err != nil {
		return selection, err
	}
	for _, recipe := range recipes {
		if recipe.ID != selection.RecipeID {
			continue
		}
		if !recipe.NativeReady() || recipe.NativeMode() != mode {
			return selection, fail(400, "recipe_not_available", "配方尚未就绪或不支持当前原生生成模式")
		}
		if selection.Version != "" && selection.Version != recipe.Version {
			return selection, fail(409, "recipe_version_changed", "配方已变化，请重新准备并批准任务")
		}
		if selection.Recipe != nil {
			approved, current := *selection.Recipe, recipe
			approved.Name = ""
			current.Name = ""
			approved.Ready = false
			current.Ready = false
			left, _ := json.Marshal(approved)
			right, _ := json.Marshal(current)
			if string(left) != string(right) {
				return selection, fail(409, "recipe_version_changed", "已批准的配方规范与当前配方不一致")
			}
		}
		if len(refs) != recipe.ReferenceSlots {
			return selection, fail(400, "reference_count_mismatch", "参考图片数量与配方不符")
		}
		for i, ref := range refs {
			limit := config.MaxReferenceBytes
			if limit <= 0 || limit > 10<<20 {
				limit = 10 << 20
			}
			if ref.ID == "" || ref.Size <= 0 || ref.Size > limit || !strings.HasPrefix(ref.MimeType, "image/") {
				return selection, fail(400, "reference_invalid", "参考图无效或超过大小限制")
			}
			if i < len(recipe.Constraints) {
				c := recipe.Constraints[i]
				if len(c.MimeTypes) > 0 && !contains(c.MimeTypes, ref.MimeType) {
					return selection, fail(400, "reference_mime_not_supported", "参考图格式不符合配方要求")
				}
				if c.Width > 0 && c.Height > 0 && (ref.Width < c.Width || ref.Height < c.Height || int64(ref.Width)*int64(c.Height) != int64(ref.Height)*int64(c.Width)) {
					return selection, fail(400, "reference_aspect_mismatch", "参考图尺寸或宽高比不符合配方要求")
				}
			}
		}
		selection.Version = recipe.Version
		// Display labels do not belong in the immutable execution snapshot.
		recipe.Name = ""
		selection.Recipe = &recipe
		return selection, nil
	}
	return selection, fail(400, "recipe_not_available", "配方未登记")
}
func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
func sameJob(a, b Job) bool {
	return a.ID == b.ID && a.ProjectID == b.ProjectID && a.ShotID == b.ShotID && a.RecipeID == b.RecipeID && a.Version == b.Version && a.Key == b.Key
}

func (e Executor) ValidateBinding(ctx context.Context, r Request, job Job) error {
	if !ValidID(job.ID) || !ValidID(job.ProjectID) || !ValidID(job.ShotID) || job.RecipeID != r.Selection.RecipeID || job.Version != r.Selection.Version || job.Key != RequestKey(r.TaskID, r.Selection) {
		return fail(502, "adapter_job_binding_mismatch", "适配器作业与原生任务绑定不一致")
	}
	var project Project
	var shot Shot
	if err := e.Client.request(ctx, http.MethodGet, "/projects/"+job.ProjectID, nil, &project); err != nil {
		return err
	}
	if err := e.Client.request(ctx, http.MethodGet, "/shots/"+job.ShotID, nil, &shot); err != nil {
		return err
	}
	if project.ID != job.ProjectID || project.Upstream != ProjectIdentity(r.OwnerID, r.ProjectID) || project.CanvasID != r.ProjectID || shot.ID != job.ShotID || shot.ProjectID != project.ID || shot.Upstream != r.TaskID {
		return fail(502, "adapter_job_binding_mismatch", "适配器作业属于另一用户、项目或原生任务")
	}
	return nil
}

// FindCommitted must remain GET-only. A missing acknowledgement is not
// permission to create projects, shots, references or another GPU job.
func (e Executor) FindCommitted(ctx context.Context, r Request) (Job, error) {
	var projects []Project
	if err := e.Client.request(ctx, http.MethodGet, "/projects", nil, &projects); err != nil {
		return Job{}, err
	}
	var found *Job
	for _, project := range projects {
		if !ValidID(project.ID) || project.Upstream != ProjectIdentity(r.OwnerID, r.ProjectID) || project.CanvasID != r.ProjectID {
			continue
		}
		var shots []Shot
		if err := e.Client.request(ctx, http.MethodGet, "/shots?project_id="+project.ID, nil, &shots); err != nil {
			return Job{}, err
		}
		for _, shot := range shots {
			if !ValidID(shot.ID) || shot.ProjectID != project.ID || shot.Upstream != r.TaskID {
				continue
			}
			var jobs []Job
			if err := e.Client.request(ctx, http.MethodGet, "/jobs?project_id="+project.ID+"&shot_id="+shot.ID, nil, &jobs); err != nil {
				return Job{}, err
			}
			for _, job := range jobs {
				if job.Key != RequestKey(r.TaskID, r.Selection) {
					continue
				}
				if err := e.ValidateBinding(ctx, r, job); err != nil {
					return Job{}, err
				}
				if found != nil && found.ID != job.ID {
					return Job{}, fail(409, "ambiguous_job_binding", "同一原生请求出现多个作业，请人工核对")
				}
				copy := job
				found = &copy
			}
		}
	}
	if found != nil {
		return *found, nil
	}
	return Job{}, fail(409, "submission_unknown", "未找到原作业；本次没有重新提交")
}

func (e Executor) ensureObjects(ctx context.Context, r Request) (Project, Shot, error) {
	var projects []Project
	if err := e.Client.request(ctx, http.MethodGet, "/projects", nil, &projects); err != nil {
		return Project{}, Shot{}, err
	}
	project := Project{}
	for _, item := range projects {
		if item.Upstream == ProjectIdentity(r.OwnerID, r.ProjectID) && item.CanvasID == r.ProjectID {
			project = item
			break
		}
	}
	if project.ID == "" {
		if err := e.Client.request(ctx, http.MethodPost, "/projects", map[string]any{"name": "Native BeefTV", "upstream_project_id": ProjectIdentity(r.OwnerID, r.ProjectID), "canvas_project_id": r.ProjectID}, &project); err != nil {
			return Project{}, Shot{}, err
		}
	}
	if !ValidID(project.ID) || project.Upstream != ProjectIdentity(r.OwnerID, r.ProjectID) || project.CanvasID != r.ProjectID {
		return Project{}, Shot{}, fail(502, "adapter_project_binding_mismatch", "本地项目关联无效")
	}
	var shots []Shot
	if err := e.Client.request(ctx, http.MethodGet, "/shots?project_id="+project.ID, nil, &shots); err != nil {
		return Project{}, Shot{}, err
	}
	var existing *Shot
	for _, shot := range shots {
		if shot.Upstream == r.TaskID {
			if !ValidID(shot.ID) || shot.ProjectID != project.ID {
				return Project{}, Shot{}, fail(502, "adapter_shot_binding_mismatch", "本地镜头关联无效")
			}
			copy := shot
			existing = &copy
		}
	}
	var assets []Asset
	if err := e.Client.request(ctx, http.MethodGet, "/assets?project_id="+project.ID, nil, &assets); err != nil {
		return Project{}, Shot{}, err
	}
	ids := make([]string, 0, len(r.References))
	for _, ref := range r.References {
		data, err := e.Resources.Read(r.OwnerID, ref.ID, 10<<20)
		if err != nil {
			return Project{}, Shot{}, err
		}
		sum := sha256.Sum256(data)
		hash := hex.EncodeToString(sum[:])
		if int64(len(data)) != ref.Size || http.DetectContentType(data) != ref.MimeType {
			return Project{}, Shot{}, fail(400, "reference_integrity_failed", "原生参考资源字节或格式不匹配")
		}
		asset := Asset{}
		for _, item := range assets {
			if item.Upstream == ref.ID {
				asset = item
				break
			}
		}
		if asset.ID == "" {
			if err := e.Client.request(ctx, http.MethodPost, "/assets", map[string]any{"project_id": project.ID, "name": ref.ID, "kind": "reference", "mime_type": ref.MimeType, "data_base64": base64.StdEncoding.EncodeToString(data), "upstream_asset_id": ref.ID}, &asset); err != nil {
				return Project{}, Shot{}, err
			}
		}
		if !ValidID(asset.ID) || asset.ProjectID != project.ID || asset.Upstream != ref.ID || asset.Size != ref.Size || asset.SHA256 != hash || asset.MimeType != ref.MimeType {
			return Project{}, Shot{}, fail(502, "reference_binding_mismatch", "适配器参考资源关联或校验不匹配")
		}
		ids = append(ids, asset.ID)
	}
	var shot Shot
	if existing != nil {
		if !slices.Equal(existing.References, ids) {
			return Project{}, Shot{}, fail(409, "adapter_shot_binding_mismatch", "原镜头参考资源已变化，拒绝提交")
		}
		return project, *existing, nil
	}
	if err := e.Client.request(ctx, http.MethodPost, "/shots", map[string]any{"project_id": project.ID, "name": "Native task " + r.TaskID, "upstream_shot_id": r.TaskID, "reference_asset_ids": ids}, &shot); err != nil {
		return Project{}, Shot{}, err
	}
	if !ValidID(shot.ID) || shot.ProjectID != project.ID || shot.Upstream != r.TaskID || !slices.Equal(shot.References, ids) {
		return Project{}, Shot{}, fail(502, "adapter_shot_binding_mismatch", "本地镜头关联无效")
	}
	return project, shot, nil
}

func (e Executor) Execute(ctx context.Context, r Request) (map[string]any, error) {
	if e.Client == nil || e.Resources == nil || e.Ledger == nil || r.OwnerID == "" || r.TaskID == "" || !recipePattern.MatchString(r.Selection.RecipeID) || !versionPattern.MatchString(r.Selection.Version) || r.Selection.Recipe == nil || !r.Selection.Recipe.NativeReady() || r.Selection.Recipe.NativeMode() != r.Mode {
		return nil, fail(400, "native_task_required", "本地生成必须使用已准入的原生任务")
	}
	var job Job
	var err error
	if r.JobID != "" {
		job, err = e.Client.Job(ctx, r.JobID)
		if err != nil {
			return nil, PendingError{r.JobID}
		}
		if job.ID != r.JobID {
			return nil, fail(502, "adapter_job_binding_mismatch", "适配器返回了另一作业")
		}
	} else {
		job, err = e.FindCommitted(ctx, r)
		if err != nil && !IsMissing(err) {
			return nil, err
		}
		if err != nil && r.ResumeOnly {
			return nil, UnknownError{err}
		}
	}
	if job.ID == "" {
		selection, err := e.Admit(ctx, r.Mode, r.Selection, r.References)
		if err != nil {
			return nil, err
		}
		r.Selection = selection
		project, shot, err := e.ensureObjects(ctx, r)
		if err != nil {
			return nil, err
		}
		if _, err := e.Admit(ctx, r.Mode, r.Selection, r.References); err != nil {
			return nil, err
		}
		path := "/jobs"
		payload := map[string]any{"project_id": project.ID, "shot_id": shot.ID, "recipe_id": r.Selection.RecipeID, "recipe_version": r.Selection.Version, "prompt": r.Prompt, "seed": r.Selection.Seed, "request_key": RequestKey(r.TaskID, r.Selection)}
		if r.Selection.RetryJobID != "" {
			parent, err := e.Client.Job(ctx, r.Selection.RetryJobID)
			if err != nil {
				return nil, err
			}
			if parent.ID != r.Selection.RetryJobID || parent.Status != "failed" || parent.ProjectID != project.ID || parent.ShotID != shot.ID || parent.RecipeID != r.Selection.RecipeID || parent.Version != r.Selection.Version {
				return nil, fail(409, "retry_not_safe", "原作业未明确失败，拒绝重新提交")
			}
			path = "/jobs/" + parent.ID + "/retry"
			payload = map[string]any{"request_key": RequestKey(r.TaskID, r.Selection), "recipe_version": r.Selection.Version}
		}
		// Persist the uncertainty fence BEFORE POST. Crash/restart must only read.
		if err := e.Ledger.Save(ctx, "", "submitting"); err != nil {
			return nil, err
		}
		if err := e.Client.request(ctx, http.MethodPost, path, payload, &job); err != nil {
			var apiErr *Error
			if errors.As(err, &apiErr) && (apiErr.Status < 500 || apiErr.Reason == "comfy_unavailable") {
				if saveErr := e.Ledger.Save(ctx, "", "rejected"); saveErr != nil {
					return nil, UnknownError{saveErr}
				}
				return nil, err
			}
			return nil, UnknownError{err}
		}
	}
	if err := e.ValidateBinding(ctx, r, job); err != nil {
		return nil, UnknownError{err}
	}
	if err := e.Ledger.Save(ctx, job.ID, job.Status); err != nil {
		return nil, UnknownError{err}
	}
	if job.Status == "submitting" || job.Status == "submission_unknown" {
		return nil, UnknownError{nil}
	}
	if job.Status == "submitted" || job.Status == "running" {
		previous := job
		if err := e.Client.request(ctx, http.MethodPost, "/jobs/"+job.ID+"/poll", map[string]any{}, &job); err != nil {
			return nil, PendingError{previous.ID}
		}
		if !sameJob(previous, job) {
			return nil, fail(502, "adapter_job_binding_mismatch", "轮询响应更换了作业身份")
		}
		if err := e.Ledger.Save(ctx, job.ID, job.Status); err != nil {
			return nil, PendingError{job.ID}
		}
	}
	if job.Status == "failed" {
		return nil, fail(502, "comfy_execution_failed", "本地作业明确失败，可显式重做")
	}
	if job.Status != "completed" {
		return nil, PendingError{job.ID}
	}
	previous := job
	if err := e.Client.request(ctx, http.MethodPost, "/jobs/"+job.ID+"/archive", map[string]any{}, &job); err != nil {
		return nil, PendingError{previous.ID}
	}
	if !sameJob(previous, job) || job.Status != "completed" {
		return nil, fail(502, "adapter_job_binding_mismatch", "归档响应更换了作业身份")
	}
	return e.materialize(ctx, r, job)
}

func (e Executor) materialize(ctx context.Context, r Request, job Job) (map[string]any, error) {
	if len(job.Assets) == 0 || len(job.Assets) > 16 {
		return nil, fail(502, "comfy_completed_without_results", "本地作业没有可归档结果")
	}
	result := map[string]any{"mode": r.Mode, "localComfy": map[string]any{"recipeId": job.RecipeID, "recipeVersion": job.Version, "jobId": job.ID, "promptId": job.PromptID, "status": job.Status}}
	images := []Media{}
	seen := map[string]bool{}
	for _, id := range job.Assets {
		if !ValidID(id) || seen[id] {
			return nil, fail(502, "adapter_invalid_response", "归档资源ID无效或重复")
		}
		seen[id] = true
		var asset Asset
		if err := e.Client.request(ctx, http.MethodGet, "/assets/"+id, nil, &asset); err != nil {
			return nil, PendingError{job.ID}
		}
		if asset.ID != id || asset.ProjectID != job.ProjectID || asset.JobID != job.ID || asset.Size <= 0 || asset.Size > 256<<20 || !versionPattern.MatchString(asset.SHA256) || !strings.HasPrefix(asset.MimeType, r.Mode+"/") || !contains([]string{"image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"}, asset.MimeType) {
			return nil, fail(502, "archive_binding_mismatch", "归档资源与作业、大小或媒体类型不匹配")
		}
		if expected := r.Selection.Recipe.Output.MimeType; expected != "" && asset.MimeType != expected {
			return nil, fail(502, "output_spec_mismatch", "生成结果容器与批准的配方规范不一致")
		}
		media, err := e.Resources.Import(ctx, r.OwnerID, "local-comfy:"+job.ID+":"+id, r.Mode, asset, r.Selection.Recipe.Output, func() ([]byte, error) {
			data, err := e.Client.bytes(ctx, http.MethodGet, "/assets/"+url.PathEscape(id)+"/content", nil, asset.Size)
			if err != nil {
				return nil, err
			}
			sum := sha256.Sum256(data)
			if int64(len(data)) != asset.Size || hex.EncodeToString(sum[:]) != asset.SHA256 || http.DetectContentType(data) != asset.MimeType {
				return nil, fail(502, "archive_integrity_failed", "归档资源SHA256、大小或实际媒体类型校验失败")
			}
			return data, nil
		})
		if err != nil {
			return nil, err
		}
		if err := r.Selection.Recipe.Output.CheckMedia(r.Mode, media.Width, media.Height, media.DurationMs); err != nil {
			return nil, err
		}
		if r.Mode == "image" {
			images = append(images, media)
		} else if result["video"] == nil {
			result["video"] = media
		}
	}
	if r.Mode == "image" {
		result["images"] = images
	}
	return result, nil
}

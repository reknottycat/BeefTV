package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const localComfyModelPrefix = "local-comfy:"
const localComfyAdapterOrigin = "http://comfy-adapter:6007/api/local-comfy/v1"

var localComfyIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var localComfyRecipePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var localComfyReasonPattern = regexp.MustCompile(`^[a-z0-9_]{1,100}$`)
var localComfyDefaultTransport = &http.Transport{Proxy: nil}

// This private test seam replaces transport, never the deployment destination.
// The adapter is a fixed internal Compose service, independent of cloud SSRF policy.
type localComfyRoundTripper interface {
	RoundTrip(*http.Request) (*http.Response, error)
}

type localComfyTaskInput struct {
	RecipeID   string `json:"recipeId"`
	Seed       uint32 `json:"seed"`
	RetryJobID string `json:"_retryJobId,omitempty"`
	RetryKey   string `json:"_retryKey,omitempty"`
}

type localComfyRecipe struct {
	ID             string `json:"id"`
	Mode           string `json:"mode"`
	Ready          bool   `json:"ready"`
	ReferenceSlots int    `json:"reference_slots"`
	Constraints    []struct {
		Width     int      `json:"width"`
		Height    int      `json:"height"`
		MimeTypes []string `json:"mime_types"`
	} `json:"reference_constraints"`
}

type localComfyProject struct {
	ID       string `json:"id"`
	Upstream string `json:"upstream_project_id"`
	CanvasID string `json:"canvas_project_id"`
}

type localComfyShot struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Upstream  string `json:"upstream_shot_id"`
}

type localComfyJob struct {
	ID        string   `json:"id"`
	ProjectID string   `json:"project_id"`
	ShotID    string   `json:"shot_id"`
	RecipeID  string   `json:"recipe_id"`
	PromptID  string   `json:"prompt_id"`
	Status    string   `json:"status"`
	Error     string   `json:"error"`
	Key       string   `json:"request_key"`
	Assets    []string `json:"archived_asset_ids"`
}

type localComfyAsset struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	JobID     string `json:"job_id"`
	Upstream  string `json:"upstream_asset_id"`
	MimeType  string `json:"mime_type"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

type localComfyPendingError struct{ jobID string }

func (e localComfyPendingError) Error() string {
	return "本地 ComfyUI 作业仍在运行或结果尚待取回"
}

func localComfyError(status int, reason, message string) *AppError {
	return &AppError{Status: status, Code: status, Reason: ErrorReason(reason), Message: message}
}

func (s *Service) localComfyRequest(ctx context.Context, method, path string, payload any, target any) error {
	body, err := s.localComfyBytes(ctx, method, path, payload, 15<<20)
	if err != nil {
		return err
	}
	var envelope struct {
		Code   int             `json:"code"`
		Data   json.RawMessage `json:"data"`
		Reason string          `json:"reason"`
	}
	if json.Unmarshal(body, &envelope) != nil || envelope.Code != 0 || len(envelope.Data) == 0 {
		return localComfyError(502, "adapter_invalid_response", "本地生成适配器返回无效数据")
	}
	if target != nil && json.Unmarshal(envelope.Data, target) != nil {
		return localComfyError(502, "adapter_invalid_response", "本地生成适配器返回无效数据")
	}
	return nil
}

func (s *Service) localComfyBytes(ctx context.Context, method, path string, payload any, limit int64) ([]byte, error) {
	var encoded []byte
	var err error
	if payload != nil {
		encoded, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, localComfyAdapterOrigin+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	transport := s.localComfyTransport
	if transport == nil {
		transport = localComfyDefaultTransport
	}
	client := &http.Client{Transport: transport, Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, localComfyError(503, "adapter_unavailable", "无法连接本地生成适配器，请稍后重试或取回原作业")
	}
	defer response.Body.Close()
	if response.ContentLength > limit {
		return nil, localComfyError(502, "adapter_response_too_large", "本地生成适配器响应超出限制")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, localComfyError(502, "adapter_invalid_response", "本地生成适配器响应读取失败")
	}
	if response.StatusCode != http.StatusOK {
		var envelope struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(body, &envelope)
		reason := envelope.Reason
		if !localComfyReasonPattern.MatchString(reason) {
			reason = "adapter_request_failed"
		}
		message := "本地生成请求失败（" + reason + "）"
		if reason == "generation_disabled" {
			message = "本地生成开关已关闭；已保留模型选择，本次没有提交 GPU 作业"
		}
		status := response.StatusCode
		if status < 400 {
			status = 502
		}
		return nil, localComfyError(status, reason, message)
	}
	return body, nil
}

func taskInputIsLocalComfy(raw string) bool {
	var input struct {
		LocalComfy *localComfyTaskInput `json:"localComfy"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && input.LocalComfy != nil
}

func localComfyTaskID(userID, operationID string) string {
	sum := sha256.Sum256([]byte("native-local-comfy\x00" + userID + "\x00" + operationID))
	return hex.EncodeToString(sum[:16])
}

func (s *Service) validateLocalComfyInput(userID string, req CreateTaskRequest, taskType string, input map[string]any) (*localComfyTaskInput, string, error) {
	value, ok := input["localComfy"].(map[string]any)
	if !ok || len(value) != 2 {
		return nil, "", localComfyError(400, "invalid_local_comfy_input", "本地配方参数只接受 recipeId 和 seed")
	}
	for key := range value {
		if key != "recipeId" && key != "seed" {
			return nil, "", localComfyError(400, "invalid_local_comfy_input", "本地配方参数无效")
		}
	}
	mode := stringValue(input["mode"])
	for key := range input {
		switch key {
		case "mode", "prompt", "config", "localComfy", "referenceImages", "referenceVideos", "referenceAudios", "mask", "metadata":
		case "nodeId":
			if req.creationPrepare == nil {
				return nil, "", localComfyError(400, "invalid_local_comfy_input", "节点绑定仅由已批准的创作运行使用")
			}
		default:
			return nil, "", localComfyError(400, "invalid_local_comfy_input", "本地任务包含未支持的字段")
		}
	}
	if (mode != "image" && mode != "video") || taskType != "canvas_"+mode {
		return nil, "", localComfyError(400, "recipe_mode_mismatch", "本地配方只支持匹配的图像或视频任务")
	}
	recipeID, isString := value["recipeId"].(string)
	seed, isNumber := value["seed"].(float64)
	if !isString || !localComfyRecipePattern.MatchString(recipeID) || !isNumber || math.IsNaN(seed) || math.IsInf(seed, 0) || seed < 0 || seed > math.MaxUint32 || math.Trunc(seed) != seed {
		return nil, "", localComfyError(400, "invalid_local_comfy_input", "请选择有效配方并填写 0..4294967295 的整数种子")
	}
	if req.LogicalModelID != "" || req.Model != localComfyModelPrefix+recipeID || (req.Provider != "" && req.Provider != "local-comfy") {
		return nil, "", InvalidModelSelection("本地任务的模型标识必须与已选配方一致")
	}
	if config, exists := input["config"]; exists && config != nil {
		if values, ok := config.(map[string]any); !ok || len(values) != 0 {
			return nil, "", localComfyError(400, "local_comfy_cloud_config_rejected", "本地任务不接受云渠道 URL、凭据或协议配置")
		}
	}
	metadata, _ := input["metadata"].(map[string]any)
	operationID, ok := metadata["clientOperationId"].(string)
	if !ok || strings.TrimSpace(operationID) == "" || len(operationID) > 200 || strings.ContainsAny(operationID, "\x00\r\n") {
		return nil, "", localComfyError(400, "client_operation_id_required", "本地任务缺少稳定的请求标识，请刷新后重试")
	}
	if inputPrompt, ok := input["prompt"].(string); ok && strings.TrimSpace(inputPrompt) != strings.TrimSpace(req.Prompt) {
		return nil, "", localComfyError(400, "prompt_mismatch", "任务正文与生成正文必须一致")
	}
	if containsInlineMediaDataURL(input) {
		return nil, "", BadAuthRequest("请先把参考图上传到原生资源库")
	}
	if utf8.RuneCountInString(req.Prompt) > 30000 {
		return nil, "", localComfyError(400, "prompt_too_long", "本地生成正文不能超过 30000 字符")
	}
	var parsed canvasGenerationInput
	raw, _ := json.Marshal(input)
	if json.Unmarshal(raw, &parsed) != nil || len(parsed.ReferenceVideos) != 0 || len(parsed.ReferenceAudios) != 0 || parsed.Mask != nil {
		return nil, "", localComfyError(400, "local_comfy_reference_not_supported", "已登记的本地配方只接受图片参考资源")
	}
	for _, reference := range parsed.ReferenceImages {
		if _, err := s.localComfyReference(userID, reference); err != nil {
			return nil, "", err
		}
	}
	return &localComfyTaskInput{RecipeID: recipeID, Seed: uint32(seed)}, operationID, nil
}

func (s *Service) localComfyReference(userID string, media providerMedia) (*model.Resource, error) {
	if media.URL != "" || media.DataURL != "" || (media.StorageKey != "" && !strings.HasPrefix(media.StorageKey, "resource:")) {
		return nil, localComfyError(400, "local_comfy_reference_not_owned", "本地参考图必须是当前用户已上传的原生资源")
	}
	id := strings.TrimPrefix(media.StorageKey, "resource:")
	if id == "" {
		id = media.ID
	}
	if id == "" {
		return nil, localComfyError(400, "local_comfy_reference_not_owned", "本地参考图缺少原生资源 ID")
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil || resource == nil || resource.Provider != "local" || resource.Status != model.ResourceStatusReady || resource.Kind != "image" {
		return nil, localComfyError(400, "local_comfy_reference_not_owned", "参考图不存在、尚未上传完成或不属于当前用户")
	}
	return resource, nil
}

func (s *Service) localComfyAdmission(ctx context.Context, userID string, input canvasGenerationInput) error {
	var config struct {
		Enabled bool `json:"generation_enabled"`
	}
	if err := s.localComfyRequest(ctx, http.MethodGet, "/config", nil, &config); err != nil {
		return err
	}
	if !config.Enabled {
		return localComfyError(403, "generation_disabled", "本地生成开关已关闭；已保留模型选择，本次没有提交 GPU 作业")
	}
	var recipes []localComfyRecipe
	if err := s.localComfyRequest(ctx, http.MethodGet, "/recipes", nil, &recipes); err != nil {
		return err
	}
	for _, recipe := range recipes {
		if recipe.ID != input.LocalComfy.RecipeID {
			continue
		}
		mode := ""
		switch recipe.Mode {
		case "t2i", "i2i":
			mode = "image"
		case "i2v", "t2v":
			mode = "video"
		}
		if !recipe.Ready || mode != input.Mode {
			return localComfyError(400, "recipe_not_available", "已选配方不可用或与生成模式不符")
		}
		if len(input.ReferenceImages) != recipe.ReferenceSlots {
			return localComfyError(400, "reference_count_mismatch", fmt.Sprintf("该配方需要 %d 张实际参考图", recipe.ReferenceSlots))
		}
		for index, media := range input.ReferenceImages {
			resource, err := s.localComfyReference(userID, media)
			if err != nil {
				return err
			}
			if index < len(recipe.Constraints) {
				constraint := recipe.Constraints[index]
				if len(constraint.MimeTypes) > 0 && !containsString(constraint.MimeTypes, resource.MimeType) {
					return localComfyError(400, "reference_mime_not_supported", "首帧参考图格式不符合配方要求")
				}
				if constraint.Width > 0 && constraint.Height > 0 && (resource.Width < constraint.Width || resource.Height < constraint.Height || int64(resource.Width)*int64(constraint.Height) != int64(resource.Height)*int64(constraint.Width)) {
					return localComfyError(400, "reference_aspect_mismatch", "首帧参考图必须满足配方尺寸和宽高比")
				}
			}
		}
		return nil
	}
	return localComfyError(400, "recipe_not_available", "已选配方尚未登记")
}

func (s *Service) createLocalComfyTask(userID string, req CreateTaskRequest, taskType, prompt string, input map[string]any) (*model.Task, error) {
	s.localComfyMu.Lock()
	defer s.localComfyMu.Unlock()
	selection, operationID, err := s.validateLocalComfyInput(userID, req, taskType, input)
	if err != nil {
		return nil, err
	}
	input["prompt"] = prompt
	encoded, _ := json.Marshal(input)
	id := localComfyTaskID(userID, operationID)
	if existing, err := s.repo.TaskForUser(userID, id); err == nil && req.creationPrepare == nil {
		if existing.ProjectID != req.ProjectID || existing.Type != taskType || existing.Model != req.Model || existing.Prompt != prompt || !localComfyInputsEqual(existing.InputJSON, string(encoded)) {
			return nil, localComfyError(409, "client_operation_id_conflict", "请求标识已用于另一组参数，请显式创建新的生成请求")
		}
		return taskForOutput(*existing), nil
	} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, taskStorageError(err)
	}
	if err := s.ensureTaskProjectActive(userID, req.ProjectID); err != nil {
		return nil, err
	}
	if req.ProjectID != "" {
		if _, err := s.repo.CanvasProjectForUser(userID, req.ProjectID); err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
			if _, err := s.repo.ProjectForUser(userID, req.ProjectID); err != nil {
				return nil, localComfyError(400, "project_not_owned", "原生项目不存在或不属于当前用户")
			}
		}
	}
	if err := s.validateLocalComfyProjectMetadata(userID, input); err != nil {
		return nil, err
	}
	if err := s.validateLocalComfyRedo(userID, taskType, req.Model, input); err != nil {
		return nil, err
	}
	var parsed canvasGenerationInput
	_ = json.Unmarshal(encoded, &parsed)
	parsed.LocalComfy = selection
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.localComfyAdmission(ctx, userID, parsed); err != nil {
		return nil, err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	task := model.Task{ID: id, UserID: userID, TraceID: req.TraceID, RequestID: req.RequestID, ProjectID: req.ProjectID, Type: taskType, Status: model.TaskStatusQueued, Stage: "等待本地配方调度", Progress: 0, Prompt: prompt, Operation: req.Operation, Provider: "local-comfy", Model: req.Model, InputJSON: string(encoded)}
	if req.creationPrepare != nil {
		return &task, nil
	}
	if err := s.createTaskWithinStorageQuota(&task, policy); err != nil {
		// Database uniqueness is the cross-process fence; replay the committed task.
		if existing, lookupErr := s.repo.TaskForUser(userID, id); lookupErr == nil && localComfyInputsEqual(existing.InputJSON, task.InputJSON) && existing.ProjectID == task.ProjectID && existing.Model == task.Model && existing.Type == task.Type {
			return taskForOutput(*existing), nil
		}
		return nil, err
	}
	_ = s.log(userID, id, "info", "原生任务已登记，等待本地 ComfyUI 配方调度", "")
	return taskForOutput(task), nil
}

func localComfyInputsEqual(left, right string) bool {
	left, right = publicTaskInputJSON(left), publicTaskInputJSON(right)
	var a, b map[string]any
	if json.Unmarshal([]byte(left), &a) != nil || json.Unmarshal([]byte(right), &b) != nil {
		return false
	}
	for _, input := range []map[string]any{a, b} {
		if selection, ok := input["localComfy"].(map[string]any); ok {
			delete(selection, "_retryJobId")
			delete(selection, "_retryKey")
		}
	}
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func (s *Service) ensureLocalComfyObjects(ctx context.Context, userID, canvasID, taskID string, references []providerMedia) (string, string, []string, error) {
	s.localComfyMu.Lock()
	defer s.localComfyMu.Unlock()
	identity := "native:" + localComfyTaskID(userID, canvasID)
	var projects []localComfyProject
	if err := s.localComfyRequest(ctx, http.MethodGet, "/projects", nil, &projects); err != nil {
		return "", "", nil, err
	}
	var project localComfyProject
	for _, item := range projects {
		if item.Upstream == identity {
			project = item
			break
		}
	}
	if project.ID == "" {
		if err := s.localComfyRequest(ctx, http.MethodPost, "/projects", map[string]any{"name": "Native BeefTV", "upstream_project_id": identity, "canvas_project_id": canvasID}, &project); err != nil {
			return "", "", nil, err
		}
	}
	if !localComfyIDPattern.MatchString(project.ID) {
		return "", "", nil, localComfyError(502, "adapter_invalid_response", "本地项目关联无效")
	}
	var shots []localComfyShot
	if err := s.localComfyRequest(ctx, http.MethodGet, "/shots?project_id="+project.ID, nil, &shots); err != nil {
		return "", "", nil, err
	}
	for _, shot := range shots {
		if shot.Upstream == taskID && localComfyIDPattern.MatchString(shot.ID) {
			return project.ID, shot.ID, nil, nil
		}
	}
	var existingAssets []localComfyAsset
	if err := s.localComfyRequest(ctx, http.MethodGet, "/assets?project_id="+project.ID, nil, &existingAssets); err != nil {
		return "", "", nil, err
	}
	assetIDs := make([]string, 0, len(references))
	for _, reference := range references {
		resource, err := s.localComfyReference(userID, reference)
		if err != nil {
			return "", "", nil, err
		}
		var asset localComfyAsset
		for _, existing := range existingAssets {
			if existing.Upstream == resource.ID && localComfyIDPattern.MatchString(existing.ID) {
				asset = existing
				break
			}
		}
		if asset.ID == "" {
			stream, err := s.OpenResourceRange(userID, resource.ID, "")
			if err != nil {
				return "", "", nil, err
			}
			data, readErr := io.ReadAll(io.LimitReader(stream.Body, (10<<20)+1))
			_ = stream.Body.Close()
			if readErr != nil || len(data) > 10<<20 {
				return "", "", nil, localComfyError(400, "reference_too_large", "本地参考图读取失败或超过 10MiB")
			}
			if err := s.localComfyRequest(ctx, http.MethodPost, "/assets", map[string]any{"project_id": project.ID, "name": resource.ID, "kind": "reference", "mime_type": resource.MimeType, "data_base64": base64.StdEncoding.EncodeToString(data), "upstream_asset_id": resource.ID}, &asset); err != nil {
				return "", "", nil, err
			}
		}
		if !localComfyIDPattern.MatchString(asset.ID) {
			return "", "", nil, localComfyError(502, "adapter_invalid_response", "本地参考图关联无效")
		}
		assetIDs = append(assetIDs, asset.ID)
	}
	var shot localComfyShot
	if err := s.localComfyRequest(ctx, http.MethodPost, "/shots", map[string]any{"project_id": project.ID, "name": "Native task " + taskID, "upstream_shot_id": taskID, "reference_asset_ids": assetIDs}, &shot); err != nil {
		return "", "", nil, err
	}
	if !localComfyIDPattern.MatchString(shot.ID) {
		return "", "", nil, localComfyError(502, "adapter_invalid_response", "本地镜头关联无效")
	}
	return project.ID, shot.ID, assetIDs, nil
}

func (s *Service) runLocalComfyTask(ctx context.Context, userID, canvasID, taskType string, input canvasGenerationInput) (map[string]interface{}, error) {
	if input.LocalComfy == nil || !localComfyRecipePattern.MatchString(input.LocalComfy.RecipeID) || taskType != "canvas_"+input.Mode {
		return nil, localComfyError(400, "invalid_local_comfy_input", "本地配方任务参数无效")
	}
	taskID := taskExecutionID(ctx)
	if taskID == "" {
		return nil, localComfyError(400, "native_task_required", "本地生成必须通过已持久化的原生任务提交")
	}
	jobID := resumedProviderRequestID(ctx)
	var job localComfyJob
	if jobID != "" {
		if !localComfyIDPattern.MatchString(jobID) {
			return nil, localComfyError(502, "adapter_invalid_response", "已保存的本地作业 ID 无效")
		}
		if err := s.localComfyRequest(ctx, http.MethodGet, "/jobs/"+jobID, nil, &job); err != nil {
			return nil, localComfyPendingError{jobID}
		}
	} else {
		committed, lookupErr := s.findCommittedLocalComfyJob(ctx, &model.Task{ID: taskID, UserID: userID, ProjectID: canvasID}, input.LocalComfy)
		if lookupErr == nil {
			job = *committed
		} else {
			var appErr *AppError
			if !errors.As(lookupErr, &appErr) || appErr.Reason != "submission_unknown" {
				return nil, lookupErr
			}
			if err := s.localComfyAdmission(ctx, userID, input); err != nil {
				return nil, err
			}
		}
	}
	if job.ID == "" {
		projectID, shotID, refs, err := s.ensureLocalComfyObjects(ctx, userID, canvasID, taskID, input.ReferenceImages)
		if err != nil {
			return nil, err
		}
		var jobs []localComfyJob
		if err := s.localComfyRequest(ctx, http.MethodGet, "/jobs?project_id="+projectID+"&shot_id="+shotID, nil, &jobs); err != nil {
			return nil, err
		}
		key := "native:" + taskID
		if input.LocalComfy.RetryKey != "" {
			key = input.LocalComfy.RetryKey
		}
		for _, existing := range jobs {
			if existing.Key == key {
				job = existing
				break
			}
		}
		if job.ID == "" {
			if err := s.localComfyAdmission(ctx, userID, input); err != nil {
				return nil, err
			}
			path := "/jobs"
			payload := map[string]any{"project_id": projectID, "shot_id": shotID, "recipe_id": input.LocalComfy.RecipeID, "prompt": input.Prompt, "seed": input.LocalComfy.Seed, "request_key": key}
			// Reused shots retain their authoritative adapter references; new shots
			// provide the newly copied resource IDs explicitly.
			if refs != nil {
				payload["reference_asset_ids"] = refs
			}
			if input.LocalComfy.RetryJobID != "" {
				if !localComfyIDPattern.MatchString(input.LocalComfy.RetryJobID) {
					return nil, localComfyError(400, "retry_not_safe", "原作业 ID 无效，拒绝重新提交")
				}
				path = "/jobs/" + input.LocalComfy.RetryJobID + "/retry"
				payload = map[string]any{"request_key": key}
			}
			if err := s.localComfyRequest(ctx, http.MethodPost, path, payload, &job); err != nil {
				var appErr *AppError
				if errors.As(err, &appErr) && appErr.Status < 500 {
					return nil, err
				}
				// The adapter commits request_key before /prompt. A lost reply must
				// never be retried with a fresh key or a fresh native task automatically.
				return nil, providerSubmissionUnknownError{Cause: err}
			}
		}
	}
	if !localComfyIDPattern.MatchString(job.ID) || job.RecipeID != input.LocalComfy.RecipeID {
		return nil, providerSubmissionUnknownError{Cause: errors.New("本地作业关联数据无效，请人工核对原作业")}
	}
	if jobID != "" && job.ID != jobID {
		return nil, localComfyError(502, "adapter_job_binding_mismatch", "本地适配器返回了另一作业，已停止取回")
	}
	if err := s.validateLocalComfyJobBinding(ctx, userID, canvasID, taskID, input.LocalComfy, job); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateTaskProviderState(taskID, job.ID, job.Status, nil); err != nil {
		return nil, providerSubmissionUnknownError{Cause: err}
	}
	if job.Status == "submitting" || job.Status == "submission_unknown" {
		return nil, providerSubmissionUnknownError{Cause: errors.New("本地作业提交结果未知，需要人工核对原作业")}
	}
	if job.Status == "submitted" || job.Status == "running" {
		previous := job
		if err := s.localComfyRequest(ctx, http.MethodPost, "/jobs/"+job.ID+"/poll", map[string]any{}, &job); err != nil {
			return nil, localComfyPendingError{job.ID}
		}
		if !sameLocalComfyJobIdentity(previous, job) {
			return nil, localComfyError(502, "adapter_job_binding_mismatch", "本地轮询返回了另一作业，已停止取回")
		}
		_ = s.repo.UpdateTaskProviderState(taskID, job.ID, job.Status, nil)
	}
	if job.Status == "failed" {
		return nil, localComfyError(502, "comfy_execution_failed", "本地 ComfyUI 作业明确失败；可查看原作业并显式重做")
	}
	if job.Status != "completed" {
		return nil, localComfyPendingError{job.ID}
	}
	previous := job
	if err := s.localComfyRequest(ctx, http.MethodPost, "/jobs/"+job.ID+"/archive", map[string]any{}, &job); err != nil {
		return nil, localComfyPendingError{job.ID}
	}
	if !sameLocalComfyJobIdentity(previous, job) || job.Status != "completed" {
		return nil, localComfyError(502, "adapter_job_binding_mismatch", "本地归档返回了另一作业，已停止取回")
	}
	return s.materializeLocalComfyResult(ctx, userID, input.Mode, job)
}

func (s *Service) materializeLocalComfyResult(ctx context.Context, userID, mode string, job localComfyJob) (map[string]interface{}, error) {
	if len(job.Assets) == 0 || len(job.Assets) > 16 {
		return nil, localComfyError(502, "comfy_completed_without_results", "本地作业完成但没有可归档的结果")
	}
	result := map[string]interface{}{"mode": mode, "localComfy": map[string]any{"recipeId": job.RecipeID, "jobId": job.ID, "promptId": job.PromptID, "status": job.Status}}
	images := make([]map[string]interface{}, 0)
	for _, assetID := range job.Assets {
		if !localComfyIDPattern.MatchString(assetID) {
			return nil, localComfyError(502, "adapter_invalid_response", "本地归档资产 ID 无效")
		}
		var asset localComfyAsset
		if err := s.localComfyRequest(ctx, http.MethodGet, "/assets/"+assetID, nil, &asset); err != nil {
			return nil, localComfyPendingError{job.ID}
		}
		if asset.ID != assetID || asset.JobID != job.ID || asset.ProjectID != job.ProjectID || asset.Size <= 0 || asset.Size > 256<<20 || (mode == "image" && !strings.HasPrefix(asset.MimeType, "image/")) || (mode == "video" && !strings.HasPrefix(asset.MimeType, "video/")) {
			return nil, localComfyError(502, "adapter_invalid_response", "本地结果资产与作业或生成能力不匹配")
		}
		if !containsString([]string{"image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"}, asset.MimeType) {
			return nil, localComfyError(502, "adapter_invalid_response", "本地结果媒体格式不支持")
		}
		policy, err := s.RuntimePolicy()
		if err != nil {
			return nil, err
		}
		if asset.Size > megabytes(policy.Resource.GeneratedFileMB) {
			return nil, QuotaExceeded("本地生成结果超过原生资源单文件限制")
		}
		key := "local-comfy:" + job.ID + ":" + assetID
		resource, err := s.resourceForUploadKey(userID, &key)
		if err != nil {
			return nil, err
		}
		if resource == nil {
			data, err := s.localComfyBytes(ctx, http.MethodGet, "/assets/"+assetID+"/content", nil, 256<<20)
			if err != nil {
				return nil, localComfyPendingError{job.ID}
			}
			sum := sha256.Sum256(data)
			if int64(len(data)) != asset.Size || hex.EncodeToString(sum[:]) != asset.SHA256 {
				return nil, localComfyError(502, "archive_integrity_failed", "本地结果归档校验失败")
			}
			if mode == "image" && (asset.Width <= 0 || asset.Height <= 0) {
				asset.Width, asset.Height = imageDimensions(data)
			}
			durationMs := int64(0)
			if mode == "video" {
				width, height, duration := probeGeneratedVideoMedia(data)
				if asset.Width <= 0 {
					asset.Width = width
				}
				if asset.Height <= 0 {
					asset.Height = height
				}
				durationMs = duration
			}
			quotaDay, err := s.reserveGeneratedResourceQuota(userID, asset.Size)
			if err != nil {
				return nil, err
			}
			resource, _, err = s.storeResource(userID, mode, "generated."+extensionFromMimeType(asset.MimeType), asset.MimeType, asset.Size, asset.Width, asset.Height, durationMs, bytes.NewReader(data), &key, true)
			if err != nil {
				s.releaseUserUploadQuota(userID, quotaDay, asset.Size)
				return nil, localComfyPendingError{job.ID}
			}
			s.commitUserUploadQuota(userID, asset.Size)
		}
		if resource.Status != model.ResourceStatusReady {
			return nil, localComfyPendingError{job.ID}
		}
		media := map[string]interface{}{"resourceId": resource.ID, "storageKey": "resource:" + resource.ID, "url": resourceFileURL(resource.ID), "mimeType": resource.MimeType, "bytes": resource.Size, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}
		if mode == "image" {
			images = append(images, media)
		} else if result["video"] == nil {
			result["video"] = media
		}
	}
	if mode == "image" {
		result["images"] = images
	}
	return result, nil
}

func (s *Service) prepareLocalComfyRetry(task *model.Task, input map[string]any) error {
	var parsed canvasGenerationInput
	raw, _ := json.Marshal(input)
	if json.Unmarshal(raw, &parsed) != nil || parsed.LocalComfy == nil {
		return localComfyError(400, "retry_not_safe", "本地任务参数已失效")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if task.ProviderRequestID != "" {
		if !localComfyIDPattern.MatchString(task.ProviderRequestID) {
			return localComfyError(400, "retry_not_safe", "原作业 ID 无效")
		}
		var job localComfyJob
		if err := s.localComfyRequest(ctx, http.MethodGet, "/jobs/"+task.ProviderRequestID, nil, &job); err != nil {
			return err
		}
		if job.ID != task.ProviderRequestID || job.RecipeID != parsed.LocalComfy.RecipeID || job.Status != "failed" {
			return localComfyError(409, "retry_not_safe", "原作业尚未明确失败；已完成结果请取回，运行或未知作业不能重做")
		}
		if err := s.validateLocalComfyJobBinding(ctx, task.UserID, task.ProjectID, task.ID, parsed.LocalComfy, job); err != nil {
			return err
		}
		parsed.LocalComfy.RetryJobID = job.ID
		parsed.LocalComfy.RetryKey = "native:" + task.ID + ":retry:" + newID()
	} else if task.Status == model.TaskStatusCancelled {
		return localComfyError(409, "retry_not_safe", "取消任务的上游状态尚未确认，请核对原作业后再创建新任务")
	}
	if err := s.localComfyAdmission(ctx, task.UserID, parsed); err != nil {
		return err
	}
	selection := map[string]any{"recipeId": parsed.LocalComfy.RecipeID, "seed": parsed.LocalComfy.Seed}
	if parsed.LocalComfy.RetryJobID != "" {
		selection["_retryJobId"], selection["_retryKey"] = parsed.LocalComfy.RetryJobID, parsed.LocalComfy.RetryKey
	}
	input["localComfy"] = selection
	encoded, _ := json.Marshal(input)
	task.InputJSON = string(encoded)
	return nil
}

func (s *Service) queryFailedLocalComfyTask(ctx context.Context, task *model.Task, claimUserID string) (*ProviderTaskQueryResult, error) {
	if task.Status != model.TaskStatusFailed || (task.Type != "canvas_image" && task.Type != "canvas_video") || (task.ProviderRequestID != "" && !localComfyIDPattern.MatchString(task.ProviderRequestID)) {
		return nil, localComfyError(400, "local_comfy_recovery_not_available", "只可取回带原作业 ID 的失败本地图像或视频任务")
	}
	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, claimUserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		if errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			return nil, localComfyError(409, "recovery_busy", "正在取回原本地作业，请稍后刷新")
		}
		return nil, err
	}
	task.LeaseOwner = owner
	defer s.repo.ReleaseTaskProviderRecovery(task.ID, owner)
	recoveryCtx, cancel := providerTaskRecoveryContext(ctx)
	defer cancel()
	if task.ProviderRequestID == "" {
		var input canvasGenerationInput
		if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.LocalComfy == nil {
			return nil, localComfyError(409, "submission_unknown", "原作业关联未知；本次没有重新提交")
		}
		job, err := s.findCommittedLocalComfyJob(recoveryCtx, task, input.LocalComfy)
		if err != nil {
			return nil, err
		}
		task.ProviderRequestID = job.ID
		if err := s.repo.UpdateTaskProviderState(task.ID, job.ID, job.Status, nil); err != nil {
			return nil, err
		}
	}
	result, _, err := s.processTask(recoveryCtx, *task)
	if err != nil {
		var pending localComfyPendingError
		if errors.As(err, &pending) {
			return &ProviderTaskQueryResult{Task: taskForOutput(*task), ProviderStatus: "pending", Recovered: false}, nil
		}
		return nil, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	task.Error, task.PollStage, task.NextPollAt = "", "completed", nil
	if err := s.saveTaskCompletionWithinStorageQuota(task, resultJSON, nil, false); err != nil {
		return nil, err
	}
	if err := s.RegisterTaskOutputFromTask(*task); err != nil {
		return nil, err
	}
	return &ProviderTaskQueryResult{Task: taskForOutput(*task), ProviderStatus: "completed", Recovered: true}, nil
}

func (s *Service) validateLocalComfyProjectMetadata(userID string, input map[string]any) error {
	metadata, _ := input["metadata"].(map[string]any)
	projectID := strings.TrimSpace(stringValue(metadata["domainProjectId"]))
	chapterID, shotID := strings.TrimSpace(stringValue(metadata["chapterId"])), strings.TrimSpace(stringValue(metadata["shotId"]))
	if projectID == "" {
		if chapterID != "" || shotID != "" {
			return localComfyError(400, "project_not_owned", "章节或镜头关联必须指定当前用户的原生项目")
		}
		return nil
	}
	project, err := s.repo.ProjectForUser(userID, projectID)
	if err != nil || project == nil || project.Status == model.ProjectStatusArchived {
		return localComfyError(400, "project_not_owned", "素材关联项目不存在、不属于当前用户或已归档")
	}
	if chapterID != "" {
		if _, err := s.repo.ProjectUnit(projectID, chapterID); err != nil {
			return localComfyError(400, "chapter_not_owned", "关联章节不属于当前项目")
		}
	}
	if shotID != "" {
		if _, err := s.repo.ShotForProject(projectID, shotID); err != nil {
			return localComfyError(400, "shot_not_owned", "关联镜头不属于当前项目")
		}
	}
	return nil
}

// A new native task can represent an explicitly requested new version. It
// must not use retryOf to bypass uncertain or still active parent submissions.
func (s *Service) validateLocalComfyRedo(userID, taskType, selectedModel string, input map[string]any) error {
	metadata, _ := input["metadata"].(map[string]any)
	parentID := strings.TrimSpace(stringValue(metadata["retryOf"]))
	if parentID == "" {
		return nil
	}
	parent, err := s.repo.TaskForUser(userID, parentID)
	if err != nil {
		return localComfyError(400, "retry_not_safe", "原生重做任务不存在或不属于当前用户")
	}
	var parentInput canvasGenerationInput
	if json.Unmarshal([]byte(parent.InputJSON), &parentInput) != nil || parentInput.LocalComfy == nil || parent.Type != taskType || parent.Model != selectedModel || parent.Model != localComfyModelPrefix+parentInput.LocalComfy.RecipeID {
		return localComfyError(400, "retry_not_safe", "重做必须使用原本地任务的类型和配方；更换配方请明确创建新任务")
	}
	if parent.ProviderCancelStatus == model.ProviderCancelStatusRequested || parent.ProviderCancelStatus == model.ProviderCancelStatusUncertain || parent.Stage == "submission_unknown" || parent.PollStage == "submission_unknown" || parent.PollStage == "submitting" {
		return localComfyError(409, "retry_not_safe", "原作业提交或取消状态尚未确认，请查询原作业，不要重新提交")
	}
	if parent.Status == model.TaskStatusSucceeded {
		return nil
	}
	if parent.Status != model.TaskStatusFailed || !localComfyIDPattern.MatchString(parent.ProviderRequestID) {
		return localComfyError(409, "retry_not_safe", "原作业尚未明确结束；请先取回或核对原作业")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var job localComfyJob
	if err := s.localComfyRequest(ctx, http.MethodGet, "/jobs/"+parent.ProviderRequestID, nil, &job); err != nil {
		return err
	}
	if job.ID != parent.ProviderRequestID || job.Status != "failed" {
		return localComfyError(409, "retry_not_safe", "原 ComfyUI 作业尚未明确失败，已拒绝重复提交")
	}
	return s.validateLocalComfyJobBinding(ctx, userID, parent.ProjectID, parent.ID, parentInput.LocalComfy, job)
}

func localComfyRequestKey(taskID string, input *localComfyTaskInput) string {
	if input.RetryKey != "" {
		return input.RetryKey
	}
	return "native:" + taskID
}

func sameLocalComfyJobIdentity(left, right localComfyJob) bool {
	return left.ID == right.ID && left.ProjectID == right.ProjectID && left.ShotID == right.ShotID && left.RecipeID == right.RecipeID && left.Key == right.Key
}

func (s *Service) validateLocalComfyJobBinding(ctx context.Context, userID, canvasID, taskID string, input *localComfyTaskInput, job localComfyJob) error {
	if !localComfyIDPattern.MatchString(job.ID) || !localComfyIDPattern.MatchString(job.ProjectID) || !localComfyIDPattern.MatchString(job.ShotID) || job.RecipeID != input.RecipeID || job.Key != localComfyRequestKey(taskID, input) {
		return localComfyError(502, "adapter_job_binding_mismatch", "本地作业未匹配原生任务关联，已停止取回")
	}
	var project localComfyProject
	if err := s.localComfyRequest(ctx, http.MethodGet, "/projects/"+job.ProjectID, nil, &project); err != nil {
		return err
	}
	var shot localComfyShot
	if err := s.localComfyRequest(ctx, http.MethodGet, "/shots/"+job.ShotID, nil, &shot); err != nil {
		return err
	}
	if project.ID != job.ProjectID || project.Upstream != "native:"+localComfyTaskID(userID, canvasID) || project.CanvasID != canvasID || shot.ID != job.ShotID || shot.ProjectID != job.ProjectID || shot.Upstream != taskID {
		return localComfyError(502, "adapter_job_binding_mismatch", "本地作业属于另一项目或镜头，已停止取回")
	}
	return nil
}

// Recovery is deliberately GET-only until an already committed job is found.
// Missing objects are uncertain evidence, never permission to recreate them.
func (s *Service) findCommittedLocalComfyJob(ctx context.Context, task *model.Task, input *localComfyTaskInput) (*localComfyJob, error) {
	var projects []localComfyProject
	if err := s.localComfyRequest(ctx, http.MethodGet, "/projects", nil, &projects); err != nil {
		return nil, err
	}
	for _, project := range projects {
		if project.Upstream != "native:"+localComfyTaskID(task.UserID, task.ProjectID) || project.CanvasID != task.ProjectID || !localComfyIDPattern.MatchString(project.ID) {
			continue
		}
		var shots []localComfyShot
		if err := s.localComfyRequest(ctx, http.MethodGet, "/shots?project_id="+project.ID, nil, &shots); err != nil {
			return nil, err
		}
		for _, shot := range shots {
			if shot.Upstream != task.ID || !localComfyIDPattern.MatchString(shot.ID) {
				continue
			}
			var jobs []localComfyJob
			if err := s.localComfyRequest(ctx, http.MethodGet, "/jobs?project_id="+project.ID+"&shot_id="+shot.ID, nil, &jobs); err != nil {
				return nil, err
			}
			for _, job := range jobs {
				if job.Key != localComfyRequestKey(task.ID, input) {
					continue
				}
				if err := s.validateLocalComfyJobBinding(ctx, task.UserID, task.ProjectID, task.ID, input, job); err != nil {
					return nil, err
				}
				return &job, nil
			}
		}
	}
	return nil, localComfyError(409, "submission_unknown", "未找到已提交的原作业；本次只查询，没有重新提交")
}

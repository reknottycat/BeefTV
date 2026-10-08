package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/localcomfy"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// ConfigureLocalComfy is called by the composition root before workers start.
func (s *Service) ConfigureLocalComfy(endpoint, token string) error {
	if strings.TrimSpace(endpoint) == "" {
		s.localComfy = nil
		return nil
	}
	client, err := localcomfy.New(endpoint, token)
	if err != nil {
		return err
	}
	s.localComfy = client
	return nil
}
func (s *Service) LocalComfyConfig(ctx context.Context) (localcomfy.Config, error) {
	config, err := s.localComfy.Config(ctx)
	return config, mapLocalComfyError(err)
}
func (s *Service) LocalComfyRecipes(ctx context.Context) ([]localcomfy.Recipe, error) {
	recipes, err := s.localComfy.Recipes(ctx)
	return recipes, mapLocalComfyError(err)
}
func mapLocalComfyError(err error) error {
	var unknown localcomfy.UnknownError
	if errors.As(err, &unknown) {
		return generation.SubmissionUnknownError{Cause: err}
	}
	var api *localcomfy.Error
	if errors.As(err, &api) {
		return &AppError{Status: api.Status, Code: api.Status, Reason: ErrorReason(api.Reason), Message: api.Message}
	}
	return err
}
func taskInputIsLocalComfy(raw string) bool {
	var input struct {
		LocalComfy *localcomfy.Selection `json:"localComfy"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && input.LocalComfy != nil
}
func localComfyInput(input map[string]any) bool { _, present := input["localComfy"]; return present }

type localComfyResources struct{ s *Service }

func (a localComfyResources) Describe(owner, id string) (localcomfy.Resource, error) {
	resource, err := a.s.repo.ResourceForUser(owner, id)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" || resource.Provider != "local" {
		return localcomfy.Resource{}, BadAuthRequest("参考图必须是当前用户已就绪的原生图片资源")
	}
	return localcomfy.Resource{ID: resource.ID, MimeType: resource.MimeType, Size: resource.Size, Width: resource.Width, Height: resource.Height}, nil
}
func (a localComfyResources) Read(owner, id string, limit int64) ([]byte, error) {
	_, body, err := a.s.OpenResource(owner, id)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, BadAuthRequest("本地参考资源超过大小限制")
	}
	return data, nil
}
func (a localComfyResources) Import(ctx context.Context, owner, identity, mode string, asset localcomfy.Asset, output localcomfy.Output, load func() ([]byte, error)) (localcomfy.Media, error) {
	limit, err := a.s.generatedMediaMaxBytes()
	if err != nil {
		return localcomfy.Media{}, err
	}
	if asset.Size > limit {
		return localcomfy.Media{}, QuotaExceeded("本地生成结果超过原生资源单文件限制")
	}
	resource, err := a.s.resourceDomain().RecoverOwned(owner, identity, func() (localasset.RecoveredArtifact, error) {
		if err := ctx.Err(); err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		data, err := load()
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		width, height, duration := asset.Width, asset.Height, int64(0)
		if mode == "image" {
			width, height = imageDimensions(data)
		} else {
			width, height, duration = probeGeneratedVideoMedia(data)
		}
		if err := output.CheckMedia(mode, width, height, duration); err != nil {
			return localasset.RecoveredArtifact{}, mapLocalComfyError(err)
		}
		return localasset.RecoveredArtifact{Kind: mode, FileName: "generated." + extensionFromMimeType(asset.MimeType), MimeType: asset.MimeType, Size: asset.Size, Width: width, Height: height, DurationMs: duration, Body: bytes.NewReader(data)}, nil
	})
	if err != nil {
		return localcomfy.Media{}, err
	}
	if resource.Status != model.ResourceStatusReady || resource.UserID != owner || resource.Size != asset.Size || resource.MimeType != asset.MimeType {
		return localcomfy.Media{}, BadAuthRequest("已归档原生资源与作业结果不一致")
	}
	return localcomfy.Media{ResourceID: resource.ID, StorageKey: "resource:" + resource.ID, URL: resourceFileURL(resource.ID), MimeType: resource.MimeType, Bytes: resource.Size, Width: resource.Width, Height: resource.Height, DurationMs: resource.DurationMs}, nil
}

type localComfyLedger struct {
	s    *Service
	task model.Task
}

func (a localComfyLedger) Save(ctx context.Context, jobID, status string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return a.s.repo.SaveLocalComfyState(a.task.ID, a.task.UserID, a.task.LeaseOwner, jobID, status)
}

type appLocalComfyPort struct{ s *Service }

func (a appLocalComfyPort) Execute(ctx context.Context, input generation.Input) (map[string]any, error) {
	meta, _ := generation.CallMetaFromContext(ctx)
	claimed, ok := ctx.Value(imageTaskContext{}).(model.Task)
	if !ok || claimed.ID != meta.TaskID || claimed.UserID != meta.UserID {
		return nil, repository.ErrTaskStateConflict
	}
	task, err := a.s.repo.TaskForUser(meta.UserID, meta.TaskID)
	if err != nil {
		return nil, err
	}
	if task.LeaseOwner != claimed.LeaseOwner || task.Status != claimed.Status || (task.LeaseOwner != "" && (task.LeaseExpiresAt == nil || !task.LeaseExpiresAt.After(time.Now()))) {
		return nil, repository.ErrTaskStateConflict
	}
	if task.ProjectID != meta.ProjectID || task.Type != "canvas_"+input.Mode || input.LocalComfy == nil || task.Model != localcomfy.ModelPrefix+input.LocalComfy.RecipeID {
		return nil, BadAuthRequest("本地执行任务身份不一致")
	}
	refs, err := a.s.localComfyReferences(task.UserID, input)
	if err != nil {
		return nil, err
	}
	request := localcomfy.Request{OwnerID: task.UserID, ProjectID: task.ProjectID, TaskID: task.ID, Mode: input.Mode, Prompt: input.Prompt, Selection: *input.LocalComfy, References: refs, JobID: task.ProviderRequestID, ResumeOnly: task.PollStage == "submitting" || task.PollStage == "submission_unknown" || task.Stage == "submission_unknown" || task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled}
	executor := localcomfy.Executor{Client: a.s.localComfy, Resources: localComfyResources{a.s}, Ledger: localComfyLedger{a.s, claimed}}
	result, err := executor.Execute(ctx, request)
	if err != nil {
		return nil, mapLocalComfyError(err)
	}
	// Existing media ingestion accepts JSON objects; keep domain DTOs internal.
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var output map[string]any
	err = json.Unmarshal(encoded, &output)
	return output, err
}

func (s *Service) localComfyReferences(owner string, input generation.Input) ([]localcomfy.Resource, error) {
	if len(input.ReferenceAudios) > 0 || len(input.ReferenceVideos) > 0 || input.Mask != nil {
		return nil, BadAuthRequest("本地配方只接受原生图片参考")
	}
	refs := make([]localcomfy.Resource, 0, len(input.ReferenceImages))
	for _, media := range input.ReferenceImages {
		if media.URL != "" || media.DataURL != "" || (media.StorageKey != "" && !strings.HasPrefix(media.StorageKey, "resource:")) {
			return nil, BadAuthRequest("本地参考图不接受外部URL或内嵌数据")
		}
		id := strings.TrimPrefix(media.StorageKey, "resource:")
		if id == "" {
			id = media.ID
		}
		if id == "" {
			return nil, BadAuthRequest("本地参考资源ID不能为空")
		}
		ref, err := (localComfyResources{s}).Describe(owner, id)
		if err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	return refs, nil
}

func (s *Service) queryLocalComfyTask(ctx context.Context, task *model.Task) (*ProviderTaskQueryResult, error) {
	if task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return nil, BadAuthRequest("只能取回已失败或停止跟踪的本地任务")
	}
	owner := "manual-recovery:" + newID()
	if err := s.repo.ClaimLocalComfyRecovery(task.ID, task.UserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		if errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			return nil, &AppError{Status: 409, Code: 409, Reason: "recovery_busy", Message: "原作业正在取回，请稍后刷新"}
		}
		return nil, err
	}
	task.LeaseOwner = owner
	defer s.repo.ReleaseTaskProviderRecovery(task.ID, owner)
	recoveryCtx, cancel := providerTaskRecoveryContext(ctx)
	defer cancel()
	result, _, err := s.processTask(recoveryCtx, *task)
	if err != nil {
		var pending localcomfy.PendingError
		if errors.As(err, &pending) {
			latest, lookupErr := s.repo.TaskForUser(task.UserID, task.ID)
			if lookupErr != nil {
				return nil, lookupErr
			}
			return &ProviderTaskQueryResult{Task: taskForOutput(*latest), ProviderStatus: "pending"}, nil
		}
		return nil, err
	}
	latest, err := s.repo.TaskForUser(task.UserID, task.ID)
	if err != nil {
		return nil, err
	}
	if latest.LeaseOwner != owner || latest.Status != task.Status {
		return nil, repository.ErrTaskStateConflict
	}
	task = latest
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	task.Error = ""
	task.PollStage = "completed"
	task.NextPollAt = nil
	task.ProviderCancelStatus = ""
	task.ProviderCancelError = ""
	if err := s.saveTaskCompletionWithinStorageQuota(task, data, nil, false); err != nil {
		return nil, err
	}
	if err := s.RegisterTaskOutputFromTask(*task); err != nil {
		return nil, err
	}
	return &ProviderTaskQueryResult{Task: s.attachRecoveredProviderTask(task), ProviderStatus: "completed", Recovered: true}, nil
}

func (s *Service) deferLocalComfyTask(task *model.Task, err error) (bool, error) {
	var pending localcomfy.PendingError
	if !errors.As(err, &pending) || !taskInputIsLocalComfy(task.InputJSON) || task.ProviderRequestID == "" {
		return false, nil
	}
	if task.StartedAt != nil && time.Since(*task.StartedAt) > 4*time.Hour {
		return false, nil
	}
	err = s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "本地作业仍在运行或结果待取回", 15*time.Second, task.FailureDiagnostics)
	return true, err
}

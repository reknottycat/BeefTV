package app

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/localcomfy"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) selectLocalComfyTask(owner string, req localtask.SelectRequest) (localtask.SelectResult, error) {
	input := req.Input
	value, ok := input["localComfy"].(map[string]any)
	if !ok {
		return localtask.SelectResult{}, BadAuthRequest("本地配方参数无效")
	}
	for key := range value {
		switch key {
		case "recipeId", "seed", "recipeVersion", "recipeSpec":
		default:
			return localtask.SelectResult{}, BadAuthRequest("本地配方包含未支持的参数")
		}
	}
	if _, exists := value["seed"]; !exists {
		return localtask.SelectResult{}, BadAuthRequest("本地配方必须指定整数种子")
	}
	for key := range input {
		switch key {
		case "mode", "prompt", "config", "localComfy", "referenceImages", "referenceVideos", "referenceAudios", "mask", "metadata", "nodeId":
		default:
			return localtask.SelectResult{}, BadAuthRequest("本地任务包含未支持的字段")
		}
	}
	if config := input["config"]; config != nil {
		values, ok := config.(map[string]any)
		if !ok || len(values) != 0 {
			return localtask.SelectResult{}, BadAuthRequest("本地任务不接受云渠道URL、凭据或协议配置")
		}
	}
	var parsed generation.Input
	data, err := json.Marshal(input)
	if err != nil || json.Unmarshal(data, &parsed) != nil || parsed.LocalComfy == nil {
		return localtask.SelectResult{}, BadAuthRequest("本地配方参数无效，种子必须是0..4294967295的整数")
	}
	if (parsed.Mode != "image" && parsed.Mode != "video") || req.Type != "canvas_"+parsed.Mode || req.LogicalModelID != "" || req.Model != localcomfy.ModelPrefix+parsed.LocalComfy.RecipeID || req.Provider != "local-comfy" {
		return localtask.SelectResult{}, BadAuthRequest("本地任务类型、模型和配方必须一致")
	}
	if parsed.LocalComfy.Version == "" {
		return localtask.SelectResult{}, BadAuthRequest("缺少配方版本，请刷新配方后重新准备任务")
	}
	if parsed.Prompt != "" && strings.TrimSpace(parsed.Prompt) != strings.TrimSpace(req.Prompt) {
		return localtask.SelectResult{}, BadAuthRequest("任务正文与生成正文必须一致")
	}
	if utf8.RuneCountInString(req.Prompt) > 30000 {
		return localtask.SelectResult{}, BadAuthRequest("本地生成正文不能超过30000字符")
	}
	operationID, err := localtask.ClientOperationID(input)
	if err != nil {
		return localtask.SelectResult{}, err
	}
	if operationID == "" {
		return localtask.SelectResult{}, BadAuthRequest("本地任务缺少稳定请求标识")
	}
	if err := s.validateLocalComfyScope(owner, req.ProjectID, parsed.Metadata); err != nil {
		return localtask.SelectResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := s.validateLocalComfyRedo(ctx, owner, req, parsed.Metadata); err != nil {
		return localtask.SelectResult{}, err
	}
	refs, err := s.localComfyReferences(owner, parsed)
	if err != nil {
		return localtask.SelectResult{}, err
	}
	selection, err := (localcomfy.Executor{Client: s.localComfy}).Admit(ctx, parsed.Mode, *parsed.LocalComfy, refs)
	if err != nil {
		return localtask.SelectResult{}, mapLocalComfyError(err)
	}
	data, _ = json.Marshal(selection)
	var normalized map[string]any
	_ = json.Unmarshal(data, &normalized)
	input["localComfy"] = normalized
	input["prompt"] = strings.TrimSpace(req.Prompt)
	input["config"] = map[string]any{}
	return localtask.SelectResult{Input: input}, nil
}

func (s *Service) validateLocalComfyScope(owner, canvasID string, metadata map[string]any) error {
	domainID := strings.TrimSpace(stringValue(metadata["domainProjectId"]))
	chapterID := strings.TrimSpace(firstNonEmpty(stringValue(metadata["chapterId"]), stringValue(metadata["unitId"])))
	shotID := strings.TrimSpace(stringValue(metadata["shotId"]))
	if domainID == "" {
		if chapterID != "" || shotID != "" {
			return BadAuthRequest("本地镜头绑定缺少所属项目")
		}
		return nil
	}
	if _, err := s.repo.ProjectForUser(owner, domainID); err != nil {
		return BadAuthRequest("任务项目不存在或不属于当前用户")
	}
	if canvasID != domainID {
		canvas, err := s.repo.CanvasProjectForUser(owner, canvasID)
		if err != nil || canvas.ProjectID != domainID {
			return BadAuthRequest("任务画布与所属项目不一致")
		}
	}
	if chapterID != "" {
		if _, err := s.repo.ProjectUnit(domainID, chapterID); err != nil {
			return BadAuthRequest("任务章节不属于所选项目")
		}
	}
	if shotID != "" {
		shot, err := s.repo.ShotForProject(domainID, shotID)
		if err != nil || (chapterID != "" && shot.UnitID != chapterID) {
			return BadAuthRequest("任务镜头与项目章节不一致")
		}
	}
	return nil
}

func (s *Service) localComfyFailedJob(ctx context.Context, task *model.Task, input generation.Input) (localcomfy.Job, error) {
	if task.Status != model.TaskStatusFailed || task.ProviderCancelStatus != "" || task.Stage == "submission_unknown" || task.PollStage == "submitting" || task.PollStage == "submission_unknown" || input.LocalComfy == nil {
		return localcomfy.Job{}, BadAuthRequest("原作业尚未明确结束，请查询原作业，不要重复提交")
	}
	job, err := s.localComfy.Job(ctx, task.ProviderRequestID)
	if err != nil {
		return job, mapLocalComfyError(err)
	}
	if job.ID != task.ProviderRequestID || job.Status != "failed" {
		return job, BadAuthRequest("原作业未明确失败，请取回原作业结果")
	}
	request := localcomfy.Request{OwnerID: task.UserID, ProjectID: task.ProjectID, TaskID: task.ID, Selection: *input.LocalComfy}
	if err := (localcomfy.Executor{Client: s.localComfy}).ValidateBinding(ctx, request, job); err != nil {
		return job, mapLocalComfyError(err)
	}
	return job, nil
}

func (s *Service) validateLocalComfyRedo(ctx context.Context, owner string, req localtask.SelectRequest, metadata map[string]any) error {
	parentID := strings.TrimSpace(stringValue(metadata["retryOf"]))
	if parentID == "" {
		return nil
	}
	parent, err := s.repo.TaskForUser(owner, parentID)
	if err != nil {
		return BadAuthRequest("原生重做任务不存在或不属于当前用户")
	}
	var input generation.Input
	if json.Unmarshal([]byte(parent.InputJSON), &input) != nil || input.LocalComfy == nil || parent.Type != req.Type || parent.Model != req.Model || parent.ProjectID != req.ProjectID {
		return BadAuthRequest("重做必须保持原任务的配方、类型和项目")
	}
	if parent.Status == model.TaskStatusSucceeded {
		return nil
	}
	_, err = s.localComfyFailedJob(ctx, parent, input)
	return err
}

func (s *Service) prepareLocalComfyRetry(task *model.Task, input map[string]any) error {
	var parsed generation.Input
	data, err := json.Marshal(input)
	if err != nil || json.Unmarshal(data, &parsed) != nil || parsed.LocalComfy == nil {
		return BadAuthRequest("本地任务输入无效")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// A definite pre-submit rejection has no job to retry; the same stable key
	// remains safe. All accepted attempts require an authoritative failed job.
	if task.PollStage == "rejected" && task.ProviderRequestID == "" && task.Status == model.TaskStatusFailed {
		// Keep an explicitly authorized retry's original lineage and key too.
	} else {
		job, err := s.localComfyFailedJob(ctx, task, parsed)
		if err != nil {
			return err
		}
		parsed.LocalComfy.RetryJobID = job.ID
		parsed.LocalComfy.RetryKey = "native:" + task.ID + ":retry:" + newID()
	}
	refs, err := s.localComfyReferences(task.UserID, parsed)
	if err != nil {
		return err
	}
	selection, err := (localcomfy.Executor{Client: s.localComfy}).Admit(ctx, parsed.Mode, *parsed.LocalComfy, refs)
	if err != nil {
		return mapLocalComfyError(err)
	}
	data, _ = json.Marshal(selection)
	var normalized map[string]any
	_ = json.Unmarshal(data, &normalized)
	input["localComfy"] = normalized
	if err := s.protectTaskSecrets(input); err != nil {
		return err
	}
	data, err = json.Marshal(input)
	if err != nil {
		return err
	}
	task.InputJSON = string(data)
	return nil
}

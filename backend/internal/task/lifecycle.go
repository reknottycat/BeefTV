package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) Retry(userID, id string) (*model.Task, error) {
	if s.deps.Runtime == nil || s.deps.Images == nil || s.deps.Failures == nil || s.deps.Secrets == nil || s.deps.Catalog == nil || s.deps.Policy == nil || s.deps.Projects == nil || s.deps.Present == nil {
		return nil, unavailable()
	}
	if s.deps.Runtime.IsDraining() {
		return nil, drainError(DrainRetryMessage)
	}
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	if task.CreationSubmissionID != nil {
		return nil, kernel.NewAppError(kernel.CodeConflict, CreationRetryConflictMessage)
	}
	if RetiredAgentTask(task) {
		return nil, kernel.BadAuthRequest(RetiredAgentBoundaryMessage)
	}
	if task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return nil, errors.New(RetryOnlyFailedOrCancelled)
	}
	if err := s.deps.Images.ValidateRetry(task); err != nil {
		return nil, err
	}
	if task.ProviderCancelStatus == model.ProviderCancelStatusRequested {
		return nil, kernel.BadAuthRequest(CancellationPendingRetryMessage)
	}
	if s.deps.Failures.IsModeration(task.Error) {
		return nil, kernel.BadAuthRequest(ContentModerationRetryMessage)
	}
	// Native Comfy records an explicit protocol outcome. Only these definite
	// states defer to Catalog.PrepareRetry's authoritative job/binding checks;
	// unknown, cancelled and merely active attempts keep the general fence.
	definiteLocalComfy := task.Provider == "local-comfy" && strings.HasPrefix(task.Model, "local-comfy:") && task.Status == model.TaskStatusFailed && task.ProviderCancelStatus == "" && task.Stage != "submission_unknown" && ((task.PollStage == "failed" && task.ProviderRequestID != "") || (task.PollStage == "rejected" && task.ProviderRequestID == ""))
	if !definiteLocalComfy && s.deps.Failures.BlocksRetry(task.Error, task.Stage) {
		category := s.deps.Failures.Category(task.Error, task.Stage)
		if task.Stage == "submission_unknown" || category == generation.CategorySubmissionUncertain {
			return nil, kernel.BadAuthRequest(SubmissionUncertainRetryMessage)
		}
		if category == generation.CategoryDownloadFailed {
			return nil, kernel.BadAuthRequest(DownloadFailureRetryMessage)
		}
		return nil, kernel.BadAuthRequest(s.deps.Failures.UserMessage(task.Error))
	}
	decryptedInput, err := s.deps.Secrets.DecryptInputJSON(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var taskInput map[string]any
	if err := json.Unmarshal([]byte(decryptedInput), &taskInput); err != nil {
		return nil, err
	}
	if err := s.deps.Catalog.PrepareRetry(task, taskInput); err != nil {
		return nil, err
	}
	if err := s.deps.Catalog.RequireCustomChannels(taskInput); err != nil {
		return nil, err
	}
	limit, err := s.deps.Policy.ActiveTaskLimit()
	if err != nil {
		return nil, err
	}
	if err := s.deps.Projects.EnsureActive(userID, task.ProjectID); err != nil {
		return nil, err
	}
	task, err = s.store.Retry(userID, task, limit)
	if errors.Is(err, repository.ErrActiveTaskLimit) {
		return nil, activeLimitError(limit)
	}
	if errors.Is(err, repository.ErrTaskNotRetryable) {
		return nil, kernel.BadAuthRequest(RetryNotRetryableMessage)
	}
	if mapped := mapTaskScopeError(err); mapped != nil {
		return nil, mapped
	}
	if mapped := mapTaskResourceError(err); mapped != nil {
		return nil, mapped
	}
	if err != nil {
		return nil, err
	}
	s.log(userID, task.ID, "info", "任务已重新入队", "")
	return presentTask(s.deps.Present, *task)
}

func (s *Service) Cancel(ctx context.Context, userID, id string) (*model.Task, error) {
	_ = ctx
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Runtime == nil || s.deps.Present == nil {
		return nil, unavailable()
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
		if task.Status == model.TaskStatusCancelled {
			return presentTask(s.deps.Present, *task)
		}
		return nil, fmt.Errorf("任务当前状态为 %s，无法取消", task.Status)
	}

	s.hydrateProviderRequestID(task)
	now := s.now()
	cancelled, err := s.store.CancelIfStatus(userID, id, task.Status, now)
	if err != nil {
		return nil, err
	}
	if !cancelled {
		latest, latestErr := s.store.TaskForUser(userID, id)
		if latestErr != nil {
			return nil, latestErr
		}
		if latest.Status == model.TaskStatusCancelled {
			return presentTask(s.deps.Present, *latest)
		}
		return nil, errors.New(CancelChangedMessage)
	}

	task.Status = model.TaskStatusCancelled
	task.Stage = "任务已取消"
	task.Error = "任务已取消"
	task.CompletedAt = &now
	s.deps.Runtime.StopLocalWait(task.ID)

	if s.deps.TextReplay != nil {
		if err := s.deps.TextReplay.Finalize(task.ID, model.TaskStatusCancelled); err != nil {
			s.log(task.UserID, task.ID, "error", "取消任务后归并文本回放失败", err.Error())
		}
	}
	s.log(task.UserID, task.ID, "warn", "用户主动取消任务", "")

	if strings.HasPrefix(task.Model, "local-comfy:") {
		// Stopping observation never means stopping GPU work, even when the
		// submission acknowledgement has not reached the native ledger yet.
		task.Stage = "已停止本地跟踪"
		task.Error = "仅停止本地跟踪；GPU作业未确认终止，可查询原作业取回结果"
		if s.deps.Provider != nil {
			if err := s.deps.Provider.RequestCancel(ctx, task); err != nil {
				return nil, err
			}
		}
		task.ProviderCancelStatus = model.ProviderCancelStatusUncertain
	} else if task.ProviderRequestID != "" && s.deps.Provider != nil {
		cancelTask := *task
		run := func() {
			requestCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := s.deps.Provider.RequestCancel(requestCtx, &cancelTask); err != nil {
				s.log(cancelTask.UserID, cancelTask.ID, "error", "发送上游取消请求失败", err.Error())
			}
		}
		started := false
		if s.deps.Runtime != nil {
			started = s.deps.Runtime.Dispatch(run)
		}
		if !started {
			run()
		}
	}

	return presentTask(s.deps.Present, *task)
}

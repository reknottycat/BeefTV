package repository

import (
	"infinite-canvas/backend/internal/model"
	"strings"
	"time"
)

// Local Comfy cancellation stops native tracking, so its original job may be
// recovered from either terminal state. Other provider recovery stays unchanged.
func (r *Repository) ClaimLocalComfyRecovery(id, userID, owner string, duration time.Duration) error {
	now := time.Now()
	result := r.db.Model(&model.Task{}).Where("id = ? AND user_id = ? AND model LIKE ? AND status IN ? AND (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)", id, userID, "local-comfy:%", []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled}, now).Updates(map[string]any{"lease_owner": owner, "lease_expires_at": now.Add(duration), "updated_at": now})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskProviderRecoveryConflict
	}
	return nil
}

func (r *Repository) SaveLocalComfyState(id, userID, owner, jobID, status string) error {
	updates := map[string]any{"poll_stage": status, "updated_at": time.Now()}
	if jobID != "" {
		updates["provider_request_id"] = jobID
	}
	allowed := []model.TaskStatus{model.TaskStatusRunning}
	if strings.HasPrefix(owner, "manual-recovery:") {
		allowed = []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled}
	}
	result := taskLeaseWriter(r.db.Model(&model.Task{}), owner).Where("id = ? AND user_id = ? AND status IN ?", id, userID, allowed).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

func (r *Repository) MarkLocalComfyTrackingStopped(userID, id string) error {
	return r.db.Model(&model.Task{}).Where("id = ? AND user_id = ? AND status = ? AND model LIKE ?", id, userID, model.TaskStatusCancelled, "local-comfy:%").Updates(map[string]any{"stage": "已停止本地跟踪", "error": "仅停止本地跟踪；GPU作业未确认终止，可查询原作业取回结果", "provider_cancel_status": model.ProviderCancelStatusUncertain, "provider_cancel_error": "未发送GPU终止请求；可查询原作业", "provider_cancel_next_check_at": nil}).Error
}

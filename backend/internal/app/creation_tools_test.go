package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func approveToolCanvas(t *testing.T, s *Service, id string, guard CreationGuard, request *CreateTaskRequest, specifications map[string]any) {
	t.Helper()
	metadata := map[string]any{"prompt": request.Prompt, "model": request.Model}
	for key, value := range specifications {
		metadata[key] = value
	}
	ops := []CreationCanvasOp{{Type: "add_node", ID: "tool-shot", NodeType: "image", Metadata: metadata}}
	if _, err := s.ChangeCreationRun("user", id, "proposal-approve", CreationRequest{CreationGuard: guard, Revision: 2, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"工具制作"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	canvas, err := s.CreateRunCanvas("user", id, CreationRequest{CreationGuard: guard})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.CreationCanvasSnapshot("user", id)
	if err != nil {
		t.Fatal(err)
	}
	doc := snapshot["document"].(map[string]any)
	doc["nodes"] = []any{creationAddedNode(ops[0])}
	raw, _ := json.Marshal(doc)
	if _, err = s.CommitCreationCanvas("user", id, CreationRequest{CreationGuard: guard, ExpectedSnapshotHash: snapshot["snapshotHash"].(string), Document: raw}); err != nil {
		t.Fatal(err)
	}
	request.ProjectID = canvas["canvasId"].(string)
	request.Input["nodeId"] = "tool-shot"
	request.Input["metadata"] = map[string]any{"nodeId": "tool-shot", "clientOperationId": "creation-tool-stable"}
}

func TestCreationLocalComfyPrepareApproveExecuteAndGate(t *testing.T) {
	s, db, id, guard := creationTestService(t)
	mock := &nativeComfyMock{t: t, enabled: true, assets: map[string]localComfyAsset{}, jobs: map[string]localComfyJob{}}
	s.localComfyTransport = mock
	s.localResourceStorage = true
	s.workerID = newID()
	s.activeCancels = map[string]context.CancelFunc{}
	t.Cleanup(func() {
		providerAnalyticsServices.Lock()
		delete(providerAnalyticsServices.services, s.workerID)
		providerAnalyticsServices.Unlock()
	})
	request := nativeComfyTaskRequest()
	approveToolCanvas(t, s, id, guard, &request, map[string]any{"size": "1024x1024"})
	prepare := CreationRequest{CreationGuard: guard, ItemKey: "media:v1:shot:1", ProposalVersion: 1, Request: request}
	item, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil || again.ID != item.ID {
		t.Fatalf("prepare dedup = %v, %v", again, err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 || mock.jobPosts != 0 || len(mock.projects) != 0 {
		t.Fatal("prepare submitted work")
	}
	if _, err = s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("unapproved tool executed")
	}
	mock.enabled = false
	if _, err = s.ApproveCreationSubmissions("user", id, CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}); err == nil {
		t.Fatal("disabled generation approved")
	}
	mock.enabled = true
	if _, err = s.ApproveCreationSubmissions("user", id, CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	task, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
	if err != nil || replay.ID != task.ID {
		t.Fatal("execution duplicated")
	}
	db.Model(&model.Task{}).Count(&count)
	if count != 1 || mock.jobPosts != 0 {
		t.Fatalf("admitted %d tasks, %d upstream jobs", count, mock.jobPosts)
	}
	if err = s.taskWorker().processNextTask(); err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusRunning || mock.jobPosts != 1 {
		t.Fatalf("native worker did not use approved task: status=%s, jobs=%d", stored.Status, mock.jobPosts)
	}
	mock.complete = true
	db.Model(&model.Task{}).Where("id = ?", task.ID).Update("next_poll_at", nil)
	if err = s.taskWorker().processNextTask(); err != nil {
		t.Fatal(err)
	}
	stored, err = s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusSucceeded || !strings.Contains(stored.ResultJSON, "resource:") || mock.jobPosts != 1 {
		t.Fatalf("native result was not saved: status=%s, jobs=%d", stored.Status, mock.jobPosts)
	}
}

func TestCreationRunningHubFrozenCredentialsAndAdmission(t *testing.T) {
	s, db, id, guard := creationTestService(t)
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.pluginRuntime = center
	if _, err = s.SetUserPluginEnabled(&model.User{ID: "user", Role: model.UserRoleUser}, WorkflowPluginRunningHub, true); err != nil {
		t.Fatal(err)
	}
	request := CreateTaskRequest{Type: "canvas_image", Operation: "image", Provider: "runninghub", Model: "runninghub:app:test-app", Prompt: "测试图片", Input: map[string]any{"mode": "image", "prompt": "测试图片", "referenceImages": []any{}, "config": map[string]any{"interfaceType": "runninghub-workflow-image", "baseUrl": "https://www.runninghub.cn", "apiKey": "TEST-PRIVATE-RUNNINGHUB-KEY", "webappId": "test-app", "model": "test-app", "workflowFields": []any{map[string]any{"nodeId": "1", "fieldName": "text", "fieldType": "string", "source": "prompt", "enabled": true}}, "count": "1"}}}
	approveToolCanvas(t, s, id, guard, &request, nil)
	prepare := CreationRequest{CreationGuard: guard, ItemKey: "media:v1:rh:1", ProposalVersion: 1, Request: request}
	item, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil {
		t.Fatal(err)
	}
	altered := request
	raw, _ := json.Marshal(request.Input)
	altered.Input = nil
	_ = json.Unmarshal(raw, &altered.Input)
	altered.Input["config"].(map[string]any)["webappId"] = "other-app"
	if _, err = s.PrepareCreationSubmission("user", id, CreationRequest{CreationGuard: guard, ItemKey: "mismatch", ProposalVersion: 1, Request: altered}); err == nil {
		t.Fatal("approved tool redirected to other app")
	}
	stored, err := s.repo.CreationSubmission("user", id, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.RequestJSON, "TEST-PRIVATE-RUNNINGHUB-KEY") {
		t.Fatal("plaintext credential persisted")
	}
	// Fresh encryption nonces must not affect request deduplication or approval.
	again, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil || again.ID != item.ID {
		t.Fatalf("encrypted dedup = %v, %v", again, err)
	}
	if _, err = s.ApproveCreationSubmissions("user", id, CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	task, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
	if err != nil || replay.ID != task.ID {
		t.Fatal("workflow duplicated")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatalf("task count %d", count)
	}
	saved, err := s.repo.TaskForUser("user", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(saved.InputJSON, "TEST-PRIVATE-RUNNINGHUB-KEY") {
		t.Fatal("task credential not encrypted")
	}
	plain, err := s.decryptTaskInputJSON(saved.InputJSON)
	if err != nil || !strings.Contains(plain, "TEST-PRIVATE-RUNNINGHUB-KEY") {
		t.Fatal("worker cannot resolve frozen credential")
	}
	if err = validateCreationJSON(map[string]any{"apiKey": "TEST-PRIVATE-RUNNINGHUB-KEY"}); err == nil {
		t.Fatal("plan/state now permits plaintext credentials")
	}
}

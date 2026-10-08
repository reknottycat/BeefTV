package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/localcomfy"
	"infinite-canvas/backend/internal/model"
)

func approveCreationToolCanvas(t *testing.T, s *Service, id string, guard CreationGuard, request *CreateTaskRequest, metadata map[string]any) {
	t.Helper()
	metadata["prompt"], metadata["model"] = request.Prompt, request.Model
	detail, err := s.GetCreationRun("user", id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ChangeCreationRun("user", id, "proposal-approve", CreationRequest{
		CreationGuard: guard, Revision: detail.Run.Revision, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"工具制作"}`),
		Ops: []CreationCanvasOp{{Type: "add_node", ID: "shot", NodeType: strings.TrimPrefix(request.Type, "canvas_"), Metadata: metadata}},
	}); err != nil {
		t.Fatal(err)
	}
	canvas, err := s.CreateRunCanvas("user", id, CreationRequest{CreationGuard: guard})
	if err != nil {
		t.Fatal(err)
	}
	request.ProjectID = canvas["canvasId"].(string)
	request.Input["nodeId"] = "shot"
	request.Input["metadata"] = map[string]any{"nodeId": "shot", "clientOperationId": "creation-tool-stable"}
}

func TestCreationWorkflowProtectsFrozenCredentialsAndReplays(t *testing.T) {
	allowLoopbackProviderTest(t)
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		http.Error(w, "must wait for worker", http.StatusBadRequest)
	}))
	t.Cleanup(upstream.Close)
	s, db, id, guard := creationTestService(t)
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.pluginRuntime = center
	if _, err = s.SetUserPluginEnabled(&model.User{ID: "user", Role: model.UserRoleUser}, WorkflowPluginRunningHub, true); err != nil {
		t.Fatal(err)
	}
	request := CreateTaskRequest{Type: "canvas_image", Operation: "image", Provider: "runninghub", Model: "runninghub:app:test-app", Prompt: "测试图片", Input: map[string]any{
		"mode": "image", "prompt": "测试图片", "referenceImages": []any{}, "config": map[string]any{
			"interfaceType": "runninghub-workflow-image", "baseUrl": upstream.URL, "apiKey": "TEST-PRIVATE-RUNNINGHUB-KEY",
			"runningHubWalletApiKey": "TEST-PRIVATE-WALLET-KEY", "runningHubUploadApiKey": "TEST-PRIVATE-UPLOAD-KEY",
			"webappId": "test-app", "model": "test-app", "count": "1", "headers": []any{},
			"workflowFields": []any{map[string]any{"nodeId": "1", "fieldName": "text", "fieldType": "string", "source": "prompt", "enabled": true}},
		},
	}}
	approveCreationToolCanvas(t, s, id, guard, &request, map[string]any{})
	prepare := CreationRequest{CreationGuard: guard, ItemKey: "workflow:shot:1", ProposalVersion: 1, Request: request}
	item, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.CreationSubmission("user", id, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.RequestJSON, "TEST-PRIVATE-") || !strings.Contains(stored.RequestJSON, encryptedSettingPrefix) {
		t.Fatal("submission credentials were not encrypted")
	}
	encoded, _ := json.Marshal(item)
	if strings.Contains(string(encoded), "TEST-PRIVATE-") || strings.Contains(string(encoded), encryptedSettingPrefix) {
		t.Fatal("submission response exposed credentials")
	}
	second, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil || second.ID != item.ID {
		t.Fatalf("encryption nonce broke prepare replay: %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("prepare persisted executable task")
	}
	if _, err = s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("unapproved workflow executed")
	}
	original := stored.RequestJSON
	var corrupted map[string]any
	_ = json.Unmarshal([]byte(original), &corrupted)
	corrupted["input"].(map[string]any)["config"].(map[string]any)["apiKey"] = encryptedSettingPrefix + "invalid"
	broken, _ := json.Marshal(corrupted)
	stored.RequestJSON = string(broken)
	if err = s.repo.SaveCreationSubmission(stored); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApproveCreationSubmissions("user", id, CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}); err == nil {
		t.Fatal("unreadable frozen credential approved")
	}
	stored.RequestJSON = original
	if err = s.repo.SaveCreationSubmission(stored); err != nil {
		t.Fatal(err)
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
		t.Fatalf("execution replay duplicated: %v", err)
	}
	db.Model(&model.Task{}).Count(&count)
	if count != 1 || upstreamCalls.Load() != 0 {
		t.Fatalf("created %d task rows and %d upstream calls before worker", count, upstreamCalls.Load())
	}
	saved, err := s.repo.TaskForUser("user", task.ID)
	if err != nil || strings.Contains(saved.InputJSON, "TEST-PRIVATE-") {
		t.Fatalf("task credentials were not encrypted: %v", err)
	}
	plain, err := s.decryptTaskInputJSON(saved.InputJSON)
	if err != nil || !strings.Contains(plain, "TEST-PRIVATE-RUNNINGHUB-KEY") || !strings.Contains(plain, "TEST-PRIVATE-WALLET-KEY") || !strings.Contains(plain, "TEST-PRIVATE-UPLOAD-KEY") {
		t.Fatalf("worker cannot recover frozen credentials: %v", err)
	}
}

func TestCreationComfyCatalogGateVersionAndTaskAdmission(t *testing.T) {
	allowLoopbackProviderTest(t)
	var enabled atomic.Bool
	enabled.Store(true)
	var version atomic.Value
	version.Store(strings.Repeat("a", 64))
	var writes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes.Add(1)
			http.Error(w, "prepare must not submit GPU work", http.StatusBadRequest)
			return
		}
		var data any
		switch r.URL.Path {
		case "/config":
			data = localcomfy.Config{Configured: true, GenerationEnabled: enabled.Load(), RecipeCount: 1, MaxReferenceBytes: 16 << 20}
		case "/recipes":
			data = []localcomfy.Recipe{{ID: "studio-new-recipe", Version: version.Load().(string), Mode: "i2i", Ready: true, ReferenceSlots: 1, Constraints: []localcomfy.Constraint{{Width: 1536, Height: 1024, MimeTypes: []string{"image/png"}}}, Output: localcomfy.Output{Width: 1536, Height: 1024}}}
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
	}))
	t.Cleanup(server.Close)
	s, db, id, guard := creationTestService(t)
	s.localResourceStorage = true
	if err := s.ConfigureLocalComfy(server.URL, ""); err != nil {
		t.Fatal(err)
	}
	request := CreateTaskRequest{Type: "canvas_image", Operation: "image", Provider: "local-comfy", Model: "local-comfy:studio-new-recipe", Prompt: "测试图片", Input: map[string]any{
		"mode": "image", "prompt": "测试图片", "config": map[string]any{}, "referenceImages": []any{map[string]any{"id": "frame-node", "storageKey": "resource:frame-resource"}},
		"localComfy": map[string]any{"recipeId": "studio-new-recipe", "recipeVersion": version.Load().(string), "seed": 5},
	}}
	approveCreationToolCanvas(t, s, id, guard, &request, map[string]any{"localComfyRecipeId": "studio-new-recipe", "localComfyRecipeVersion": version.Load().(string), "size": "1536x1024", "referenceNodeIds": []any{"frame-node"}})
	if err := db.Create(&model.Resource{ID: "frame-resource", UserID: "user", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", MimeType: "image/png", Width: 1536, Height: 1024, Size: 1024}).Error; err != nil {
		t.Fatal(err)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", request.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	_ = json.Unmarshal([]byte(canvas.PayloadJSON), &document)
	document["nodes"] = []any{map[string]any{"id": "frame-node", "type": "image", "metadata": map[string]any{"status": "success", "storageKey": "resource:frame-resource"}}}
	raw, _ := json.Marshal(document)
	if err = db.Model(canvas).Update("payload_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	prepare := CreationRequest{CreationGuard: guard, ItemKey: "local:shot:1", ProposalVersion: 1, Request: request}
	item, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil {
		t.Fatal(err)
	}
	if item.Execution.Options["size"] != "1536x1024" {
		t.Fatalf("lost authoritative output: %#v", item.Execution.Options)
	}
	again, err := s.PrepareCreationSubmission("user", id, prepare)
	if err != nil || again.ID != item.ID {
		t.Fatalf("prepare replay failed: %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 || writes.Load() != 0 {
		t.Fatal("prepare created GPU work or native task")
	}
	enabled.Store(false)
	approve := CreationRequest{CreationGuard: guard, SubmissionIDs: []string{item.ID}}
	if _, err = s.ApproveCreationSubmissions("user", id, approve); err == nil {
		t.Fatal("disabled adapter approved")
	}
	enabled.Store(true)
	version.Store(strings.Repeat("b", 64))
	if _, err = s.ApproveCreationSubmissions("user", id, approve); err == nil {
		t.Fatal("changed recipe approved")
	}
	version.Store(strings.Repeat("a", 64))
	if _, err = s.ApproveCreationSubmissions("user", id, approve); err != nil {
		t.Fatal(err)
	}
	enabled.Store(false)
	if _, err = s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("disabled adapter admitted after approval")
	}
	enabled.Store(true)
	task, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.ExecuteCreationSubmission("user", id, CreationRequest{CreationGuard: guard, SubmissionID: item.ID})
	if err != nil || replay.ID != task.ID {
		t.Fatalf("execute replay failed: %v", err)
	}
	db.Model(&model.Task{}).Count(&count)
	if count != 1 || writes.Load() != 0 {
		t.Fatalf("admitted %d tasks, %d GPU writes before worker execution", count, writes.Load())
	}
}

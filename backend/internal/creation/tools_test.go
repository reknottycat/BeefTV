package creation

import (
	"encoding/json"
	"strings"
	"testing"
)

type recipeTasks struct {
	*testTasks
	version string
	enabled bool
}

func (p *recipeTasks) Prepare(user string, req TaskRequest) (*PreparedTask, error) {
	selection := req.Input["localComfy"].(map[string]any)
	if !p.enabled || selection["recipeVersion"] != p.version {
		return nil, Conflict("recipe unavailable or changed")
	}
	selection["recipeSpec"] = map[string]any{
		"id": selection["recipeId"], "recipe_version": p.version, "mode": "t2v",
		"output": map[string]any{"width": 1280, "height": 720, "fps": 30, "duration_seconds": 7.5},
	}
	return p.testTasks.Prepare(user, req)
}

func prepareToolCanvas(t *testing.T, h *harness, req *TaskRequest, metadata map[string]any) {
	t.Helper()
	metadata["prompt"], metadata["model"] = req.Prompt, req.Model
	run, err := h.repo.CreationRun(h.user, h.runID)
	if err != nil {
		t.Fatal(err)
	}
	ops := []CanvasOp{{Type: "add_node", ID: "shot", NodeType: "video", Metadata: metadata}}
	if _, err = h.svc.Change(h.user, h.runID, "proposal-approve", Command{Guard: h.guard, Revision: run.Revision, ProposalVersion: 1, Proposal: json.RawMessage(`{"title":"制作"}`), Ops: ops}); err != nil {
		t.Fatal(err)
	}
	canvas, err := h.svc.CreateCanvas(h.user, h.runID, h.cmd())
	if err != nil {
		t.Fatal(err)
	}
	req.ProjectID = canvas["canvasId"].(string)
	req.Input["nodeId"] = "shot"
}

func TestRecipeSubmissionPinsCatalogVersionAndArbitraryOutput(t *testing.T) {
	h := newHarness(t)
	tasks := &recipeTasks{testTasks: h.tasks, version: "v1", enabled: true}
	h.svc.deps.Tasks = tasks
	req := TaskRequest{Type: "canvas_video", Operation: "video", Provider: "local-comfy", Model: "local-comfy:studio-new-recipe", Prompt: "镜头", Input: map[string]any{
		"mode": "video", "prompt": "镜头", "config": map[string]any{},
		"localComfy": map[string]any{"recipeId": "studio-new-recipe", "recipeVersion": "v1", "seed": 42},
	}}
	prepareToolCanvas(t, h, &req, map[string]any{"localComfyRecipeId": "studio-new-recipe", "localComfyRecipeVersion": "v1", "size": "1280x720", "seconds": 7.5})
	cmd := Command{Guard: h.guard, ProposalVersion: 1, ItemKey: "shot:1", Task: req}
	item, err := h.svc.Prepare(h.user, h.runID, cmd)
	if err != nil {
		t.Fatal(err)
	}
	if item.Execution.Options["size"] != "1280x720" || item.Execution.Options["videoSeconds"] != 7.5 || item.Execution.Options["recipeVersion"] != "v1" {
		t.Fatalf("recipe output was not frozen: %#v", item.Execution.Options)
	}
	stored, _ := h.repo.CreationSubmission(h.user, h.runID, item.ID)
	var frozen TaskRequest
	if err = json.Unmarshal([]byte(stored.RequestJSON), &frozen); err != nil || recipeOptions(frozen.Input)["size"] != "1280x720" {
		t.Fatalf("missing persisted server recipe: %v", err)
	}
	if _, err = h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("unapproved recipe executed")
	}
	tasks.enabled = false
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err == nil {
		t.Fatal("disabled recipe approved")
	}
	tasks.enabled, tasks.version = true, "v2"
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err == nil {
		t.Fatal("changed recipe approved")
	}
	tasks.version = "v1"
	if _, err = h.svc.Approve(h.user, h.runID, Command{Guard: h.guard, SubmissionIDs: []string{item.ID}}); err != nil {
		t.Fatal(err)
	}
	tasks.version = "v2"
	if _, err = h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID}); err == nil {
		t.Fatal("recipe changed after approval executed")
	}
	assertNoTaskRow(t, h, item.ID)
	tasks.version = "v1"
	first, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
	if err != nil {
		t.Fatal(err)
	}
	again, err := h.svc.Execute(h.user, h.runID, Command{Guard: h.guard, SubmissionID: item.ID})
	if err != nil || first.ID != again.ID || h.tasks.admitN.Load() != 1 {
		t.Fatalf("recipe replay duplicated: %v", err)
	}
}

func TestRecipeScopeRequiresApprovedVersionAndReferences(t *testing.T) {
	h := newHarness(t)
	req := TaskRequest{Type: "canvas_video", Provider: "local-comfy", Model: "local-comfy:recipe", Prompt: "镜头", Input: map[string]any{
		"mode": "video", "prompt": "镜头", "localComfy": map[string]any{"recipeId": "recipe", "recipeVersion": "v1"},
		"referenceImages": []any{map[string]any{"id": "frame", "storageKey": "resource:frame"}},
	}}
	prepareToolCanvas(t, h, &req, map[string]any{"localComfyRecipeId": "recipe", "localComfyRecipeVersion": "v1", "referenceNodeIds": []any{"frame"}})
	run, _ := h.repo.CreationRun(h.user, h.runID)
	if err := ValidateSubmissionScope(run, 1, req); err != nil {
		t.Fatal(err)
	}
	req.Input["localComfy"].(map[string]any)["recipeVersion"] = "v2"
	if err := ValidateSubmissionScope(run, 1, req); err == nil {
		t.Fatal("unapproved recipe version accepted")
	}
	req.Input["localComfy"].(map[string]any)["recipeVersion"] = "v1"
	req.Input["referenceImages"].([]any)[0].(map[string]any)["id"] = "other"
	if err := ValidateSubmissionScope(run, 1, req); err == nil {
		t.Fatal("unapproved reference accepted")
	}
	req.Type = "canvas_text"
	if _, err := validateToolRequest(&req); err == nil {
		t.Fatal("media tool used as director model")
	}
}

func TestWorkflowIdentityAndRecordPolicy(t *testing.T) {
	req := TaskRequest{Type: "canvas_image", Provider: "runninghub", Model: "runninghub:workflow:my%2Fworkflow", Input: map[string]any{"config": map[string]any{
		"interfaceType": "runninghub-workflow-image", "workflowId": "my/workflow", "baseUrl": "https://www.runninghub.cn", "apiKey": "private", "headers": []any{},
	}}}
	if tool, err := validateToolRequest(&req); err != nil || !tool {
		t.Fatalf("valid workflow rejected: %v", err)
	}
	if err := validateTaskRecord(req, true); err != nil {
		t.Fatal(err)
	}
	config := req.Input["config"].(map[string]any)
	config["webappId"] = "different"
	if _, err := validateToolRequest(&req); err == nil {
		t.Fatal("workflow redirected to app")
	}
	delete(config, "webappId")
	for _, headers := range []any{map[string]any{}, []any{map[string]any{"name": "Authorization", "value": "private"}}, "private"} {
		config["headers"] = headers
		if err := validateTaskRecord(req, true); err == nil {
			t.Fatalf("unsafe headers accepted: %T", headers)
		}
	}
	config["headers"] = []any{}
	config["baseUrl"] = "https://user:private@example.com"
	if err := validateTaskRecord(req, true); err == nil {
		t.Fatal("credential URL persisted")
	}
	config["baseUrl"] = "https://www.runninghub.cn"
	config["apiKey"] = strings.Repeat("k", maxJSONBytes)
	if err := validateTaskRecord(req, true); err == nil {
		t.Fatal("credential exemption bypassed record size limit")
	}
	for _, key := range []string{"apiKey", "runningHubWalletApiKey", "runningHubUploadApiKey"} {
		if err := ValidateJSON(map[string]any{key: "private"}); err == nil {
			t.Fatalf("plan/state allows credential %s", key)
		}
	}
}

func TestPrepareFailsBeforePersistenceWithoutSecretProtection(t *testing.T) {
	h := newHarness(t)
	h.svc.deps.Secrets = nil
	if _, err := h.svc.Prepare(h.user, h.runID, Command{Guard: h.guard, ItemKey: "protected", Task: textTask()}); err == nil {
		t.Fatal("prepare persisted without secret protection port")
	}
	items, err := h.repo.CreationSubmissions(h.user, h.runID)
	if err != nil || len(items) != 0 {
		t.Fatalf("failed protection left durable submissions: %v", err)
	}
}

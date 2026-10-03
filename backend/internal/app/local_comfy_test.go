package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type nativeComfyMock struct {
	t            *testing.T
	enabled      bool
	complete     bool
	unknown      bool
	requests     []string
	projects     []localComfyProject
	shots        []localComfyShot
	assets       map[string]localComfyAsset
	jobs         map[string]localComfyJob
	jobPosts     int
	retryPosts   int
	contentReads int
	refs         []string
	jobSeed      uint32
	jobPrompt    string
	resultMime   string
	faultAction  string
}

func (m *nativeComfyMock) RoundTrip(request *http.Request) (*http.Response, error) {
	m.t.Helper()
	if request.URL.Host != "comfy-adapter:6007" || request.URL.Scheme != "http" || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
		m.t.Fatalf("unexpected adapter destination or credentials: host=%s", request.URL.Host)
	}
	path := strings.TrimPrefix(request.URL.Path, "/api/local-comfy/v1")
	m.requests = append(m.requests, request.Method+" "+path)
	var payload map[string]any
	if request.Method == http.MethodPost {
		if request.Header.Get("Content-Type") != "application/json" {
			m.t.Fatal("POST must declare JSON")
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			m.t.Fatal(err)
		}
	}
	var result any
	switch {
	case path == "/config":
		result = map[string]any{"generation_enabled": m.enabled}
	case path == "/recipes":
		result = []localComfyRecipe{{ID: "qwen_image_2_1", Mode: "t2i", Ready: true}, {ID: "qwen_image_2_1_preview512", Mode: "t2i", Ready: true}, {ID: "h3_i2v_turbo4", Mode: "i2v", Ready: true, ReferenceSlots: 1}}
	case path == "/projects" && request.Method == http.MethodGet:
		result = m.projects
	case path == "/projects":
		project := localComfyProject{ID: "11111111111111111111111111111111", Upstream: stringValue(payload["upstream_project_id"]), CanvasID: stringValue(payload["canvas_project_id"])}
		m.projects = append(m.projects, project)
		result = project
	case strings.HasPrefix(path, "/projects/"):
		for _, item := range m.projects {
			if item.ID == strings.TrimPrefix(path, "/projects/") {
				result = item
			}
		}
	case path == "/shots" && request.Method == http.MethodGet:
		result = m.shots
	case path == "/shots":
		shot := localComfyShot{ID: "22222222222222222222222222222222", ProjectID: stringValue(payload["project_id"]), Upstream: stringValue(payload["upstream_shot_id"])}
		m.shots = append(m.shots, shot)
		result = shot
	case strings.HasPrefix(path, "/shots/"):
		for _, item := range m.shots {
			if item.ID == strings.TrimPrefix(path, "/shots/") {
				result = item
			}
		}
	case path == "/assets" && request.Method == http.MethodGet:
		values := make([]localComfyAsset, 0)
		for _, item := range m.assets {
			values = append(values, item)
		}
		result = values
	case path == "/assets":
		asset := localComfyAsset{ID: "33333333333333333333333333333333", ProjectID: stringValue(payload["project_id"]), Upstream: stringValue(payload["upstream_asset_id"]), MimeType: stringValue(payload["mime_type"])}
		if _, err := base64.StdEncoding.DecodeString(stringValue(payload["data_base64"])); err != nil {
			m.t.Fatal("reference is not actual base64 image bytes")
		}
		m.assets[asset.ID] = asset
		result = asset
	case path == "/jobs" && request.Method == http.MethodGet:
		values := make([]localComfyJob, 0)
		for _, item := range m.jobs {
			values = append(values, item)
		}
		result = values
	case path == "/jobs":
		m.jobPosts++
		if !m.enabled {
			return m.response(403, map[string]any{"code": 403, "reason": "generation_disabled"}), nil
		}
		job := localComfyJob{ID: "44444444444444444444444444444444", ProjectID: stringValue(payload["project_id"]), ShotID: stringValue(payload["shot_id"]), RecipeID: stringValue(payload["recipe_id"]), Key: stringValue(payload["request_key"]), Status: "submitted", PromptID: "mock-prompt-1"}
		m.jobSeed = uint32(payload["seed"].(float64))
		m.jobPrompt = stringValue(payload["prompt"])
		if references, ok := payload["reference_asset_ids"].([]any); ok {
			for _, reference := range references {
				m.refs = append(m.refs, stringValue(reference))
			}
		}
		if m.unknown {
			job.Status, job.PromptID = "submission_unknown", ""
		}
		m.jobs[job.ID] = job
		result = job
	case strings.HasPrefix(path, "/jobs/"):
		parts := strings.Split(strings.TrimPrefix(path, "/jobs/"), "/")
		job := m.jobs[parts[0]]
		if len(parts) == 2 {
			switch parts[1] {
			case "poll":
				job.Status = "running"
				if m.complete {
					job.Status = "completed"
				}
			case "archive":
				job.Assets = []string{"55555555555555555555555555555555"}
				data, mimeType := m.resultBytes()
				sum := sha256.Sum256(data)
				m.assets[job.Assets[0]] = localComfyAsset{ID: job.Assets[0], JobID: job.ID, ProjectID: job.ProjectID, MimeType: mimeType, Size: int64(len(data)), Width: 1, Height: 1, SHA256: hex.EncodeToString(sum[:])}
			case "retry":
				m.retryPosts++
				job.ID, job.Key, job.Status = "66666666666666666666666666666666", stringValue(payload["request_key"]), "submitted"
			}
			m.jobs[job.ID] = job
			if parts[1] == m.faultAction {
				job.ID = "77777777777777777777777777777777"
			}
		}
		result = job
	case strings.HasPrefix(path, "/assets/"):
		parts := strings.Split(strings.TrimPrefix(path, "/assets/"), "/")
		if len(parts) == 2 && parts[1] == "content" {
			m.contentReads++
			data, mimeType := m.resultBytes()
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{"Content-Type": []string{mimeType}}}, nil
		}
		result = m.assets[parts[0]]
	default:
		m.t.Fatalf("unexpected local adapter request: %s %s", request.Method, path)
	}
	return m.response(200, map[string]any{"code": 0, "data": result}), nil
}

func (m *nativeComfyMock) response(status int, payload any) *http.Response {
	data, _ := json.Marshal(payload)
	return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{"Content-Type": []string{"application/json"}}}
}

func nativeComfyTestPNG() []byte {
	data, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	return data
}

func (m *nativeComfyMock) resultBytes() ([]byte, string) {
	if m.resultMime == "video/mp4" {
		return []byte("\x00\x00\x00\x18ftypisomTEST-MOCK-CONTENT"), "video/mp4"
	}
	return nativeComfyTestPNG(), "image/png"
}

func newNativeComfyTestService(t *testing.T) (*Service, *nativeComfyMock, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	sql.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sql.Close() })
	if err := db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	mock := &nativeComfyMock{t: t, enabled: true, assets: make(map[string]localComfyAsset), jobs: make(map[string]localComfyJob)}
	svc := &Service{repo: repository.New(db), dataDir: t.TempDir(), mode: serviceModeLocal, localResourceStorage: true, workerID: newID(), localComfyTransport: mock, activeCancels: make(map[string]context.CancelFunc)}
	t.Cleanup(func() {
		providerAnalyticsServices.Lock()
		delete(providerAnalyticsServices.services, svc.workerID)
		providerAnalyticsServices.Unlock()
	})
	return svc, mock, db
}

func nativeComfyTaskRequest() CreateTaskRequest {
	return CreateTaskRequest{Type: "canvas_image", Prompt: "TEST native local prompt", Provider: "local-comfy", Model: "local-comfy:qwen_image_2_1", Input: map[string]any{"mode": "image", "prompt": "TEST native local prompt", "localComfy": map[string]any{"recipeId": "qwen_image_2_1", "seed": 42}, "referenceImages": []any{}, "metadata": map[string]any{"clientOperationId": "TEST-native-operation-1", "nodeId": "TEST-node-1"}}}
}

func TestNativeComfyGenerationDisabledCreatesNoTaskOrJob(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	mock.enabled = false
	_, err := svc.CreateTask("user", nativeComfyTaskRequest())
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != 403 || appErr.Reason != "generation_disabled" {
		t.Fatalf("error = %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 || mock.jobPosts != 0 || len(mock.projects) != 0 {
		t.Fatalf("gate mutated state: tasks=%d jobs=%d projects=%d", count, mock.jobPosts, len(mock.projects))
	}
}

func TestNativeComfyRejectsMismatchedSelectionAndCloudConfig(t *testing.T) {
	for _, name := range []string{"model", "provider", "mode", "logical", "seed_bool", "seed_fraction", "seed_range", "missing_operation", "cloud_url", "unknown_local", "unknown_root", "video_ref"} {
		t.Run(name, func(t *testing.T) {
			svc, mock, _ := newNativeComfyTestService(t)
			req := nativeComfyTaskRequest()
			switch name {
			case "model":
				req.Model = "local-comfy:different"
			case "provider":
				req.Provider = "cloud"
			case "mode":
				req.Input["mode"] = "video"
			case "logical":
				req.LogicalModelID = "logical-1"
			case "seed_bool":
				req.Input["localComfy"].(map[string]any)["seed"] = true
			case "seed_fraction":
				req.Input["localComfy"].(map[string]any)["seed"] = 42.5
			case "seed_range":
				req.Input["localComfy"].(map[string]any)["seed"] = 4294967296
			case "missing_operation":
				delete(req.Input["metadata"].(map[string]any), "clientOperationId")
			case "cloud_url":
				req.Input["config"] = map[string]any{"baseUrl": "http://192.168.1.99", "apiKey": "TEST-no-secret"}
			case "unknown_local":
				req.Input["localComfy"].(map[string]any)["baseUrl"] = "http://example.invalid"
			case "unknown_root":
				req.Input["adapterUrl"] = "http://example.invalid"
			case "video_ref":
				req.Input["referenceVideos"] = []any{map[string]any{"storageKey": "resource:video"}}
			}
			if _, err := svc.CreateTask("user", req); err == nil {
				t.Fatal("invalid local selection was admitted")
			}
			if len(mock.requests) != 0 || mock.jobPosts != 0 {
				t.Fatal("invalid selection reached adapter")
			}
		})
	}
}

func TestNativeComfyTaskAdmissionPersistsAndDeduplicates(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	req := nativeComfyTaskRequest()
	first, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.CreateTask("user", req)
	if err != nil || second.ID != first.ID || first.Status != model.TaskStatusQueued || first.Provider != "local-comfy" {
		t.Fatalf("replay=%#v err=%v", second, err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 1 || mock.jobPosts != 0 {
		t.Fatalf("tasks=%d jobPOST=%d", count, mock.jobPosts)
	}
	req.Input["localComfy"].(map[string]any)["seed"] = 43
	_, err = svc.CreateTask("user", req)
	var conflict *AppError
	if !errors.As(err, &conflict) || conflict.Reason != "client_operation_id_conflict" {
		t.Fatalf("conflict = %v", err)
	}
}

func TestNativeComfyWorkerRunningThenSuccessUsesOneJob(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.taskWorker().processNextTask(); err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	if stored.Status != model.TaskStatusRunning || stored.ProviderRequestID != "44444444444444444444444444444444" || mock.jobPosts != 1 || mock.jobSeed != 42 || mock.jobPrompt != task.Prompt {
		t.Fatalf("running=%#v jobPOST=%d", stored, mock.jobPosts)
	}
	mock.complete = true
	db.Model(&model.Task{}).Where("id = ?", task.ID).Update("next_poll_at", nil)
	if err := svc.taskWorker().processNextTask(); err != nil {
		t.Fatal(err)
	}
	stored, _ = svc.repo.Task(task.ID)
	if stored.Status != model.TaskStatusSucceeded || mock.jobPosts != 1 || !strings.Contains(stored.ResultJSON, "resource:") {
		t.Fatalf("success=%#v jobPOST=%d", stored, mock.jobPosts)
	}
	var count int64
	db.Model(&model.Resource{}).Count(&count)
	if count != 1 {
		t.Fatalf("resource count=%d", count)
	}
	replayed, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil || replayed.ID != task.ID {
		t.Fatalf("completed replay=%#v %v", replayed, err)
	}
	summary := taskSummaryForOutput(*stored)
	if summary.PreviewURL == "" || summary.ClientContext == nil || summary.ClientContext.NodeID != "TEST-node-1" {
		t.Fatalf("TaskCenter summary=%#v", summary)
	}
}

func TestNativeComfyRecoverArchivedHistoryWhileGenerationDisabled(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	req := nativeComfyTaskRequest()
	task, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	mock.enabled = false
	projectID, shotID, _, err := svc.ensureLocalComfyObjects(context.Background(), "user", "", task.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	job := localComfyJob{ID: "44444444444444444444444444444444", ProjectID: projectID, ShotID: shotID, RecipeID: "qwen_image_2_1", Status: "completed", PromptID: "historical-mock-prompt", Key: "native:" + task.ID}
	mock.jobs[job.ID] = job
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "provider_request_id": job.ID})
	requestsBeforeRecovery := len(mock.requests)
	for iteration := 0; iteration < 2; iteration++ {
		stored, _ := svc.repo.Task(task.ID)
		if iteration == 1 {
			stored.Status = model.TaskStatusFailed
			db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusFailed)
		}
		recovery, err := svc.QueryFailedVideoTask(context.Background(), "user", task.ID)
		if err != nil || !recovery.Recovered || recovery.Task.Status != model.TaskStatusSucceeded {
			t.Fatalf("recovery=%#v err=%v", recovery, err)
		}
	}
	var count int64
	db.Model(&model.Resource{}).Count(&count)
	if mock.jobPosts != 0 || mock.retryPosts != 0 || count != 1 || mock.contentReads != 1 {
		t.Fatalf("recovery resubmitted/redownloaded: jobPOST=%d retry=%d resources=%d contentReads=%d", mock.jobPosts, mock.retryPosts, count, mock.contentReads)
	}
	for _, request := range mock.requests[requestsBeforeRecovery:] {
		if request == "GET /config" || request == "GET /recipes" {
			continue
		}
		if strings.HasPrefix(request, "POST /projects") || request == "POST /jobs" {
			t.Fatalf("recovery mutation=%s", request)
		}
	}
}

func TestNativeComfyUnknownSubmissionNeverResubmitsOnRestore(t *testing.T) {
	svc, mock, _ := newNativeComfyTestService(t)
	mock.unknown = true
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	for iteration := 0; iteration < 2; iteration++ {
		_, _, err := svc.processTask(context.Background(), *stored)
		var uncertain providerSubmissionUnknownError
		if !errors.As(err, &uncertain) {
			t.Fatalf("expected unknown outcome, got %v", err)
		}
		stored, _ = svc.repo.Task(task.ID)
	}
	if mock.jobPosts != 1 || stored.ProviderRequestID == "" {
		t.Fatalf("unknown replay jobPOST=%d task=%#v", mock.jobPosts, stored)
	}
	if err := svc.prepareLocalComfyRetry(stored, nativeComfyTaskRequest().Input); err == nil {
		t.Fatal("unknown submission became retryable")
	}
}

func TestNativeComfyRestoresCommittedJobBeforeProviderIDWasSaved(t *testing.T) {
	svc, mock, _ := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	_, _, err = svc.processTask(context.Background(), *stored)
	var pending localComfyPendingError
	if !errors.As(err, &pending) {
		t.Fatalf("pending=%v", err)
	}
	svc.repo.UpdateTaskProviderState(task.ID, "", "", nil)
	// Simulate the process dying in the narrow gap before job ID persistence.
	stored.ProviderRequestID = ""
	_, _, err = svc.processTask(context.Background(), *stored)
	if !errors.As(err, &pending) || mock.jobPosts != 1 || len(mock.projects) != 1 || len(mock.shots) != 1 {
		t.Fatalf("restore err=%v jobPOST=%d project=%d shot=%d", err, mock.jobPosts, len(mock.projects), len(mock.shots))
	}
}

func TestNativeComfyRejectsForeignURLAndInlineReferences(t *testing.T) {
	for _, reference := range []providerMedia{{URL: "http://192.168.10.106/private.png"}, {DataURL: "data:image/png;base64,TEST"}, {StorageKey: "resource:foreign"}, {StorageKey: "file:C:/private.png"}} {
		svc, mock, db := newNativeComfyTestService(t)
		db.Create(&model.Resource{ID: "foreign", UserID: "another-user", Provider: "local", Kind: "image", Status: model.ResourceStatusReady})
		req := nativeComfyTaskRequest()
		req.Input["referenceImages"] = []providerMedia{reference}
		if _, err := svc.CreateTask("user", req); err == nil || len(mock.requests) != 0 {
			t.Fatalf("foreign reference admitted: err=%v", err)
		}
	}
}

func TestNativeComfyI2VUsesActualOwnedReferenceBytes(t *testing.T) {
	svc, mock, _ := newNativeComfyTestService(t)
	png := nativeComfyTestPNG()
	resource, _, err := svc.storeResource("user", "image", "TEST-first-frame.png", "image/png", int64(len(png)), 1, 1, 0, bytes.NewReader(png), nil, true)
	if err != nil {
		t.Fatal(err)
	}
	req := nativeComfyTaskRequest()
	req.Type, req.Model = "canvas_video", "local-comfy:h3_i2v_turbo4"
	req.Input["mode"] = "video"
	req.Input["localComfy"] = map[string]any{"recipeId": "h3_i2v_turbo4", "seed": 42}
	req.Input["referenceImages"] = []providerMedia{{StorageKey: "resource:" + resource.ID}}
	task, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	_, _, err = svc.processTask(context.Background(), *stored)
	var pending localComfyPendingError
	if !errors.As(err, &pending) || mock.jobPosts != 1 || len(mock.refs) != 1 || mock.refs[0] != "33333333333333333333333333333333" {
		t.Fatalf("I2V mapping err=%v refs=%v", err, mock.refs)
	}
}

func TestNativeComfyExplicitRetryKeepsParentAndDeduplicatesAttempt(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	_, _, _ = svc.processTask(context.Background(), *stored)
	job := mock.jobs["44444444444444444444444444444444"]
	job.Status = "failed"
	mock.jobs[job.ID] = job
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "provider_request_id": job.ID})
	retired, err := svc.RetryTask("user", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retired.ID != task.ID || retired.Status != model.TaskStatusQueued {
		t.Fatalf("native retry=%#v", retired)
	}
	if _, err := svc.RetryTask("user", task.ID); err == nil {
		t.Fatal("double native retry admitted")
	}
	stored, _ = svc.repo.Task(task.ID)
	for iteration := 0; iteration < 2; iteration++ {
		_, _, _ = svc.processTask(context.Background(), *stored)
	}
	if mock.retryPosts != 1 || mock.jobPosts != 1 {
		t.Fatalf("retry POSTS=%d original=%d", mock.retryPosts, mock.jobPosts)
	}
}

func TestNativeComfyCancellationNeverInterruptsComfy(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusCancelled, "provider_request_id": "44444444444444444444444444444444"})
	stored, _ := svc.repo.Task(task.ID)
	requestsBefore := len(mock.requests)
	if err := svc.requestProviderCancellation(context.Background(), stored); err != nil {
		t.Fatal(err)
	}
	stored, _ = svc.repo.Task(task.ID)
	if stored.ProviderCancelStatus != model.ProviderCancelStatusUncertain || !strings.Contains(stored.ProviderCancelError, "仅停止原生任务跟踪") || len(mock.requests) != requestsBefore {
		t.Fatalf("cancel=%#v requests=%v", stored, mock.requests)
	}
}

func TestNativeComfyPublicInputRetainsOnlySafeRecipeAndResourceIdentity(t *testing.T) {
	raw := `{"mode":"image","localComfy":{"recipeId":"qwen_image_2_1","seed":42,"url":"http://private"},"referenceImages":[{"storageKey":"resource:one","url":"http://private","dataUrl":"data:image/png;base64,private"}],"metadata":{"nodeId":"one"}}`
	public := publicTaskInputJSON(raw)
	if !strings.Contains(public, "qwen_image_2_1") || !strings.Contains(public, "resource:one") || strings.Contains(public, "private") {
		t.Fatalf("public input=%s", public)
	}
}

func TestNativeComfyProjectAndMetadataMustBelongToActor(t *testing.T) {
	for _, name := range []string{"foreign_project", "missing_project", "foreign_canvas", "foreign_domain", "missing_chapter", "missing_shot", "owned_project", "owned_canvas"} {
		t.Run(name, func(t *testing.T) {
			svc, mock, db := newNativeComfyTestService(t)
			db.Create(&model.Project{ID: "owned", UserID: "user", Status: model.ProjectStatusActive})
			db.Create(&model.Project{ID: "foreign", UserID: "another-user", Status: model.ProjectStatusActive})
			db.Create(&model.CanvasProject{ID: "owned-canvas", UserID: "user", ProjectID: "owned"})
			db.Create(&model.CanvasProject{ID: "foreign-canvas", UserID: "another-user", ProjectID: "foreign"})
			req := nativeComfyTaskRequest()
			metadata := req.Input["metadata"].(map[string]any)
			switch name {
			case "foreign_project":
				req.ProjectID = "foreign"
			case "missing_project":
				req.ProjectID = "missing"
			case "foreign_canvas":
				req.ProjectID = "foreign-canvas"
			case "foreign_domain":
				metadata["domainProjectId"] = "foreign"
			case "missing_chapter":
				metadata["domainProjectId"], metadata["chapterId"] = "owned", "missing"
			case "missing_shot":
				metadata["domainProjectId"], metadata["shotId"] = "owned", "missing"
			case "owned_project":
				req.ProjectID = "owned"
			case "owned_canvas":
				req.ProjectID = "owned-canvas"
			}
			_, err := svc.CreateTask("user", req)
			if strings.HasPrefix(name, "owned_") {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || len(mock.requests) != 0 {
				t.Fatalf("foreign association reached adapter: err=%v requests=%v", err, mock.requests)
			}
		})
	}
}

func TestNativeComfyLostReplyRecoveryFindsCommittedJobWithOnlyReads(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	_, _, _ = svc.processTask(context.Background(), *stored)
	job := mock.jobs["44444444444444444444444444444444"]
	job.Status = "completed"
	mock.jobs[job.ID] = job
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "stage": "submission_unknown", "provider_request_id": ""})
	mock.enabled = false
	before := len(mock.requests)
	recovery, err := svc.QueryFailedVideoTask(context.Background(), "user", task.ID)
	if err != nil || !recovery.Recovered || recovery.Task.ProviderRequestID != job.ID {
		t.Fatalf("lost reply recovery=%#v err=%v", recovery, err)
	}
	for _, request := range mock.requests[before:] {
		if strings.HasPrefix(request, "POST ") && request != "POST /jobs/"+job.ID+"/archive" {
			t.Fatalf("recovery created/submitted state: %s", request)
		}
	}
	if mock.jobPosts != 1 {
		t.Fatalf("jobPOST=%d", mock.jobPosts)
	}
}

func TestNativeComfyMissingLostReplyRecoveryNeverCreatesObjects(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "stage": "submission_unknown"})
	before := len(mock.requests)
	_, err = svc.QueryFailedVideoTask(context.Background(), "user", task.ID)
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Reason != "submission_unknown" {
		t.Fatalf("recovery=%v", err)
	}
	for _, request := range mock.requests[before:] {
		if !strings.HasPrefix(request, "GET ") {
			t.Fatalf("missing recovery mutated state=%s", request)
		}
	}
	if mock.jobPosts != 0 || len(mock.projects) != 0 || len(mock.shots) != 0 {
		t.Fatal("missing unknown job was recreated")
	}
}

func TestNativeComfyResumedJobMustMatchActorProjectAndTaskShot(t *testing.T) {
	for _, name := range []string{"returned_id", "foreign_project", "foreign_shot", "request_key", "recipe"} {
		t.Run(name, func(t *testing.T) {
			svc, mock, db := newNativeComfyTestService(t)
			task, err := svc.CreateTask("user", nativeComfyTaskRequest())
			if err != nil {
				t.Fatal(err)
			}
			stored, _ := svc.repo.Task(task.ID)
			_, _, _ = svc.processTask(context.Background(), *stored)
			id := "44444444444444444444444444444444"
			job := mock.jobs[id]
			job.Status = "completed"
			switch name {
			case "returned_id":
				job.ID = "77777777777777777777777777777777"
			case "foreign_project":
				mock.projects[0].Upstream = "native:another-user"
			case "foreign_shot":
				mock.shots[0].Upstream = "another-task"
			case "request_key":
				job.Key = "native:another-task"
			case "recipe":
				job.RecipeID = "other_recipe"
			}
			mock.jobs[id] = job
			db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "provider_request_id": id})
			before := len(mock.requests)
			if _, err := svc.QueryFailedVideoTask(context.Background(), "user", task.ID); err == nil {
				t.Fatal("misbound job recovered")
			}
			for _, request := range mock.requests[before:] {
				if strings.HasPrefix(request, "POST ") {
					t.Fatalf("misbound job polled or archived: %s", request)
				}
			}
		})
	}
}

func TestNativeComfyPollAndArchiveCannotSwitchJobIdentity(t *testing.T) {
	for _, action := range []string{"poll", "archive"} {
		t.Run(action, func(t *testing.T) {
			svc, mock, _ := newNativeComfyTestService(t)
			mock.complete, mock.faultAction = true, action
			task, err := svc.CreateTask("user", nativeComfyTaskRequest())
			if err != nil {
				t.Fatal(err)
			}
			stored, _ := svc.repo.Task(task.ID)
			_, _, err = svc.processTask(context.Background(), *stored)
			var appErr *AppError
			if !errors.As(err, &appErr) || appErr.Reason != "adapter_job_binding_mismatch" || mock.contentReads != 0 {
				t.Fatalf("misbound %s err=%v contentReads=%d", action, err, mock.contentReads)
			}
		})
	}
}

func TestNativeComfyGenerationClosedAfterAdmissionDoesNotCreateSidecarObjects(t *testing.T) {
	svc, mock, _ := newNativeComfyTestService(t)
	task, err := svc.CreateTask("user", nativeComfyTaskRequest())
	if err != nil {
		t.Fatal(err)
	}
	mock.enabled = false
	stored, _ := svc.repo.Task(task.ID)
	_, _, err = svc.processTask(context.Background(), *stored)
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Reason != "generation_disabled" || len(mock.projects) != 0 || len(mock.shots) != 0 || mock.jobPosts != 0 {
		t.Fatalf("closed worker err=%v objects=%d/%d jobPOST=%d", err, len(mock.projects), len(mock.shots), mock.jobPosts)
	}
}

func TestNativeComfyVideoResultUsesOriginalNativeResourceContract(t *testing.T) {
	svc, mock, db := newNativeComfyTestService(t)
	data := nativeComfyTestPNG()
	resource, _, err := svc.storeResource("user", "image", "TEST-first-frame.png", "image/png", int64(len(data)), 1, 1, 0, bytes.NewReader(data), nil, true)
	if err != nil {
		t.Fatal(err)
	}
	req := nativeComfyTaskRequest()
	req.Type, req.Model = "canvas_video", "local-comfy:h3_i2v_turbo4"
	req.Input["mode"] = "video"
	req.Input["localComfy"] = map[string]any{"recipeId": "h3_i2v_turbo4", "seed": 42}
	req.Input["referenceImages"] = []providerMedia{{StorageKey: "resource:" + resource.ID}}
	mock.complete, mock.resultMime = true, "video/mp4"
	task, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.taskWorker().processNextTask(); err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	if stored.Status != model.TaskStatusSucceeded || !strings.Contains(stored.ResultJSON, `"video"`) || !strings.Contains(stored.ResultJSON, "resource:") {
		t.Fatalf("video result=%#v", stored)
	}
	var count int64
	db.Model(&model.Resource{}).Where("kind = ?", "video").Count(&count)
	if count != 1 || taskSummaryForOutput(*stored).PreviewKind != "video" || mock.jobPosts != 1 {
		t.Fatalf("video resources=%d jobPOST=%d", count, mock.jobPosts)
	}
}

func TestNativeComfyProjectDefaultsPersistExistingColumns(t *testing.T) {
	svc, db := newProjectSettingsTestService(t)
	if err := db.Create(&model.Project{ID: "TEST-local-defaults", UserID: "user", Name: "TEST local defaults", Status: model.ProjectStatusActive, Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	image, video := "local-comfy:qwen_image_2_1_preview512", "local-comfy:h3_i2v_turbo4"
	updated, err := svc.UpdateProject("user", "TEST-local-defaults", UpdateProjectRequest{DefaultImageModel: &image, DefaultVideoModel: &video})
	if err != nil {
		t.Fatal(err)
	}
	var persisted model.Project
	if err := db.First(&persisted, "id = ?", updated.ID).Error; err != nil {
		t.Fatal(err)
	}
	if persisted.DefaultImageModel != image || persisted.DefaultVideoModel != video {
		t.Fatalf("saved defaults=%q/%q", persisted.DefaultImageModel, persisted.DefaultVideoModel)
	}
	if _, err := svc.UpdateProject("another-user", updated.ID, UpdateProjectRequest{DefaultImageModel: &image}); err == nil {
		t.Fatal("foreign default model update admitted")
	}
}

func TestNativeComfyNewTaskRedoRejectsActiveUnknownAndForeignParents(t *testing.T) {
	for _, name := range []string{"queued", "running", "submission_unknown", "poll_unknown", "cancelling", "cancel_uncertain", "cancelled", "failed_no_job", "foreign_actor", "foreign_recipe", "foreign_type", "cloud_parent"} {
		t.Run(name, func(t *testing.T) {
			svc, mock, db := newNativeComfyTestService(t)
			original := nativeComfyTaskRequest()
			encoded, _ := json.Marshal(original.Input)
			parent := model.Task{ID: localComfyTaskID("user", "TEST-parent-op"), UserID: "user", Type: original.Type, Prompt: original.Prompt, Provider: "local-comfy", Model: original.Model, Status: model.TaskStatusFailed, InputJSON: string(encoded)}
			switch name {
			case "queued":
				parent.Status = model.TaskStatusQueued
			case "running":
				parent.Status = model.TaskStatusRunning
			case "submission_unknown":
				parent.Stage = "submission_unknown"
			case "poll_unknown":
				parent.PollStage = "submission_unknown"
			case "cancelling":
				parent.ProviderCancelStatus = model.ProviderCancelStatusRequested
			case "cancel_uncertain":
				parent.ProviderCancelStatus = model.ProviderCancelStatusUncertain
			case "cancelled":
				parent.Status = model.TaskStatusCancelled
			case "foreign_actor":
				parent.UserID = "another-user"
			case "foreign_recipe":
				parent.Status, parent.Model = model.TaskStatusSucceeded, "local-comfy:qwen_image_2_1_preview512"
			case "foreign_type":
				parent.Type = "canvas_video"
			case "cloud_parent":
				parent.Status, parent.InputJSON, parent.Model = model.TaskStatusSucceeded, `{"mode":"image","config":{"channelId":"cloud"}}`, "cloud-model"
			}
			if err := db.Create(&parent).Error; err != nil {
				t.Fatal(err)
			}
			req := nativeComfyTaskRequest()
			metadata := req.Input["metadata"].(map[string]any)
			metadata["clientOperationId"], metadata["retryOf"] = "TEST-explicit-redo", parent.ID
			if _, err := svc.CreateTask("user", req); err == nil {
				t.Fatal("unsafe parent was redone")
			}
			if len(mock.requests) != 0 || mock.jobPosts != 0 || len(mock.shots) != 0 {
				t.Fatalf("unsafe redo reached adapter: requests=%v", mock.requests)
			}
			var count int64
			db.Model(&model.Task{}).Count(&count)
			if count != 1 {
				t.Fatalf("unsafe redo admitted new task: count=%d", count)
			}
		})
	}
}

func TestNativeComfyNewTaskRedoAllowsCompletedVersionAndKnownFailedParent(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskStatusSucceeded, model.TaskStatusFailed} {
		t.Run(string(status), func(t *testing.T) {
			svc, mock, db := newNativeComfyTestService(t)
			req := nativeComfyTaskRequest()
			encoded, _ := json.Marshal(req.Input)
			parent := model.Task{ID: localComfyTaskID("user", "TEST-parent-op"), UserID: "user", Type: req.Type, Prompt: req.Prompt, Provider: "local-comfy", Model: req.Model, Status: status, InputJSON: string(encoded)}
			if status == model.TaskStatusFailed {
				parent.ProviderRequestID = "44444444444444444444444444444444"
				mock.projects = []localComfyProject{{ID: "11111111111111111111111111111111", Upstream: "native:" + localComfyTaskID("user", "")}}
				mock.shots = []localComfyShot{{ID: "22222222222222222222222222222222", ProjectID: mock.projects[0].ID, Upstream: parent.ID}}
				mock.jobs[parent.ProviderRequestID] = localComfyJob{ID: parent.ProviderRequestID, ProjectID: mock.projects[0].ID, ShotID: mock.shots[0].ID, RecipeID: "qwen_image_2_1", Key: "native:" + parent.ID, Status: "failed"}
			}
			if err := db.Create(&parent).Error; err != nil {
				t.Fatal(err)
			}
			metadata := req.Input["metadata"].(map[string]any)
			metadata["clientOperationId"], metadata["retryOf"] = "TEST-explicit-redo", parent.ID
			first, err := svc.CreateTask("user", req)
			if err != nil {
				t.Fatal(err)
			}
			second, err := svc.CreateTask("user", req)
			if err != nil || second.ID != first.ID || first.ID == parent.ID {
				t.Fatalf("redo replay=%#v err=%v", second, err)
			}
			if mock.jobPosts != 0 || mock.retryPosts != 0 {
				t.Fatal("redo admission submitted a GPU job")
			}
			var count int64
			db.Model(&model.Task{}).Count(&count)
			if count != 2 {
				t.Fatalf("redo tasks=%d", count)
			}
		})
	}
}

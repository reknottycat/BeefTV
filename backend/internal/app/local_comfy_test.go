package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/localcomfy"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type nativeComfyFixture struct {
	t                                  *testing.T
	s                                  *Service
	db                                 *gorm.DB
	task                               model.Task
	recipe                             localcomfy.Recipe
	job                                localcomfy.Job
	data                               []byte
	enabled                            bool
	pending                            bool
	jobPosts, otherPosts, contentLoads int
	onSubmit, onContent                func()
}

const nativeProjectID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const nativeShotID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const nativeJobID = "cccccccccccccccccccccccccccccccc"
const nativeAssetID = "dddddddddddddddddddddddddddddddd"

func nativeComfyTestFixture(t *testing.T) *nativeComfyFixture {
	t.Helper()
	allowLoopbackProviderTest(t)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "native.db")+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.LocalModels()...); err != nil {
		t.Fatal(err)
	}
	s := &Service{repo: repository.New(db), dataDir: t.TempDir(), mode: serviceModeLocal, localResourceStorage: true, activeCancels: map[string]context.CancelFunc{}}
	f := &nativeComfyFixture{t: t, s: s, db: db, enabled: true, recipe: localcomfy.Recipe{ID: "custom-studio", Version: strings.Repeat("a", 64), Mode: "t2i", Ready: true, Output: localcomfy.Output{Width: 2, Height: 1}}}
	if err := db.Create(&model.CanvasProject{ID: "canvas", UserID: "owner", PayloadJSON: `{"nodes":[],"edges":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 1))); err != nil {
		t.Fatal(err)
	}
	f.data = data.Bytes()
	server := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(server.Close)
	if err := s.ConfigureLocalComfy(server.URL, "private-fixture-token"); err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *nativeComfyFixture) request(key string) CreateTaskRequest {
	return CreateTaskRequest{ProjectID: "canvas", Type: "canvas_" + f.recipe.NativeMode(), Prompt: "a landscape", Provider: "local-comfy", Model: localcomfy.ModelPrefix + f.recipe.ID, Input: map[string]any{"mode": f.recipe.NativeMode(), "prompt": "a landscape", "config": map[string]any{}, "localComfy": map[string]any{"recipeId": f.recipe.ID, "recipeVersion": f.recipe.Version, "seed": 7}, "metadata": map[string]any{"clientOperationId": key}}}
}
func (f *nativeComfyFixture) admit() model.Task {
	f.t.Helper()
	task, err := f.s.CreateTask("owner", f.request("native-once"))
	if err != nil {
		f.t.Fatal(err)
	}
	stored, err := f.s.repo.TaskForUser("owner", task.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	f.task = *stored
	return f.task
}
func (f *nativeComfyFixture) running(jobID string) model.Task {
	f.t.Helper()
	f.admit()
	until := time.Now().Add(time.Hour)
	if err := f.db.Model(&model.Task{}).Where("id = ?", f.task.ID).Updates(map[string]any{"status": model.TaskStatusRunning, "lease_owner": "worker-a", "lease_expires_at": until, "provider_request_id": jobID}).Error; err != nil {
		f.t.Fatal(err)
	}
	f.task, _ = f.latest()
	return f.task
}
func (f *nativeComfyFixture) latest() (model.Task, error) {
	task, err := f.s.repo.TaskForUser("owner", f.task.ID)
	if err != nil {
		return model.Task{}, err
	}
	return *task, nil
}
func (f *nativeComfyFixture) committed(status string) {
	f.job = localcomfy.Job{ID: nativeJobID, ProjectID: nativeProjectID, ShotID: nativeShotID, RecipeID: f.recipe.ID, Version: f.recipe.Version, Key: "native:" + f.task.ID, Status: status, Assets: []string{nativeAssetID}}
}
func (f *nativeComfyFixture) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer private-fixture-token" {
		f.t.Error("missing adapter deployment credential")
	}
	respond := func(value any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": value})
	}
	if r.Method == http.MethodPost {
		if r.URL.Path == "/jobs" {
			f.jobPosts++
		} else {
			f.otherPosts++
		}
	}
	project := localcomfy.Project{ID: nativeProjectID, Upstream: localcomfy.ProjectIdentity("owner", "canvas"), CanvasID: "canvas"}
	shot := localcomfy.Shot{ID: nativeShotID, ProjectID: nativeProjectID, Upstream: f.task.ID}
	switch r.URL.Path {
	case "/config":
		respond(localcomfy.Config{GenerationEnabled: f.enabled, RecipeCount: 1, MaxReferenceBytes: 10 << 20})
	case "/recipes":
		respond([]localcomfy.Recipe{f.recipe})
	case "/projects":
		respond([]localcomfy.Project{project})
	case "/projects/" + nativeProjectID:
		respond(project)
	case "/shots":
		respond([]localcomfy.Shot{shot})
	case "/shots/" + nativeShotID:
		respond(shot)
	case "/assets":
		respond([]localcomfy.Asset{})
	case "/jobs":
		if r.Method == http.MethodPost {
			f.committed("submitted")
			if f.onSubmit != nil {
				f.onSubmit()
			}
			respond(f.job)
		} else if f.job.ID != "" {
			respond([]localcomfy.Job{f.job})
		} else {
			respond([]localcomfy.Job{})
		}
	case "/jobs/" + nativeJobID:
		respond(f.job)
	case "/jobs/" + nativeJobID + "/poll":
		if f.pending {
			f.job.Status = "running"
		} else {
			f.job.Status = "completed"
		}
		respond(f.job)
	case "/jobs/" + nativeJobID + "/archive":
		respond(f.job)
	case "/assets/" + nativeAssetID:
		sum := sha256.Sum256(f.data)
		respond(localcomfy.Asset{ID: nativeAssetID, ProjectID: nativeProjectID, JobID: nativeJobID, Size: int64(len(f.data)), MimeType: http.DetectContentType(f.data), SHA256: hex.EncodeToString(sum[:]), Width: 2, Height: 1})
	case "/assets/" + nativeAssetID + "/content":
		f.contentLoads++
		if f.onContent != nil {
			f.onContent()
		}
		w.Header().Set("Content-Type", http.DetectContentType(f.data))
		_, _ = w.Write(f.data)
	default:
		f.t.Errorf("unexpected adapter request: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}
}

func TestNativeComfyCancelThenRecoverOriginalJob(t *testing.T) {
	for _, ack := range []bool{true, false} {
		t.Run(map[bool]string{true: "with-job-id", false: "lost-ack"}[ack], func(t *testing.T) {
			f := nativeComfyTestFixture(t)
			id := ""
			if ack {
				id = nativeJobID
			}
			f.running(id)
			f.committed("submitted")
			cancelled, err := f.s.CancelTask(context.Background(), "owner", f.task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if cancelled.Status != model.TaskStatusCancelled || cancelled.ProviderCancelStatus != model.ProviderCancelStatusUncertain || !strings.Contains(cancelled.Error, "GPU") {
				t.Fatalf("incorrect cancellation: %#v", cancelled)
			}
			if f.jobPosts != 0 || f.otherPosts != 0 {
				t.Fatal("cancel sent upstream mutation")
			}
			if _, err := f.s.RetryTask("owner", f.task.ID); err == nil {
				t.Fatal("cancelled original job allowed retry")
			}
			redo := f.request("redo-cancelled")
			redo.Input["metadata"].(map[string]any)["retryOf"] = f.task.ID
			if _, err := f.s.CreateTask("owner", redo); err == nil {
				t.Fatal("cancelled original job allowed new task")
			}
			f.enabled = false
			if _, err := f.s.QueryFailedVideoTask(context.Background(), "other-owner", f.task.ID); err == nil {
				t.Fatal("foreign owner recovered task")
			}
			result, err := f.s.QueryFailedVideoTask(context.Background(), "owner", f.task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Recovered || result.Task.Status != model.TaskStatusSucceeded || f.jobPosts != 0 || f.contentLoads != 1 {
				t.Fatalf("original result not recovered: %#v jobs=%d loads=%d", result, f.jobPosts, f.contentLoads)
			}
			var resources []model.Resource
			if err := f.db.Find(&resources).Error; err != nil {
				t.Fatal(err)
			}
			if len(resources) != 1 || resources[0].UserID != "owner" || resources[0].Status != model.ResourceStatusReady {
				t.Fatalf("bad native resource: %#v", resources)
			}
			if strings.Contains(result.Task.InputJSON, "private-fixture") || strings.Contains(result.Task.InputJSON, "_retryKey") {
				t.Fatal("private execution details exposed")
			}
		})
	}
}
func TestNativeComfyCancelWhileSubmissionAcknowledgementInFlight(t *testing.T) {
	f := nativeComfyTestFixture(t)
	claimed := f.running("")
	f.onSubmit = func() {
		if _, err := f.s.CancelTask(context.Background(), "owner", claimed.ID); err != nil {
			t.Error(err)
		}
	}
	_, _, err := f.s.processTask(context.Background(), claimed)
	var unknown generation.SubmissionUnknownError
	if !errors.As(err, &unknown) {
		t.Fatalf("lost lease after POST should remain unknown: %v", err)
	}
	stored, _ := f.latest()
	if stored.Status != model.TaskStatusCancelled || stored.ProviderRequestID != "" || stored.PollStage != "submitting" {
		t.Fatalf("late ack overwrote cancelled row: %#v", stored)
	}
	f.enabled = false
	result, err := f.s.QueryFailedVideoTask(context.Background(), "owner", claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Recovered || f.jobPosts != 1 {
		t.Fatal("cancelled in-flight job was lost or duplicated")
	}
}
func TestNativeComfyMissingUnknownJobRemainsReadOnly(t *testing.T) {
	f := nativeComfyTestFixture(t)
	f.running("")
	if err := f.db.Model(&model.Task{}).Where("id = ?", f.task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "stage": "submission_unknown", "poll_stage": "submitting", "lease_owner": "", "lease_expires_at": nil}).Error; err != nil {
		t.Fatal(err)
	}
	_, err := f.s.QueryFailedVideoTask(context.Background(), "owner", f.task.ID)
	var unknown generation.SubmissionUnknownError
	if !errors.As(err, &unknown) || f.jobPosts != 0 || f.otherPosts != 0 {
		t.Fatalf("unsafe unknown recovery: %v", err)
	}
	if _, err := f.s.RetryTask("owner", f.task.ID); err == nil {
		t.Fatal("unknown task retried")
	}
}
func TestNativeComfyOldWorkerCannotBorrowReplacementLease(t *testing.T) {
	f := nativeComfyTestFixture(t)
	claimed := f.running("")
	if err := f.db.Model(&model.Task{}).Where("id = ?", claimed.ID).Update("lease_owner", "worker-b").Error; err != nil {
		t.Fatal(err)
	}
	_, _, err := f.s.processTask(context.Background(), claimed)
	if !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("stale worker accepted: %v", err)
	}
	if f.jobPosts != 0 {
		t.Fatal("stale worker submitted")
	}
}
func TestNativeComfyOldRecoveryCannotBorrowReplacementLease(t *testing.T) {
	f := nativeComfyTestFixture(t)
	f.running(nativeJobID)
	f.committed("completed")
	if _, err := f.s.CancelTask(context.Background(), "owner", f.task.ID); err != nil {
		t.Fatal(err)
	}
	f.onContent = func() {
		if err := f.db.Model(&model.Task{}).Where("id = ?", f.task.ID).Update("lease_owner", "manual-recovery:replacement").Error; err != nil {
			t.Error(err)
		}
	}
	_, err := f.s.QueryFailedVideoTask(context.Background(), "owner", f.task.ID)
	if !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("stale recovery completed: %v", err)
	}
	stored, _ := f.latest()
	if stored.Status != model.TaskStatusCancelled || stored.LeaseOwner != "manual-recovery:replacement" {
		t.Fatalf("stale recovery overwrote new owner: %#v", stored)
	}
}
func TestNativeComfyAdmissionReplayAndDefiniteFailedRetry(t *testing.T) {
	f := nativeComfyTestFixture(t)
	f.running(nativeJobID)
	f.committed("running")
	if err := f.db.Model(&model.Task{}).Where("id = ?", f.task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "lease_owner": "", "lease_expires_at": nil, "error": "本地作业明确失败，可显式重做", "poll_stage": "failed"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RetryTask("owner", f.task.ID); err == nil {
		t.Fatal("remote active job retried")
	}
	f.job.Status = "failed"
	retried, err := f.s.RetryTask("owner", f.task.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := f.latest()
	var input generation.Input
	_ = json.Unmarshal([]byte(stored.InputJSON), &input)
	if retried.Status != model.TaskStatusQueued || input.LocalComfy.RetryJobID != nativeJobID || input.LocalComfy.RetryKey == "" {
		t.Fatalf("retry lacks stable lineage: %#v", input.LocalComfy)
	}
	again, err := f.s.CreateTask("owner", f.request("native-once"))
	if err != nil || again.ID != f.task.ID {
		t.Fatalf("operation replay lost original task: %v", err)
	}
	if f.jobPosts != 0 {
		t.Fatal("admission or retry dispatched GPU")
	}
}
func TestNativeComfyWorkerDefersOriginalPendingJob(t *testing.T) {
	f := nativeComfyTestFixture(t)
	f.admit()
	f.committed("submitted")
	f.pending = true
	if err := f.s.taskWorker().processNextTask(); err != nil {
		t.Fatal(err)
	}
	stored, _ := f.latest()
	if stored.Status != model.TaskStatusRunning || stored.LeaseOwner != "" || stored.ProviderRequestID != nativeJobID || stored.NextPollAt == nil {
		t.Fatalf("pending job not scheduled for original-job poll: %#v", stored)
	}
	if f.jobPosts != 0 {
		t.Fatal("worker duplicated known pending job")
	}
}

func TestNativeComfyMP4RecoveryChecksApprovedMediaMetadata(t *testing.T) {
	for _, duration := range []int64{2000, 4000} {
		t.Run(map[int64]string{2000: "matching", 4000: "duration-mismatch"}[duration], func(t *testing.T) {
			f := nativeComfyTestFixture(t)
			f.recipe.Mode = "t2v"
			f.recipe.Output.MimeType = "video/mp4"
			f.recipe.Output.FPS = 24
			f.recipe.Output.DurationSeconds = 2
			f.data = syntheticVideoMP4(2, 1, duration)
			copy(f.data[8:12], "mp42")
			f.running(nativeJobID)
			f.committed("completed")
			if _, err := f.s.CancelTask(context.Background(), "owner", f.task.ID); err != nil {
				t.Fatal(err)
			}
			result, err := f.s.QueryFailedVideoTask(context.Background(), "owner", f.task.ID)
			if duration == 2000 {
				if err != nil || !result.Recovered {
					t.Fatalf("valid MP4 not recovered: %v", err)
				}
			} else {
				if err == nil {
					t.Fatal("wrong duration accepted")
				}
				var count int64
				f.db.Model(&model.Resource{}).Count(&count)
				if count != 0 {
					t.Fatal("invalid output consumed native resource storage")
				}
			}
			if f.jobPosts != 0 {
				t.Fatal("video recovery resubmitted")
			}
		})
	}
}

package localcomfy

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
	"strings"
	"testing"
)

const testProject = "11111111111111111111111111111111"
const testShot = "22222222222222222222222222222222"
const testJob = "33333333333333333333333333333333"
const testAsset = "44444444444444444444444444444444"

type fixture struct {
	t            *testing.T
	client       *Client
	recipe       Recipe
	request      Request
	project      Project
	shot         Shot
	job          Job
	asset        Asset
	data         []byte
	paths        []string
	posts        int
	jobPosts     int
	enabled      bool
	dropAck      bool
	rejectReason string
	swapPoll     bool
	swapArchive  bool
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	f := &fixture{t: t, enabled: true, recipe: Recipe{ID: "custom-recipe", Version: strings.Repeat("a", 64), Name: "Custom", Mode: "t2i", Ready: true, Output: Output{Width: 2, Height: 1}}}
	f.request = Request{OwnerID: "owner", ProjectID: "canvas", TaskID: "native-task", Mode: "image", Prompt: "an image", Selection: Selection{RecipeID: f.recipe.ID, Version: f.recipe.Version, Recipe: &f.recipe, Seed: 42}}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 1))); err != nil {
		t.Fatal(err)
	}
	f.data = buffer.Bytes()
	sum := sha256.Sum256(f.data)
	f.asset = Asset{ID: testAsset, ProjectID: testProject, JobID: testJob, MimeType: "image/png", Size: int64(len(f.data)), SHA256: hex.EncodeToString(sum[:]), Width: 2, Height: 1}
	server := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(server.Close)
	var err error
	f.client, err = New(server.URL, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *fixture) committed(status string) {
	f.project = Project{ID: testProject, Upstream: ProjectIdentity(f.request.OwnerID, f.request.ProjectID), CanvasID: f.request.ProjectID}
	f.shot = Shot{ID: testShot, ProjectID: testProject, Upstream: f.request.TaskID}
	f.job = Job{ID: testJob, ProjectID: testProject, ShotID: testShot, RecipeID: f.recipe.ID, Version: f.recipe.Version, Key: RequestKey(f.request.TaskID, f.request.Selection), Status: status, Assets: []string{testAsset}}
}
func (f *fixture) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer test-token" {
		f.t.Error("missing deployment credential")
	}
	f.paths = append(f.paths, r.Method+" "+r.URL.Path)
	if r.Method == http.MethodPost {
		f.posts++
	}
	respond := func(value any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": value})
	}
	switch r.URL.Path {
	case "/config":
		respond(Config{GenerationEnabled: f.enabled, RecipeCount: 1, MaxReferenceBytes: 10 << 20})
	case "/recipes":
		respond([]Recipe{f.recipe})
	case "/projects":
		if r.Method == http.MethodPost {
			f.project = Project{ID: testProject, Upstream: ProjectIdentity(f.request.OwnerID, f.request.ProjectID), CanvasID: f.request.ProjectID}
			respond(f.project)
		} else if f.project.ID != "" {
			respond([]Project{f.project})
		} else {
			respond([]Project{})
		}
	case "/projects/" + testProject:
		respond(f.project)
	case "/shots":
		if r.Method == http.MethodPost {
			f.shot = Shot{ID: testShot, ProjectID: testProject, Upstream: f.request.TaskID}
			respond(f.shot)
		} else if f.shot.ID != "" {
			respond([]Shot{f.shot})
		} else {
			respond([]Shot{})
		}
	case "/shots/" + testShot:
		respond(f.shot)
	case "/assets":
		respond([]Asset{})
	case "/jobs":
		if r.Method == http.MethodPost {
			f.jobPosts++
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if payload["recipe_version"] != f.recipe.Version || payload["request_key"] != RequestKey(f.request.TaskID, f.request.Selection) {
				f.t.Error("unfrozen version or unstable key")
			}
			if f.rejectReason != "" {
				w.WriteHeader(503)
				_ = json.NewEncoder(w).Encode(map[string]any{"reason": f.rejectReason})
				return
			}
			f.committed("submitted")
			if f.dropAck {
				w.WriteHeader(503)
				_ = json.NewEncoder(w).Encode(map[string]any{"reason": "connection_lost"})
				return
			}
			respond(f.job)
		} else if f.job.ID != "" {
			respond([]Job{f.job})
		} else {
			respond([]Job{})
		}
	case "/jobs/" + testJob:
		respond(f.job)
	case "/jobs/" + testJob + "/poll":
		f.job.Status = "completed"
		copy := f.job
		if f.swapPoll {
			copy.Key = "another-key"
		}
		respond(copy)
	case "/jobs/" + testJob + "/archive":
		copy := f.job
		if f.swapArchive {
			copy.ShotID = strings.Repeat("f", 32)
		}
		respond(copy)
	case "/assets/" + testAsset:
		respond(f.asset)
	case "/assets/" + testAsset + "/content":
		w.Header().Set("Content-Type", f.asset.MimeType)
		_, _ = w.Write(f.data)
	default:
		f.t.Errorf("unexpected adapter request: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}
}

type testLedger struct {
	states       []string
	failAccepted bool
}

func (l *testLedger) Save(_ context.Context, id, status string) error {
	l.states = append(l.states, status)
	if l.failAccepted && id != "" {
		return errors.New("lease cancelled")
	}
	return nil
}

type testResources struct {
	loads int
	media Media
}

func (*testResources) Describe(string, string) (Resource, error) {
	return Resource{}, errors.New("unexpected describe")
}
func (*testResources) Read(string, string, int64) ([]byte, error) {
	return nil, errors.New("unexpected reference read")
}
func (r *testResources) Import(_ context.Context, owner, identity, mode string, asset Asset, output Output, load func() ([]byte, error)) (Media, error) {
	r.loads++
	if _, err := load(); err != nil {
		return Media{}, err
	}
	if r.media.ResourceID != "" {
		return r.media, nil
	}
	return Media{ResourceID: "owned", StorageKey: "resource:owned", MimeType: asset.MimeType, Width: 2, Height: 1, Bytes: asset.Size}, nil
}
func (f *fixture) executor() (Executor, *testLedger, *testResources) {
	ledger := &testLedger{}
	resources := &testResources{}
	return Executor{Client: f.client, Ledger: ledger, Resources: resources}, ledger, resources
}

func TestExecuteFreezesRecipeAndPreservesStableSubmission(t *testing.T) {
	f := newFixture(t)
	executor, ledger, resources := f.executor()
	result, err := executor.Execute(context.Background(), f.request)
	if err != nil {
		t.Fatal(err)
	}
	if f.jobPosts != 1 || resources.loads != 1 || result["images"] == nil || len(ledger.states) < 3 || ledger.states[0] != "submitting" {
		t.Fatalf("unexpected flow: jobs=%d ledger=%v result=%v", f.jobPosts, ledger.states, result)
	}
	f.enabled = false
	f.request.ResumeOnly = true
	if _, err := executor.Execute(context.Background(), f.request); err != nil {
		t.Fatal(err)
	}
	if f.jobPosts != 1 {
		t.Fatal("recovery resubmitted")
	}
}
func TestUnknownAcknowledgementRecoversOriginalWithSwitchOff(t *testing.T) {
	f := newFixture(t)
	executor, ledger, _ := f.executor()
	f.dropAck = true
	_, err := executor.Execute(context.Background(), f.request)
	var unknown UnknownError
	if !errors.As(err, &unknown) {
		t.Fatalf("want unknown got %v", err)
	}
	if len(ledger.states) != 1 || ledger.states[0] != "submitting" {
		t.Fatalf("missing uncertainty fence %v", ledger.states)
	}
	f.enabled = false
	f.request.ResumeOnly = true
	if _, err := executor.Execute(context.Background(), f.request); err != nil {
		t.Fatal(err)
	}
	if f.jobPosts != 1 {
		t.Fatal("unknown recovery submitted duplicate")
	}
}
func TestMissingUnknownRecoveryIsReadOnly(t *testing.T) {
	f := newFixture(t)
	executor, _, _ := f.executor()
	f.request.ResumeOnly = true
	_, err := executor.Execute(context.Background(), f.request)
	var unknown UnknownError
	if !errors.As(err, &unknown) || f.posts != 0 {
		t.Fatalf("unsafe missing recovery: %v posts=%d", err, f.posts)
	}
}
func TestCancellationAfterAcceptanceUsesOriginalKey(t *testing.T) {
	f := newFixture(t)
	executor, ledger, _ := f.executor()
	ledger.failAccepted = true
	_, err := executor.Execute(context.Background(), f.request)
	var unknown UnknownError
	if !errors.As(err, &unknown) {
		t.Fatal(err)
	}
	ledger.failAccepted = false
	f.request.ResumeOnly = true
	f.enabled = false
	if _, err := executor.Execute(context.Background(), f.request); err != nil {
		t.Fatal(err)
	}
	if f.jobPosts != 1 {
		t.Fatal("cancelled submission duplicated")
	}
}
func TestDefiniteQueuePreflightRejectionDoesNotBecomeUnknown(t *testing.T) {
	for _, reason := range []string{"comfy_unavailable", "adapter_unavailable"} {
		t.Run(reason, func(t *testing.T) {
			f := newFixture(t)
			f.rejectReason = reason
			executor, ledger, _ := f.executor()
			_, err := executor.Execute(context.Background(), f.request)
			var unknown UnknownError
			if reason == "comfy_unavailable" {
				if errors.As(err, &unknown) || ledger.states[len(ledger.states)-1] != "rejected" {
					t.Fatalf("definite rejection became unknown: %v %v", err, ledger.states)
				}
			} else if !errors.As(err, &unknown) {
				t.Fatalf("ambiguous 503 became retryable: %v", err)
			}
		})
	}
}
func TestRecipeAdmissionGateAndSemanticSnapshot(t *testing.T) {
	f := newFixture(t)
	executor, _, _ := f.executor()
	approved := f.request.Selection
	copy := *approved.Recipe
	approved.Recipe = &copy
	f.recipe.Name = "Renamed display only"
	if _, err := executor.Admit(context.Background(), "image", approved, nil); err != nil {
		t.Fatal(err)
	}
	f.recipe.Output.Width++
	if _, err := executor.Admit(context.Background(), "image", approved, nil); err == nil {
		t.Fatal("changed output accepted under frozen snapshot")
	}
	f.recipe.Version = strings.Repeat("b", 64)
	if _, err := executor.Admit(context.Background(), "image", approved, nil); err == nil {
		t.Fatal("changed version accepted")
	}
	f.enabled = false
	if _, err := executor.Admit(context.Background(), "image", approved, nil); err == nil {
		t.Fatal("disabled gate accepted")
	}
	if f.posts != 0 {
		t.Fatal("admission created objects")
	}
}
func TestRecoveryRejectsForeignBindingAndChangedJobIdentity(t *testing.T) {
	for _, kind := range []string{"owner", "project", "shot", "version", "key", "poll", "archive"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.committed("submitted")
			f.request.JobID = testJob
			executor, _, resources := f.executor()
			switch kind {
			case "owner":
				f.project.Upstream = ProjectIdentity("foreign", "canvas")
			case "project":
				f.project.CanvasID = "other"
			case "shot":
				f.shot.Upstream = "foreign-task"
			case "version":
				f.job.Version = strings.Repeat("b", 64)
			case "key":
				f.job.Key = "foreign"
			case "poll":
				f.swapPoll = true
			case "archive":
				f.swapArchive = true
			}
			if _, err := executor.Execute(context.Background(), f.request); err == nil {
				t.Fatal("foreign binding accepted")
			}
			if f.jobPosts != 0 || resources.loads != 0 {
				t.Fatal("binding rejection reached submission or resources")
			}
		})
	}
}
func TestArchivedResultRequiresIntegrityAndApprovedOutput(t *testing.T) {
	for _, kind := range []string{"hash", "size", "mime", "job", "output"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.committed("completed")
			f.request.JobID = testJob
			executor, _, resources := f.executor()
			switch kind {
			case "hash":
				f.asset.SHA256 = strings.Repeat("b", 64)
			case "size":
				f.asset.Size++
			case "mime":
				f.asset.MimeType = "image/jpeg"
			case "job":
				f.asset.JobID = strings.Repeat("f", 32)
			case "output":
				resources.media = Media{ResourceID: "bad", Width: 3, Height: 1}
			}
			if _, err := executor.Execute(context.Background(), f.request); err == nil {
				t.Fatal("invalid archive accepted")
			}
			if f.jobPosts != 0 {
				t.Fatal("invalid archive created new job")
			}
		})
	}
}
func TestClientRejectsPrivateEndpointWithoutExactAllowance(t *testing.T) {
	f := newFixture(t)
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	if _, err := f.client.Config(context.Background()); err == nil {
		t.Fatal("private endpoint accepted")
	}
	if len(f.paths) != 0 {
		t.Fatal("SSRF request dispatched")
	}
}

func TestVideoAdmissionRequiresDeclaredMP4BeforeSubmission(t *testing.T) {
	for _, mime := range []string{"", "video/webm", "video/mp4"} {
		t.Run(mime, func(t *testing.T) {
			f := newFixture(t)
			f.recipe.Mode = "t2v"
			f.recipe.Output.MimeType = mime
			f.recipe.Output.FPS = 24
			f.recipe.Output.DurationSeconds = 2
			executor, _, _ := f.executor()
			_, err := executor.Admit(context.Background(), "video", f.request.Selection, nil)
			if (err == nil) != (mime == "video/mp4") {
				t.Fatalf("unexpected MIME admission for %q: %v", mime, err)
			}
			if f.posts != 0 {
				t.Fatal("unsupported video reached submission")
			}
		})
	}
}

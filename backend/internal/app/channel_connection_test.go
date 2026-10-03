package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestChannelConnectionProviderHTTPStages(t *testing.T) {
	allowLoopbackProviderTest(t)
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Header.Get("X-Test-Api-Key") != "synthetic-provider-secret" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Tenant") != "example-tenant" {
			t.Error("authentication or business headers differ from the configured connection")
		}
		if strings.HasSuffix(r.URL.Path, "/content") {
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = io.WriteString(w, "mock-video-bytes")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"mock-task","status":"completed"}`)
	}))
	defer server.Close()
	config := providerConfig{BaseURL: server.URL + "/old/v1", APIFormat: "openai", InterfaceType: "newapi", APIKey: "synthetic-provider-secret", AuthMode: "api-key", AuthHeader: "X-Test-Api-Key", APIPathPrefix: "/gateway/v2/", Headers: []OutboundHeader{{Name: "X-Tenant", Value: "example-tenant"}}}
	ctx := context.Background()
	var payload map[string]any
	if err := postJSON(ctx, config, "/images/generations", map[string]any{"model": "mock"}, &payload); err != nil {
		t.Fatal(err)
	}
	if err := postJSONWithSubmissionKey(ctx, config, "/video/generations", map[string]any{"model": "mock"}, &payload); err != nil {
		t.Fatal(err)
	}
	if err := postForm(ctx, config, "/images/edits", "multipart/form-data; boundary=example", strings.NewReader("--example--"), &payload); err != nil {
		t.Fatal(err)
	}
	if err := getJSON(ctx, config, "/videos/mock-task", &payload); err != nil {
		t.Fatal(err)
	}
	data, mimeType, err := getBinary(ctx, config, "/videos/mock-task/content")
	if err != nil || string(data) != "mock-video-bytes" || mimeType != "video/mp4" {
		t.Fatalf("video download failed: %v", err)
	}
	_, _, err = postBinary(ctx, config, "/images/generations", map[string]any{"model": "mock"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"POST /gateway/v2/images/generations", "POST /gateway/v2/video/generations", "POST /gateway/v2/images/edits", "GET /gateway/v2/videos/mock-task", "GET /gateway/v2/videos/mock-task/content", "POST /gateway/v2/images/generations"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("stages = %v", paths)
	}
}

func TestChannelConnectionProviderDirectory(t *testing.T) {
	allowLoopbackProviderTest(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/gateway/v2/models" || r.Header.Get("X-Test-Api-Key") != "synthetic-directory-secret" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Tenant") != "example-tenant" {
			t.Error("directory connection differs from generation connection")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"mock-text","model_type":"text"}]}`)
	}))
	defer server.Close()
	items, err := (&Service{}).FetchChannelModelCatalog(context.Background(), &model.User{ID: "mock-user"}, ChannelModelsRequest{BaseURL: server.URL, APIKey: "synthetic-directory-secret", APIFormat: "openai", AuthMode: "api-key", AuthHeader: "X-Test-Api-Key", APIPathPrefix: "/gateway/v2", Headers: []OutboundHeader{{Name: "X-Tenant", Value: "example-tenant"}}})
	if err != nil || len(items) != 1 || items[0].ID != "mock-text" {
		t.Fatalf("directory failed: %v", err)
	}
}

func TestChannelConnectionProviderDefaultAndRejectedOptions(t *testing.T) {
	ctx := context.Background()
	req, err := newProviderChannelRequest(ctx, providerConfig{BaseURL: "https://mock.invalid", APIKey: "synthetic-default"}, http.MethodPost, "/chat/completions", nil)
	if err != nil || req.URL.Path != "/v1/chat/completions" || req.Header.Get("Authorization") != "Bearer synthetic-default" {
		t.Fatal("legacy Bearer or path changed")
	}
	for _, change := range []providerConfig{
		{AuthMode: "none"}, {AuthMode: "api-key", AuthHeader: "Cookie"}, {AuthMode: "api-key", AuthHeader: "X-Test-Api-Key", Headers: []OutboundHeader{{Name: "x-test-api-key", Value: "business"}}},
		{APIPathPrefix: "/a/../b"}, {APIPathPrefix: "//other.invalid"}, {APIPathPrefix: "/v1?token=invalid"},
		{AuthMode: "api-key", APIFormat: "gemini"}, {AuthMode: "api-key", InterfaceType: "xai-video"}, {AuthMode: "api-key", InterfaceType: "unknown-plugin"},
	} {
		change.BaseURL, change.APIKey = "https://mock.invalid", "synthetic-default"
		if _, err := newProviderChannelRequest(ctx, change, http.MethodPost, "/chat/completions", nil); err == nil {
			t.Fatal("invalid connection options accepted")
		}
	}
	for _, path := range []string{"/generate", "/audio/speech", "/contents/generations/tasks"} {
		if _, err := newProviderChannelRequest(ctx, providerConfig{BaseURL: "https://mock.invalid", APIKey: "synthetic", AuthMode: "api-key"}, http.MethodPost, path, nil); err == nil {
			t.Fatal("custom auth authorized a nonstandard endpoint")
		}
	}
}

func TestChannelConnectionMediaPreservesPathAndDoesNotSendExternalCredentials(t *testing.T) {
	allowLoopbackProviderTest(t)
	var ownPath string
	own := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ownPath = r.URL.RequestURI()
		if r.Header.Get("X-Test-Api-Key") != "synthetic-media-secret" || r.Header.Get("Authorization") != "" {
			t.Error("same-origin media auth missing")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = io.WriteString(w, "same-origin-video")
	}))
	defer own.Close()
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Api-Key") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Tenant") != "" {
			t.Error("external media received provider credentials or business headers")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = io.WriteString(w, "external-video")
	}))
	defer external.Close()
	config := providerConfig{BaseURL: own.URL, APIKey: "synthetic-media-secret", AuthMode: "api-key", AuthHeader: "X-Test-Api-Key", APIPathPrefix: "/gateway/v2", Headers: []OutboundHeader{{Name: "X-Tenant", Value: "private-tenant"}}}
	if _, _, err := getProviderExternalBinary(context.Background(), config, own.URL+"/saved/media.mp4?signature=public-fixture"); err != nil {
		t.Fatal(err)
	}
	if ownPath != "/saved/media.mp4?signature=public-fixture" {
		t.Fatal("a returned media path was rewritten by the API prefix")
	}
	if _, _, err := getProviderExternalBinary(context.Background(), config, external.URL+"/external.mp4"); err != nil {
		t.Fatal(err)
	}
}

func TestChannelConnectionProtocolOptionsRespectPluginBoundaries(t *testing.T) {
	allowLoopbackProviderTest(t)
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Header.Get("X-Test-Api-Key") != "synthetic-protocol-secret" || r.Header.Get("Authorization") != "" {
			t.Error("protocol auth override failed")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"mock-task"}`)
	}))
	defer server.Close()
	config := providerConfig{BaseURL: server.URL, InterfaceType: "newapi-channel-1", APIKey: "synthetic-protocol-secret", APIPathPrefix: "/gateway/v2", AuthMode: "api-key", AuthHeader: "X-Test-Api-Key"}
	adapter, ok := protocol.Builtins().Resolve(config.InterfaceType)
	if !ok || adapter.Metadata().ID != "newapi-channel-1" {
		t.Fatal("newapi-channel-1 must resolve to its existing standard adapter")
	}
	create, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocol.GenerationRequest{Model: "mock-video", Prompt: "a fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	poll, err := adapter.BuildPoll(context.Background(), protocol.PollContext{TaskID: "mock-task"})
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range []protocol.RequestSpec{create, poll, {Method: http.MethodGet, Path: "/v1/videos/mock-task/content"}} {
		if _, err := executeProtocolRequest(context.Background(), config, spec); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(paths, []string{"/gateway/v2/videos", "/gateway/v2/videos/mock-task", "/gateway/v2/videos/mock-task/content"}) {
		t.Fatalf("standard adapter stages = %v", paths)
	}
	for _, spec := range []protocol.RequestSpec{
		{Method: http.MethodPost, Path: "/v1/videos", OriginPath: true},
		{Method: http.MethodPost, Path: "/v1/videos", Auth: protocol.ManifestAuth{Type: "header", Header: "X-Plugin-Key", Field: "apiKey"}},
		{Method: http.MethodPost, Path: "/v1/videos", Auth: protocol.ManifestAuth{Type: "bearer", Field: "secretKey"}},
		{Method: http.MethodPost, Path: "/v1/videos", Auth: protocol.ManifestAuth{Type: "bearer", Prefix: "Plugin "}},
		{Method: http.MethodPost, Path: "/v1/videos", Headers: map[string]string{"X-Test-Api-Key": "plugin-auth"}},
	} {
		if _, err := executeProtocolRequest(context.Background(), config, spec); err == nil {
			t.Fatal("connection options overrode plugin-specific authentication/origin semantics")
		}
	}
	if len(paths) != 3 {
		t.Fatal("a rejected plugin override was dispatched")
	}
}

func TestChannelConnectionProviderSecretRedaction(t *testing.T) {
	allowLoopbackProviderTest(t)
	const secret = "synthetic-reflection-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/responses" {
			w.Header().Set("Content-Type", "application/event-stream")
			_, _ = io.WriteString(w, "data: "+secret[:7])
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, secret[7:]+"\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Request-Id", secret)
		if r.URL.Path == "/v1/images/edits" {
			w.WriteHeader(http.StatusBadRequest)
		}
		_, _ = io.WriteString(w, `{"message":"`+secret+`"}`)
	}))
	defer server.Close()
	config := providerConfig{BaseURL: server.URL, APIKey: secret, AuthMode: "api-key", AuthHeader: "X-Test-Api-Key"}
	var payload map[string]any
	if err := postJSON(context.Background(), config, "/chat/completions", map[string]any{}, &payload); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(payload)
	if bytes.Contains(encoded, []byte(secret)) {
		t.Fatal("JSON reflected the credential")
	}
	var streamed strings.Builder
	data, _, err := postStreamingBinary(context.Background(), config, "/responses", map[string]any{}, func(_ string, chunk []byte) { streamed.Write(chunk) })
	if err != nil || bytes.Contains(data, []byte(secret)) || strings.Contains(streamed.String(), secret) {
		t.Fatal("SSE reflected the credential")
	}
	if !strings.Contains(streamed.String(), "[REDACTED]") {
		t.Fatal("SSE reflection was not redacted")
	}
	err = postJSON(context.Background(), config, "/images/edits", map[string]any{}, &payload)
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(safeProviderLogError(err), secret) {
		t.Fatal("HTTP error or safe log reflected the credential")
	}
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) || strings.Contains(httpErr.RequestID, secret) {
		t.Fatal("upstream request ID reflected the credential into failure diagnostics")
	}
	req, err := newProviderChannelRequest(context.Background(), config, http.MethodPost, "/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(redactProviderRequestBytes(req, []byte(`{"message":"`+secret+`"}`))), secret) {
		t.Fatal("credential-aware log sanitizer failed")
	}
	r := providerStreamRedactor{secret: []byte(secret)}
	var chunks []byte
	for _, part := range []string{secret[:3], secret[3:8], secret[8:]} {
		chunks = append(chunks, r.push([]byte(part), false)...)
	}
	chunks = append(chunks, r.push(nil, true)...)
	if string(chunks) != "[REDACTED]" {
		t.Fatal("credential spanning arbitrary chunks was not redacted")
	}
}

func TestChannelConnectionCredentialDoesNotPersistInLogsOrEvidence(t *testing.T) {
	const secret = "synthetic-logged-credential"
	service, db := newTimelineTaskTestService(t)
	service.workerID = "synthetic-connection-log-service"
	serviceID := registerProviderService(service)
	t.Cleanup(func() {
		providerAnalyticsServices.Lock()
		delete(providerAnalyticsServices.services, serviceID)
		providerAnalyticsServices.Unlock()
	})
	ctx, recorder := withTaskRequestEvidence(context.Background())
	ctx = context.WithValue(ctx, providerAnalyticsKey{}, providerAnalyticsContext{ServiceID: serviceID, UserID: "synthetic-user", Capability: "text"})
	req, err := newProviderChannelRequest(ctx, providerConfig{BaseURL: "https://mock.invalid", APIKey: secret, AuthMode: "api-key", AuthHeader: "X-Test-Api-Key"}, http.MethodPost, "/chat/completions", strings.NewReader(`{"prompt":"`+secret+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	body := []byte(`{"error":{"message":"` + secret + `","code":"invalid_request"}}`)
	requestErr := providerHTTPError{StatusCode: 400, Body: string(body)}
	recordProviderRequest(req, time.Now(), 400, body, requestErr)
	recordTaskRequestEvidence(req, model.TaskRequestEvidence{HTTPStatus: 400, Dispatched: true, StartedAt: time.Now().Format(time.RFC3339Nano)}, body, requestErr)
	var logs []model.ApiCallLog
	if err := db.Find(&logs).Error; err != nil || len(logs) != 1 {
		t.Fatalf("mock request log was not persisted: %v (count %d)", err, len(logs))
	}
	encoded, err := json.Marshal(logs)
	if err != nil || bytes.Contains(encoded, []byte(secret)) {
		t.Fatal("persisted request log contains the selected custom-header credential")
	}
	encoded, err = json.Marshal(recorder.snapshot(false))
	if err != nil || bytes.Contains(encoded, []byte(secret)) {
		t.Fatal("failure evidence contains the selected custom-header credential")
	}
}

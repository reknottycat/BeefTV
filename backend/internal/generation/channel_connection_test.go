package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

const connectionTestSecret = "synthetic-channel-credential-27"

func customConnectionConfig(baseURL string) Config {
	return Config{BaseURL: baseURL, APIKey: connectionTestSecret, APIFormat: "openai", InterfaceType: "chat-completion", Model: "mock-model", AuthMode: "api-key", AuthHeader: "X-Gateway-Key", APIPathPrefix: "/gateway/v2"}
}

func TestChannelConnectionExecuteTextUsesLiveTransport(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/gateway/v2/chat/completions" || r.Header.Get("X-Gateway-Key") != connectionTestSecret || r.Header.Get("Authorization") != "" {
			t.Errorf("wrong live request: path=%s auth=%q custom-key-present=%t", r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-Gateway-Key") != "")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["model"] != "mock-model" {
			t.Errorf("protocol body changed: %v, %v", body, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"echo `+connectionTestSecret+`"}}]}`)
	}))
	t.Cleanup(server.Close)
	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Receipts = receipts }))
	result, err := Execute(ctx, Input{Mode: "text", Prompt: "hello", Config: customConnectionConfig(server.URL)})
	if err != nil || result["text"] != "echo [REDACTED]" || hits.Load() != 1 {
		t.Fatalf("Execute result=%v err=%v hits=%d", result, err, hits.Load())
	}
	calls := receipts.snapshot()
	if len(calls) != 1 || !calls[0].Dispatched || calls[0].StatusCode != http.StatusOK {
		t.Fatalf("lost transport receipt: %+v", calls)
	}
	if strings.Contains(string(calls[0].Body), connectionTestSecret) || strings.Contains(calls[0].Request.Header.Get("X-Gateway-Key"), connectionTestSecret) {
		t.Fatal("credential reached receipt")
	}
	meta, ok := CallMetaFromContext(calls[0].Request.Context())
	if !ok || meta.TaskID != "task-1" || meta.UserID != "user-1" || meta.ConcurrencyLimit != 1 {
		t.Fatalf("transport lost runtime identity/limits: %+v", meta)
	}
}

func TestChannelConnectionHTTPHelpers(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, mode := range []string{"bearer", "api-key"} {
		t.Run(mode, func(t *testing.T) {
			var hits atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.URL.Path != "/gateway/v2/videos/task-1" || r.URL.Query().Get("detail") != "1" {
					t.Errorf("prefix changed suffix/query: %s", r.URL.String())
				}
				if mode == "api-key" && (r.Header.Get("X-Gateway-Key") != connectionTestSecret || r.Header.Get("Authorization") != "") {
					t.Error("custom auth missing or duplicate bearer sent")
				}
				if mode == "bearer" && r.Header.Get("Authorization") != "Bearer "+connectionTestSecret {
					t.Error("bearer credential missing")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"ok":true}`)
			}))
			t.Cleanup(server.Close)
			config := customConnectionConfig(server.URL)
			config.AuthMode = mode
			if mode == "bearer" {
				config.AuthHeader = ""
			}
			ctx := context.Background()
			path := "/videos/task-1?detail=1"
			var target map[string]any
			if err := PostJSON(ctx, config, path, map[string]any{"model": "mock-model"}, &target); err != nil {
				t.Fatal(err)
			}
			if err := GetJSON(ctx, config, path, &target); err != nil {
				t.Fatal(err)
			}
			if err := PostForm(ctx, config, path, "multipart/form-data; boundary=fixture", strings.NewReader("fixture"), &target); err != nil {
				t.Fatal(err)
			}
			if _, _, err := PostBinary(ctx, config, path, map[string]any{"model": "mock-model"}); err != nil {
				t.Fatal(err)
			}
			if _, _, err := GetBinary(ctx, config, path); err != nil {
				t.Fatal(err)
			}
			if hits.Load() != 5 {
				t.Fatalf("helper hits=%d", hits.Load())
			}
		})
	}
}

func TestChannelConnectionStreamingRedactsAcrossReads(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	firstChunk := make(chan struct{})
	var signal sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": ready\ndata: "+connectionTestSecret[:12])
		w.(http.Flusher).Flush()
		select {
		case <-firstChunk:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, connectionTestSecret[12:]+"\n\n")
	}))
	t.Cleanup(server.Close)
	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Receipts = receipts }))
	var streamed strings.Builder
	data, _, err := PostStreamingBinary(ctx, customConnectionConfig(server.URL), "/responses", map[string]any{"stream": true}, func(_ string, data []byte) {
		streamed.Write(data)
		signal.Do(func() { close(firstChunk) })
	})
	if err != nil || string(data) != ": ready\ndata: [REDACTED]\n\n" || streamed.String() != string(data) {
		t.Fatalf("streamed redaction failed: data=%q stream=%q err=%v", data, streamed.String(), err)
	}
	if calls := receipts.snapshot(); len(calls) != 1 || string(calls[0].Body) != string(data) {
		t.Fatalf("stream receipt=%+v", calls)
	}
}

func TestChannelConnectionProtocolRejectsOverridesBeforeHTTP(t *testing.T) {
	config := customConnectionConfig("https://gateway.invalid")
	for _, spec := range []protocol.RequestSpec{
		{Method: "POST", Path: "/responses", OriginPath: true},
		{Method: "POST", Path: "/responses", Auth: protocol.ManifestAuth{Type: "query", Query: "token"}},
		{Method: "POST", Path: "/responses", Auth: protocol.ManifestAuth{Type: "none"}},
		{Method: "POST", Path: "/responses", Auth: protocol.ManifestAuth{Type: "header", Header: "X-Api-Key"}},
		{Method: "POST", Path: "/responses", Auth: protocol.ManifestAuth{Type: "bearer", Field: "secretKey"}},
		{Method: "POST", Path: "/responses", Headers: map[string]string{"X-Gateway-Key": "override"}},
		{Method: "POST", Path: "/responses", Headers: map[string]string{"Authorization": "override"}},
		{Method: "POST", Path: "/audio/speech"},
	} {
		_, err := ExecuteProtocolRequest(context.Background(), config, spec)
		if err == nil || strings.Contains(err.Error(), "解析失败") {
			t.Fatalf("expected local rejection for %+v, got %v", spec, err)
		}
	}
}

func TestChannelConnectionProtocolPreservesSubmissionAndHTTPError(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/gateway/v2/videos" || r.Header.Get("X-Gateway-Key") != connectionTestSecret || r.Header.Get("Idempotency-Key") != "submission-fixture" {
			t.Error("protocol connection/idempotency changed")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "3")
		w.Header().Set("X-Request-Id", connectionTestSecret)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"message":"`+connectionTestSecret+`"}}`)
	}))
	t.Cleanup(server.Close)
	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Receipts = receipts }))
	config := customConnectionConfig(server.URL)
	_, err := ExecuteProtocolRequest(ctx, config, protocol.RequestSpec{Method: "POST", Path: "/videos", Headers: map[string]string{"Idempotency-Key": "submission-fixture"}, Auth: protocol.ManifestAuth{Type: "bearer"}, Body: map[string]any{"model": "mock-model"}})
	var httpErr HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusServiceUnavailable || httpErr.RetryAfter.Seconds() != 3 || strings.Contains(httpErr.Body+httpErr.RequestID, connectionTestSecret) {
		t.Fatalf("typed HTTP failure changed/leaked: %#v, %v", httpErr, err)
	}
	var uncertain SubmissionUnknownError
	if !errors.As(UncertainVideoSubmission(ctx, err), &uncertain) {
		t.Fatalf("lost uncertain submission classification: %v", err)
	}
	for _, observation := range receipts.snapshot() {
		if strings.Contains(string(observation.Body)+observation.RequestID+observation.Err.Error(), connectionTestSecret) {
			t.Fatal("failure receipt leaked credential")
		}
	}
}

func TestChannelConnectionRedirectAndForeignDownloadsCannotLeak(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var foreignHits atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreignHits.Add(1)
		if r.Header.Get("X-Gateway-Key") != "" || r.Header.Get("Authorization") != "" {
			t.Error("foreign origin received credential")
		}
		_, _ = io.WriteString(w, "media")
	}))
	t.Cleanup(foreign.Close)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, foreign.URL+"/models", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(server.Close)
	config := customConnectionConfig(server.URL)
	var target map[string]any
	if err := GetJSON(context.Background(), config, "/models", &target); err == nil {
		t.Fatal("custom connection followed redirect")
	}
	if foreignHits.Load() != 0 {
		t.Fatal("redirect dispatched to foreign origin")
	}
	data, _, err := GetProviderExternalBinary(context.Background(), config, foreign.URL+"/media")
	if err != nil || string(data) != "media" || foreignHits.Load() != 1 {
		t.Fatalf("unauthenticated foreign download failed: %s, %v", data, err)
	}
	if _, err := NewChannelRequest(context.Background(), config, http.MethodGet, foreign.URL+"/models", nil); err == nil {
		t.Fatal("channel request allowed another origin")
	}
}

func TestChannelConnectionRejectsInvalidOptionsAndUnsupportedWorkflow(t *testing.T) {
	base := customConnectionConfig("https://gateway.invalid")
	for _, update := range []func(*Config){
		func(c *Config) { c.APIKey = "" },
		func(c *Config) { c.AuthMode = "none" },
		func(c *Config) { c.APIFormat = "gemini" },
		func(c *Config) { c.InterfaceType = "claude-api" },
		func(c *Config) { c.InterfaceType = "runninghub-image" },
		func(c *Config) { c.APIPathPrefix = "/%2e%2e/v1" },
		func(c *Config) { c.Headers = []outbound.OutboundHeader{{Name: "x-gateway-key", Value: "conflict"}} },
		func(c *Config) { c.BaseURL = "https://global.beefapi.com" },
	} {
		config := base
		update(&config)
		if err := ValidateChannelConfig(context.Background(), config); err == nil {
			t.Fatalf("invalid config accepted: %+v", config)
		}
	}
	workflow := &stubWorkflowPort{}
	ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Workflow = workflow }))
	config := base
	config.InterfaceType = string(model.ChannelInterfaceRunningHubImage)
	_, err := Execute(ctx, Input{Mode: "image", Prompt: "draw", Config: config})
	if err == nil || workflow.calls.Load() != 0 {
		t.Fatalf("unsupported custom options reached workflow: err=%v calls=%d", err, workflow.calls.Load())
	}
}

func TestChannelConnectionCannotUseGlobalPrivateBypass(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	t.Cleanup(server.Close)
	var target map[string]any
	err := GetJSON(context.Background(), customConnectionConfig(server.URL), "/models", &target)
	if err == nil || hits.Load() != 0 {
		t.Fatalf("custom SSRF boundary bypassed: %v hits=%d", err, hits.Load())
	}
}

func TestChannelConnectionBinaryMediaRemainsByteExact(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	want := append([]byte{0, 1, 255, 4}, []byte(connectionTestSecret)...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Gateway-Key") != connectionTestSecret {
			t.Error("same-origin media request lost auth")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(want)
	}))
	t.Cleanup(server.Close)
	config := customConnectionConfig(server.URL)
	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Receipts = receipts }))
	data, _, err := GetBinary(ctx, config, "/videos/task-1/content")
	if err != nil || !bytes.Equal(data, want) {
		t.Fatalf("binary changed: %q, %v", data, err)
	}
	var streamed bytes.Buffer
	data, _, err = PostStreamingBinary(ctx, config, "/videos", map[string]any{"model": "mock-model"}, func(_ string, chunk []byte) { streamed.Write(chunk) })
	if err != nil || !bytes.Equal(data, want) || !bytes.Equal(streamed.Bytes(), want) {
		t.Fatalf("streamed binary changed: %q, %v", data, err)
	}
	data, _, err = GetProviderExternalBinary(ctx, config, server.URL+"/media/file.mp4")
	if err != nil || !bytes.Equal(data, want) {
		t.Fatalf("same-origin media download changed: %q, %v", data, err)
	}
	for _, receipt := range receipts.snapshot() {
		if bytes.Contains(receipt.Body, []byte(connectionTestSecret)) {
			t.Fatal("receipt copied opaque credential bytes")
		}
	}
}

func TestChannelConnectionIdempotencyHeaderCannotBecomeCredential(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	t.Cleanup(server.Close)
	config := customConnectionConfig(server.URL)
	config.AuthHeader = "Idempotency-Key"
	var target map[string]any
	err := PostJSONWithSubmissionKey(WithSubmissionKey(context.Background(), "submission-fixture"), config, "/videos", map[string]any{"model": "mock-model"}, &target)
	if err == nil || hits.Load() != 0 {
		t.Fatalf("host auth header reached transport: err=%v hits=%d", err, hits.Load())
	}
}

func TestChannelConnectionJSONEscapedCredentialIsRedacted(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	secret := `fixture"credential\with<&symbols`
	wire, err := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": secret}}}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Gateway-Key") != secret {
			t.Error("escaped credential changed on wire")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(wire)
	}))
	t.Cleanup(server.Close)
	config := customConnectionConfig(server.URL)
	config.APIKey = secret
	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Receipts = receipts }))
	result, err := Execute(ctx, Input{Mode: "text", Prompt: "hello", Config: config})
	if err != nil || result["text"] != "[REDACTED]" {
		t.Fatalf("JSON-escaped key reached output: %+v, %v", result, err)
	}
	for _, receipt := range receipts.snapshot() {
		var payload map[string]any
		if err := json.Unmarshal(receipt.Body, &payload); err != nil {
			t.Fatal(err)
		}
		content := payload["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["content"]
		if content != "[REDACTED]" {
			t.Fatal("JSON-escaped key reached receipt")
		}
	}
}

func TestChannelConnectionEscapedSSECredentialAcrossReads(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	secret := `fixture"credential\with<&symbols`
	encoded, _ := json.Marshal(secret)
	encoded = encoded[1 : len(encoded)-1]
	firstChunk := make(chan struct{})
	var signal sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": ready\n"+`data: {"content":"`+string(encoded[:10]))
		w.(http.Flusher).Flush()
		select {
		case <-firstChunk:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, string(encoded[10:])+"\"}\n\n")
	}))
	t.Cleanup(server.Close)
	config := customConnectionConfig(server.URL)
	config.APIKey = secret
	var streamed strings.Builder
	data, _, err := ExecuteProtocolBinaryRequestWithConsumer(context.Background(), config, protocol.RequestSpec{Method: "POST", Path: "/responses", Auth: protocol.ManifestAuth{Type: "bearer"}, Body: map[string]any{"stream": true}}, func(_ string, data []byte) {
		streamed.Write(data)
		signal.Do(func() { close(firstChunk) })
	})
	want := ": ready\ndata: {\"content\":\"[REDACTED]\"}\n\n"
	if err != nil || string(data) != want || streamed.String() != want {
		t.Fatalf("escaped stream redaction failed: %q, %q, %v", data, streamed.String(), err)
	}
}

func TestChannelConnectionRedactionPreservesJSONSchemaAndNumbers(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, secret := range []string{"123", "choices"} {
		t.Run(secret, func(t *testing.T) {
			wire, _ := json.Marshal(map[string]any{"choices": []any{secret}, "created": 123, "active": true, "nullable": nil})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: "+string(wire)+"\n\n")
				} else {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write(wire)
				}
			}))
			t.Cleanup(server.Close)
			config := customConnectionConfig(server.URL)
			config.APIKey = secret
			receipts := &recordingReceipts{}
			ctx := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Receipts = receipts }))
			assertPayload := func(payload map[string]any) {
				t.Helper()
				values, ok := payload["choices"].([]any)
				if !ok || len(values) != 1 || values[0] != "[REDACTED]" || payload["created"] != float64(123) || payload["active"] != true || payload["nullable"] != nil {
					t.Fatalf("schema changed or credential leaked: %+v", payload)
				}
			}
			var payload map[string]any
			if err := GetJSON(ctx, config, "/models", &payload); err != nil {
				t.Fatal(err)
			}
			assertPayload(payload)
			var streamed bytes.Buffer
			data, _, err := PostStreamingBinary(ctx, config, "/responses", map[string]any{"stream": true}, func(_ string, value []byte) { streamed.Write(value) })
			if err != nil || !bytes.Equal(data, streamed.Bytes()) {
				t.Fatalf("SSE buffer/stream mismatch: %q %q %v", data, streamed.Bytes(), err)
			}
			if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(string(data), "data: "))), &payload); err != nil {
				t.Fatalf("SSE JSON invalid: %s, %v", data, err)
			}
			assertPayload(payload)
			calls := receipts.snapshot()
			if len(calls) != 2 {
				t.Fatalf("receipts=%d", len(calls))
			}
			if err := json.Unmarshal(calls[0].Body, &payload); err != nil {
				t.Fatal(err)
			}
			assertPayload(payload)
			if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(string(calls[1].Body), "data: "))), &payload); err != nil {
				t.Fatal(err)
			}
			assertPayload(payload)
		})
	}
}

package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

const relayConnectionSyntheticKey = "synthetic-relay-connection-secret-marker"

func newRelayConnectionRequest(t *testing.T, method, target string, body io.Reader, contentType string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, "/api/ai/custom", body)
	request.Header.Set("Authorization", "Bearer "+relayConnectionSyntheticKey)
	request.Header.Set("X-Canvas-Upstream-URL", target)
	request.Header.Set("X-Canvas-Upstream-Format", "openai")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	prepareRelayTestRequest(t, request)
	return request
}

func runRelayConnectionRequest(t *testing.T, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = request
	proxyCustomRelayRequest(context, defaultCustomRelayTestPolicy())
	return response
}

func assertRelayConnectionMetadataAbsent(t *testing.T, request *http.Request) {
	t.Helper()
	for name := range request.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-canvas-") {
			t.Errorf("internal relay metadata reached upstream: %s", name)
		}
	}
	for _, name := range []string{"Cookie", "Origin", "Referer", "X-Forwarded-For"} {
		if request.Header.Get(name) != "" {
			t.Errorf("browser header reached upstream: %s", name)
		}
	}
}

func TestCustomRelayChannelConnectionJSONAuthenticationAndPrefix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, mode, header, prefix, path, expectedPath string
		apiKeyHeader                                   string
	}{
		{name: "legacy-default", path: "/v1/responses", expectedPath: "/v1/responses"},
		{name: "explicit-bearer-prefix", mode: "bearer", prefix: "/edge/api/v2", path: "/legacy/v1/chat/completions", expectedPath: "/edge/api/v2/chat/completions"},
		{name: "api-key-default-header", mode: "api-key", prefix: "/edge/api", path: "/v1/images/generations", expectedPath: "/edge/api/images/generations", apiKeyHeader: "X-Api-Key"},
		{name: "api-key-custom-header", mode: "api-key", header: "X-Relay-Test-Key", prefix: "/", path: "/v1/models", expectedPath: "/models", apiKeyHeader: "X-Relay-Test-Key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			method, payload, contentType := http.MethodPost, `{"model":"synthetic-model","prompt":"synthetic input"}`, "application/json"
			if strings.HasSuffix(tc.path, "/models") {
				method, payload, contentType = http.MethodGet, "", ""
			}
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.Method != method || request.URL.Path != tc.expectedPath || request.URL.RawQuery != "" {
					t.Errorf("upstream request = %s %s, want %s %s", request.Method, request.URL.String(), method, tc.expectedPath)
				}
				if tc.apiKeyHeader == "" {
					if request.Header.Get("Authorization") != "Bearer "+relayConnectionSyntheticKey || request.Header.Get("X-Api-Key") != "" {
						t.Error("Bearer request did not retain exactly its configured authentication")
					}
				} else if request.Header.Get(tc.apiKeyHeader) != relayConnectionSyntheticKey || request.Header.Get("Authorization") != "" {
					t.Error("API-key request did not use the configured header without Bearer")
				}
				if request.Header.Get("X-Gateway-Tenant") != "synthetic-tenant" {
					t.Error("ordinary business header was not preserved")
				}
				assertRelayConnectionMetadataAbsent(t, request)
				body, err := io.ReadAll(request.Body)
				if err != nil || string(body) != payload {
					t.Error("channel connection options changed the request payload")
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]string{"message": "before " + relayConnectionSyntheticKey + " after"})
			}))
			defer upstream.Close()
			useCustomRelayTestClient(t, upstream.Client())
			request := newRelayConnectionRequest(t, method, upstream.URL+tc.path, strings.NewReader(payload), contentType)
			request.Header.Set("X-Canvas-Upstream-Auth-Mode", tc.mode)
			request.Header.Set("X-Canvas-Upstream-Auth-Header", tc.header)
			request.Header.Set("X-Canvas-Upstream-API-Path-Prefix", tc.prefix)
			request.Header.Set(app.CustomRelayHeadersHeader, base64.StdEncoding.EncodeToString([]byte(`[{"name":"X-Gateway-Tenant","value":"synthetic-tenant"}]`)))
			request.Header.Set("Cookie", "synthetic-browser=session")
			request.Header.Set("Origin", "https://browser.invalid")
			request.Header.Set("Referer", "https://browser.invalid/example")
			response := runRelayConnectionRequest(t, request)
			if response.Code != http.StatusOK || strings.Contains(response.Body.String(), relayConnectionSyntheticKey) || !strings.Contains(response.Body.String(), "[REDACTED]") {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestCustomRelayChannelConnectionMultipartAndVideoLifecycle(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const prefix = "/gateway/api/v2"
	paths := make(chan string, 4)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		paths <- request.Method + " " + request.URL.Path
		if request.Header.Get("X-Relay-Test-Key") != relayConnectionSyntheticKey || request.Header.Get("Authorization") != "" {
			t.Error("media lifecycle lost API-key authentication")
		}
		assertRelayConnectionMetadataAbsent(t, request)
		if request.Method == http.MethodPost {
			mediaType, params, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
			if err != nil || mediaType != "multipart/form-data" {
				t.Error("multipart boundary or content type was not preserved")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			reader := multipart.NewReader(request.Body, params["boundary"])
			fields, files := map[string]string{}, map[string][]byte{}
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Errorf("read multipart: %v", err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				value, err := io.ReadAll(part)
				if err != nil {
					t.Errorf("read multipart part: %v", err)
				}
				if part.FileName() != "" {
					files[part.FormName()] = value
				} else {
					fields[part.FormName()] = string(value)
				}
			}
			if fields["model"] != "synthetic-model" || fields["prompt"] != "synthetic scene" {
				t.Error("multipart model or prompt was changed")
			}
			fileField := "image"
			if request.URL.Path == prefix+"/videos" {
				fileField = "input_reference"
				if fields["seconds"] != "5" {
					t.Error("video duration was changed")
				}
			}
			if !bytes.Equal(files[fileField], []byte("synthetic-reference-bytes")) {
				t.Error("multipart reference bytes were changed")
			}
		}
		if request.URL.Path == prefix+"/videos/synthetic-job/content" {
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = io.WriteString(w, "synthetic-video-bytes")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"synthetic-job","status":"completed","data":[]}`)
	}))
	defer upstream.Close()
	useCustomRelayTestClient(t, upstream.Client())
	cases := []struct{ method, path, fileField string }{
		{http.MethodPost, "/legacy/v1/images/edits", "image"},
		{http.MethodPost, "/legacy/v1/videos", "input_reference"},
		{http.MethodGet, "/legacy/v1/videos/synthetic-job", ""},
		{http.MethodGet, "/legacy/v1/videos/synthetic-job/content", ""},
	}
	expected := []string{"POST " + prefix + "/images/edits", "POST " + prefix + "/videos", "GET " + prefix + "/videos/synthetic-job", "GET " + prefix + "/videos/synthetic-job/content"}
	for _, tc := range cases {
		var body bytes.Buffer
		contentType := ""
		if tc.method == http.MethodPost {
			writer := multipart.NewWriter(&body)
			for _, field := range [][2]string{{"model", "synthetic-model"}, {"prompt", "synthetic scene"}, {"seconds", "5"}} {
				if err := writer.WriteField(field[0], field[1]); err != nil {
					t.Fatal(err)
				}
			}
			part, err := writer.CreateFormFile(tc.fileField, "synthetic-reference.png")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.WriteString(part, "synthetic-reference-bytes"); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			contentType = writer.FormDataContentType()
		}
		request := newRelayConnectionRequest(t, tc.method, upstream.URL+tc.path, &body, contentType)
		request.Header.Set("X-Canvas-Upstream-Auth-Mode", "api-key")
		request.Header.Set("X-Canvas-Upstream-Auth-Header", "X-Relay-Test-Key")
		request.Header.Set("X-Canvas-Upstream-API-Path-Prefix", prefix)
		response := runRelayConnectionRequest(t, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s %s: status = %d, body = %s", tc.method, tc.path, response.Code, response.Body.String())
		}
		if strings.HasSuffix(tc.path, "/content") && (response.Header().Get("Content-Type") != "video/mp4" || response.Body.String() != "synthetic-video-bytes") {
			t.Fatal("content download did not preserve media MIME and bytes")
		}
	}
	actual := make([]string, 0, len(expected))
	for range expected {
		actual = append(actual, <-paths)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("lifecycle requests = %v, want %v", actual, expected)
	}
}

type relayConnectionChunkBody struct{ io.ReadCloser }

func (body relayConnectionChunkBody) Read(buffer []byte) (int, error) {
	if len(buffer) > 3 {
		buffer = buffer[:3]
	}
	return body.ReadCloser.Read(buffer)
}

type relayConnectionTransport func(*http.Request) (*http.Response, error)

func (transport relayConnectionTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestCustomRelayChannelConnectionSSERedactsSplitSecret(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/edge/responses" || request.Header.Get("X-Api-Key") != relayConnectionSyntheticKey || request.Header.Get("Authorization") != "" || request.Header.Get("Accept") != "text/event-stream" {
			t.Error("SSE request lost connection or stream options")
		}
		assertRelayConnectionMetadataAbsent(t, request)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: error\ndata: {\"error\":{\"message\":\"before "+relayConnectionSyntheticKey+" after\"}}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	defer upstream.Close()
	client := upstream.Client()
	transport := client.Transport
	client.Transport = relayConnectionTransport(func(request *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(request)
		if err == nil {
			// Force split reads independently of TLS packet coalescing.
			response.Body = relayConnectionChunkBody{response.Body}
		}
		return response, err
	})
	useCustomRelayTestClient(t, client)
	request := newRelayConnectionRequest(t, http.MethodPost, upstream.URL+"/v1/responses", strings.NewReader(`{"model":"synthetic-model","stream":true}`), "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("X-Canvas-Upstream-Auth-Mode", "api-key")
	request.Header.Set("X-Canvas-Upstream-API-Path-Prefix", "/edge")
	response := runRelayConnectionRequest(t, request)
	want := "event: error\ndata: {\"error\":{\"message\":\"before [REDACTED] after\"}}\n\ndata: [DONE]\n\n"
	if response.Code != http.StatusOK || response.Body.String() != want || !response.Flushed || response.Header().Get("X-Accel-Buffering") != "no" {
		t.Fatalf("status = %d, flushed = %v, body = %q", response.Code, response.Flushed, response.Body.String())
	}
}

func TestCustomRelayChannelConnectionJSONErrorsRedactSecret(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/edge/chat/completions" || request.Header.Get("X-Relay-Test-Key") != relayConnectionSyntheticKey || request.Header.Get("Authorization") != "" {
					t.Error("error request lost configured connection")
				}
				assertRelayConnectionMetadataAbsent(t, request)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": "rejected " + relayConnectionSyntheticKey}})
			}))
			defer upstream.Close()
			useCustomRelayTestClient(t, upstream.Client())
			request := newRelayConnectionRequest(t, http.MethodPost, upstream.URL+"/v1/chat/completions", strings.NewReader(`{"model":"synthetic-model"}`), "application/json")
			request.Header.Set("X-Canvas-Upstream-Auth-Mode", "api-key")
			request.Header.Set("X-Canvas-Upstream-Auth-Header", "X-Relay-Test-Key")
			request.Header.Set("X-Canvas-Upstream-API-Path-Prefix", "/edge")
			response := runRelayConnectionRequest(t, request)
			if response.Code != status || strings.Contains(response.Body.String(), relayConnectionSyntheticKey) || !strings.Contains(response.Body.String(), "[REDACTED]") {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestCustomRelayChannelConnectionRejectsInvalidOverridesBeforeDispatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, mode, header, prefix, format, path, target, businessHeaders string
	}{
		{name: "invalid-mode", mode: "basic"},
		{name: "managed-auth-header", mode: "api-key", header: "Authorization"},
		{name: "cookie-header", mode: "api-key", header: "Cookie"},
		{name: "internal-header", mode: "api-key", header: "X-Canvas-Test"},
		{name: "header-newline", mode: "api-key", header: "X-Test\r\nInjected"},
		{name: "bearer-custom-header", mode: "bearer", header: "X-Gateway-Key"},
		{name: "business-header-collision", mode: "api-key", header: "X-Gateway-Key", businessHeaders: `[{"name":"x-gateway-key","value":"ordinary-business-value"}]`},
		{name: "absolute-prefix", prefix: "https://external.invalid/v1"},
		{name: "protocol-relative-prefix", prefix: "//external.invalid/v1"},
		{name: "traversal-prefix", prefix: "/edge/../v2"},
		{name: "encoded-prefix", prefix: "/edge%2fv2"},
		{name: "query-prefix", prefix: "/edge?token=synthetic"},
		{name: "fragment-prefix", prefix: "/edge#fragment"},
		{name: "backslash-prefix", prefix: `/edge\v2`},
		{name: "gemini-override", mode: "api-key", prefix: "/edge", format: "gemini", path: "/v1beta/models/synthetic:generateContent"},
		{name: "claude-override", mode: "api-key", prefix: "/edge", format: "claude", path: "/v1/messages"},
		{name: "nonstandard-endpoint", prefix: "/edge", path: "/v1/contents/generations/tasks"},
		{name: "forbidden-original-endpoint", prefix: "/edge", path: "/v1/not-allowed"},
		{name: "credential-query", prefix: "/edge", path: "/v1/responses?api_key=synthetic-query-marker"},
		{name: "blocked-private-origin", mode: "api-key", prefix: "/edge", target: "https://169.254.169.254/v1/responses"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dispatched := false
			useCustomRelayTestClient(t, &http.Client{Transport: relayConnectionTransport(func(*http.Request) (*http.Response, error) {
				dispatched = true
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":[]}`))}, nil
			})})
			path := tc.path
			if path == "" {
				path = "/v1/responses"
			}
			target := tc.target
			if target == "" {
				target = "https://127.0.0.1" + path
			}
			request := newRelayConnectionRequest(t, http.MethodPost, target, strings.NewReader(`{"model":"synthetic-model"}`), "application/json")
			request.Header.Set("X-Canvas-Upstream-Auth-Mode", tc.mode)
			request.Header.Set("X-Canvas-Upstream-Auth-Header", tc.header)
			request.Header.Set("X-Canvas-Upstream-API-Path-Prefix", tc.prefix)
			if tc.format != "" {
				request.Header.Set("X-Canvas-Upstream-Format", tc.format)
			}
			if tc.businessHeaders != "" {
				request.Header.Set(app.CustomRelayHeadersHeader, base64.StdEncoding.EncodeToString([]byte(tc.businessHeaders)))
			}
			response := runRelayConnectionRequest(t, request)
			if dispatched || response.Code < http.StatusBadRequest || response.Code >= http.StatusInternalServerError {
				t.Fatalf("dispatched = %v, status = %d, body = %s", dispatched, response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), relayConnectionSyntheticKey) {
				t.Fatal("invalid connection response leaked the transported key")
			}
		})
	}
}

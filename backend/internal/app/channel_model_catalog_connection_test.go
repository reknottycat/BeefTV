package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
)

func TestFetchChannelModelCatalogConnectionRequests(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tt := range []struct {
		name        string
		input       ChannelModelsRequest
		basePath    string
		wantPath    string
		wantHeader  string
		wantValue   string
		response    string
		wantModelID string
	}{
		{
			name: "legacy openai defaults", input: ChannelModelsRequest{APIKey: " fixture-key "},
			wantPath: "/v1/models", wantHeader: "Authorization", wantValue: "Bearer fixture-key",
		},
		{
			name: "legacy gemini", input: ChannelModelsRequest{APIKey: "fixture-key", APIFormat: " Gemini "},
			wantPath: "/v1beta/models", wantHeader: "x-goog-api-key", wantValue: "fixture-key",
			response: `{"models":[{"name":"models/gemini-fixture"}]}`, wantModelID: "gemini-fixture",
		},
		{
			name: "default api key header", input: ChannelModelsRequest{APIKey: "fixture-key", AuthMode: " API-KEY "},
			basePath: "/v1", wantPath: "/v1/models", wantHeader: "X-Api-Key", wantValue: "fixture-key",
		},
		{
			name: "custom local channel prefix and header", input: ChannelModelsRequest{
				APIKey: "fixture-key", APIFormat: "openai", InterfaceType: "chat-completion",
				ChannelID: "local-custom", AuthMode: "api-key", AuthHeader: " X-Fixture-Key ", APIPathPrefix: "/gateway/api/",
			},
			basePath: "/old/v1", wantPath: "/gateway/api/models", wantHeader: "X-Fixture-Key", wantValue: "fixture-key",
		},
		{
			name: "bearer root prefix", input: ChannelModelsRequest{APIKey: "fixture-key", AuthMode: "bearer", APIPathPrefix: "/"},
			basePath: "/old/v1", wantPath: "/models", wantHeader: "Authorization", wantValue: "Bearer fixture-key",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodGet || r.URL.Path != tt.wantPath || r.URL.RawQuery != "" {
					t.Errorf("request = %s %s; want GET %s", r.Method, r.URL, tt.wantPath)
				}
				if got := r.Header.Get(tt.wantHeader); got != tt.wantValue {
					t.Errorf("%s = %q; want %q", tt.wantHeader, got, tt.wantValue)
				}
				if tt.wantHeader != "Authorization" && r.Header.Get("Authorization") != "" {
					t.Errorf("unexpected bearer auth alongside %s", tt.wantHeader)
				}
				if got := r.Header.Get("X-Fixture-Route"); got != "catalog" {
					t.Errorf("custom header = %q", got)
				}
				w.Header().Set("Content-Type", "application/json")
				body := tt.response
				if body == "" {
					body = `{"data":[{"id":"model-fixture","model_type":"text"}]}`
				}
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			input := tt.input
			input.BaseURL = server.URL + tt.basePath
			input.Headers = []OutboundHeader{{Name: "X-Fixture-Route", Value: "catalog"}}
			catalog, err := (&Service{}).FetchChannelModelCatalog(context.Background(), &model.User{ID: "owner"}, input)
			wantID := tt.wantModelID
			if wantID == "" {
				wantID = "model-fixture"
			}
			if err != nil || len(catalog) != 1 || catalog[0].ID != wantID || calls.Load() != 1 {
				t.Fatalf("catalog = %#v; error = %v; requests = %d", catalog, err, calls.Load())
			}
		})
	}
}

func TestFetchChannelModelCatalogRejectsConnectionOverridesBeforeHTTP(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	for _, tt := range []struct {
		name   string
		change func(*ChannelModelsRequest)
	}{
		{"missing key", func(in *ChannelModelsRequest) { in.APIKey = "" }},
		{"unsupported auth", func(in *ChannelModelsRequest) { in.AuthMode = "none" }},
		{"header conflict", func(in *ChannelModelsRequest) {
			in.Headers = []OutboundHeader{{Name: "x-api-key", Value: "another-key"}}
		}},
		{"forbidden auth header", func(in *ChannelModelsRequest) { in.AuthHeader = "Host" }},
		{"invalid prefix", func(in *ChannelModelsRequest) { in.APIPathPrefix = "/gateway/../admin" }},
		{"origin replacement", func(in *ChannelModelsRequest) { in.APIPathPrefix = "//example.com" }},
		{"gemini options", func(in *ChannelModelsRequest) { in.APIFormat = "gemini" }},
		{"nonstandard protocol", func(in *ChannelModelsRequest) { in.InterfaceType = "runninghub" }},
		{"invalid key", func(in *ChannelModelsRequest) { in.APIKey = "fixture\r\nkey" }},
		{"invalid legacy address", func(in *ChannelModelsRequest) {
			in.BaseURL, in.AuthMode = "http://%invalid", "bearer"
		}},
		{"managed channel id", func(in *ChannelModelsRequest) { in.ChannelID = beefapi.ChannelID }},
		{"managed credential ref", func(in *ChannelModelsRequest) { in.CredentialRef = beefapi.CredentialRef }},
		{"managed base url", func(in *ChannelModelsRequest) { in.BaseURL = "https://enterprise.beefapi.com/v1" }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			input := ChannelModelsRequest{BaseURL: server.URL, APIKey: "fixture-key", AuthMode: "api-key"}
			tt.change(&input)
			_, err := (&Service{}).FetchChannelModelCatalog(context.Background(), &model.User{ID: "owner"}, input)
			var auth *AuthError
			if err == nil || !errors.As(err, &auth) || auth.Status != http.StatusBadRequest {
				t.Fatalf("expected bad-request validation error, got %#v", err)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("rejected configuration reached upstream %d times", calls.Load())
	}
}

func TestFetchChannelModelCatalogPreservesMainCatalogParsing(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[
			{"id":"z-model"},
			{"id":"a-model","display_name":"Model A","model_type":"video","supported_endpoint_types":["video"],"default_parameters":{"duration_seconds":"6"},"options":{"resolution":[{"value":"720p","label":"HD"}]},"supports_images":true,"min_images":1,"max_images":3,"video_capabilities":{"operations":["text_to_video"]},"video_capabilities_version":"invalid-fixture"},
			{"id":"a-model"}, {"id":""}
		]}`))
	}))
	defer server.Close()
	svc := &Service{}
	input := ChannelModelsRequest{BaseURL: server.URL, APIKey: "fixture-key", AuthMode: "api-key", APIPathPrefix: "/gateway"}
	actor := &model.User{ID: "owner"}
	catalog, err := svc.FetchChannelModelCatalog(context.Background(), actor, input)
	if err != nil || len(catalog) != 2 || catalog[0].ID != "a-model" || catalog[1].ID != "z-model" {
		t.Fatalf("catalog = %#v; error = %v", catalog, err)
	}
	first := catalog[0]
	if first.DisplayName != "Model A" || first.ModelType != "video" || first.DefaultParameters.DurationSeconds != "6" ||
		len(first.Options.Resolution) != 1 || first.Options.Resolution[0].Value != "720p" ||
		first.SupportsImages == nil || !*first.SupportsImages || first.MinImages == nil || *first.MinImages != 1 ||
		first.MaxImages == nil || *first.MaxImages != 3 {
		t.Fatalf("catalog metadata lost: %#v", first)
	}
	if first.VideoCapabilities != nil || first.VideoCapabilitiesVersion != nil {
		t.Fatal("invalid video capabilities bypassed the main catalog overlay")
	}
	ids, err := svc.FetchChannelModels(context.Background(), actor, input)
	if err != nil || !reflect.DeepEqual(ids, []string{"a-model", "z-model"}) {
		t.Fatalf("legacy model ids = %v; error = %v", ids, err)
	}
}

func TestFetchChannelModelCatalogConnectionUpstreamErrors(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tt := range []struct {
		name, body, wantMessage string
		status                  int
	}{
		{"authentication rejected", `{"error":"fixture-key"}`, "鉴权失败", http.StatusUnauthorized},
		{"not json", `not-json`, "有效 JSON", http.StatusOK},
		{"business rejection", `{"code":1,"msg":"fixture-key"}`, "返回失败", http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			_, err := (&Service{}).FetchChannelModelCatalog(context.Background(), &model.User{ID: "owner"}, ChannelModelsRequest{
				BaseURL: server.URL, APIKey: "fixture-key", AuthMode: "api-key", AuthHeader: "X-Fixture-Key", APIPathPrefix: "/gateway",
			})
			var auth *AuthError
			if err == nil || !errors.As(err, &auth) || auth.Status != http.StatusBadGateway || !strings.Contains(err.Error(), tt.wantMessage) {
				t.Fatalf("upstream error = %#v", err)
			}
			if strings.Contains(err.Error(), "fixture-key") {
				t.Fatal("upstream error leaked the API key")
			}
		})
	}
}

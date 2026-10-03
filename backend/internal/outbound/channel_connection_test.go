package outbound

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelConnectionProposalNormalization(t *testing.T) {
	value, err := NormalizeChannelConnection(ChannelConnection{}, nil)
	if err != nil || value.AuthMode != "bearer" || value.AuthHeader != "" || value.APIPathPrefix != "" {
		t.Fatalf("default proposal contract: %+v, %v", value, err)
	}
	value, err = NormalizeChannelConnection(ChannelConnection{AuthMode: "api-key", APIPathPrefix: "/gateway/v1/"}, nil)
	if err != nil || value.AuthHeader != "X-Api-Key" || value.APIPathPrefix != "/gateway/v1" {
		t.Fatalf("header proposal contract: %+v, %v", value, err)
	}
	value, err = NormalizeChannelConnection(ChannelConnection{AuthMode: "api-key", AuthHeader: "x-provider-key"}, nil)
	if err != nil || value.AuthHeader != "X-Provider-Key" {
		t.Fatalf("custom authentication header: %+v, %v", value, err)
	}
}

func TestChannelConnectionProposalRejectsUnsupportedAuthentication(t *testing.T) {
	for _, value := range []ChannelConnection{
		{AuthMode: "none"}, {AuthMode: "basic"}, {AuthMode: "query"}, {AuthMode: "code"},
		{AuthMode: "bearer", AuthHeader: "X-Api-Key"},
	} {
		if _, err := NormalizeChannelConnection(value, nil); err == nil {
			t.Fatalf("unsupported auth proposal accepted: %+v", value)
		}
	}
}

func TestChannelConnectionProposalRejectsReservedAndConflictingHeaders(t *testing.T) {
	for _, name := range []string{"Authorization", "Host", "Cookie", "Content-Type", "Accept", "Proxy-Authorization", "X-Canvas-Upstream-URL", "X-Forwarded-For", "X-Goog-Api-Key", "Bad Header", "X-Key\r\nOther", strings.Repeat("a", 129)} {
		if _, err := NormalizeChannelConnection(ChannelConnection{AuthMode: "api-key", AuthHeader: name}, nil); err == nil {
			t.Fatalf("unsafe auth header proposal accepted: %q", name)
		}
	}
	if _, err := NormalizeChannelConnection(ChannelConnection{AuthMode: "api-key", AuthHeader: "X-Provider-Key"}, []OutboundHeader{{Name: "x-provider-key", Value: "business-value"}}); err == nil {
		t.Fatal("authentication/business header conflict was accepted")
	}
}

func TestChannelConnectionProposalRejectsUnsafePrefixes(t *testing.T) {
	for _, prefix := range []string{"https://other.invalid/v1", "//other.invalid", "/a/../b", "/a/./b", "/a//b", "/%2e%2e/v1", "/%252e%252e/v1", "/a\\b", "/v1?key=x", "/v1#fragment", "/a b", "/a\x00b", "/\u0100", "/\u007f", "/" + strings.Repeat("a", 1024)} {
		if _, err := NormalizeChannelConnection(ChannelConnection{APIPathPrefix: prefix}, nil); err == nil {
			t.Fatalf("unsafe prefix proposal accepted: %q", prefix)
		}
	}
}

func TestChannelConnectionProposalKeepsOriginAndStandardSuffix(t *testing.T) {
	for _, suffix := range []string{"/models", "/chat/completions", "/responses", "/images/generations", "/images/edits", "/videos", "/videos/task-1", "/videos/task-1/content", "/video/generations", "/video/generations/task-1"} {
		value, err := ApplyChannelPathPrefix("https://gateway.invalid/old/v1"+suffix, "/custom/v2")
		if err != nil || value != "https://gateway.invalid/custom/v2"+suffix {
			t.Fatalf("standard suffix %s: %s, %v", suffix, value, err)
		}
	}
	value, err := ApplyChannelPathPrefix("https://gateway.invalid/v1/models", "/")
	if err != nil || value != "https://gateway.invalid/models" {
		t.Fatalf("origin-root prefix: %s, %v", value, err)
	}
}

func TestChannelConnectionProposalDoesNotAddNonstandardEndpoints(t *testing.T) {
	for _, target := range []string{"https://gateway.invalid/generate", "https://gateway.invalid/embeddings", "https://gateway.invalid/audio/speech", "https://gateway.invalid/contents/generations/tasks", "https://gateway.invalid/v1/../models", "https://gateway.invalid/v1/%2e%2e/models", "https://user:pass@gateway.invalid/v1/models", "https://gateway.invalid/v1/models#fragment"} {
		if _, err := ApplyChannelPathPrefix(target, "/gateway/v1"); err == nil {
			t.Fatal("unsafe or nonstandard target was accepted")
		}
	}
	unchanged := "https://gateway.invalid/legacy/special"
	value, err := ApplyChannelPathPrefix(unchanged, "")
	if err != nil || value != unchanged {
		t.Fatal("omitted prefix changed the existing URL contract")
	}
}

func TestChannelConnectionProposalPureHTTPMockUsesExistingCredential(t *testing.T) {
	// The recorder invokes a handler in memory. It creates no listener and
	// exercises no relay/provider runtime, real credential or external request.
	for _, mode := range []string{"bearer", "api-key"} {
		value, err := NormalizeChannelConnection(ChannelConnection{AuthMode: mode}, nil)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "https://mock.invalid/v1/images/generations", strings.NewReader(`{"model":"mock-image"}`))
		request.Header.Set("Authorization", "old-placeholder")
		ApplyChannelAuth(request, value, "synthetic-fixture")
		recorder := httptest.NewRecorder()
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if mode == "bearer" && r.Header.Get("Authorization") != "Bearer synthetic-fixture" {
				t.Error("bearer placement failed")
			}
			if mode == "api-key" && (r.Header.Get("X-Api-Key") != "synthetic-fixture" || r.Header.Get("Authorization") != "") {
				t.Error("header placement sent an extra Bearer credential")
			}
			_, _ = w.Write([]byte(`{"data":[]}`))
		})
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Body.String() != `{"data":[]}` {
			t.Fatal("in-memory mock response failed")
		}
		encoded, err := json.Marshal(value)
		if err != nil || strings.Contains(string(encoded), "synthetic-fixture") {
			t.Fatal("proposal metadata unexpectedly carries a credential value")
		}
	}
}

package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
)

func TestResolveProviderConfigNormalizesCustomConnection(t *testing.T) {
	s := &Service{mode: serviceModeLocal, localResourceStorage: true}
	config, err := s.resolveProviderConfig(providerConfig{
		BaseURL: "https://8.8.8.8/v1", APIKey: "test-key", APIFormat: "openai",
		AuthMode: " API-KEY ", AuthHeader: " x-gateway-key ", APIPathPrefix: " /gateway/ ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.AuthMode != "api-key" || config.AuthHeader != "X-Gateway-Key" || config.APIPathPrefix != "/gateway" {
		t.Fatalf("connection was not normalized: mode=%q header=%q prefix=%q", config.AuthMode, config.AuthHeader, config.APIPathPrefix)
	}
	if config.BaseURL != "https://8.8.8.8/v1" {
		t.Fatal("connection options changed the origin")
	}
}

func TestResolveProviderConfigRejectsSystemConnectionOverrides(t *testing.T) {
	s := &Service{}
	for _, option := range []providerConfig{
		{AuthMode: "api-key"}, {APIPathPrefix: "/gateway"},
	} {
		for _, explicitID := range []bool{true, false} {
			config := option
			if explicitID {
				config.ChannelID = "system-test"
			} else {
				config.BaseURL = "https://8.8.8.8/api/ai/system/system-test"
			}
			_, err := s.resolveProviderConfig(config)
			if err == nil || !strings.Contains(err.Error(), "系统渠道不接受") {
				t.Fatalf("system override must fail before channel lookup: %v", err)
			}
		}
	}
}

func TestResolveManagedSecretsRejectsConnectionOverrides(t *testing.T) {
	s := &Service{}
	for _, identity := range []map[string]any{
		{"channelId": beefapi.ChannelID},
		{"credentialRef": beefapi.CredentialRef},
	} {
		for key, value := range map[string]string{"authMode": "api-key", "authHeader": "X-Gateway-Key", "apiPathPrefix": "/gateway"} {
			input := map[string]any{"apiKey": "client-key", key: value}
			for name, id := range identity {
				input[name] = id
			}
			_, err := s.resolveManagedBeefAPISecrets(map[string]any{"config": input})
			if err == nil || !strings.Contains(err.Error(), "托管渠道不接受") {
				t.Fatalf("managed override %s must fail before secret lookup: %v", key, err)
			}
			if input["apiKey"] != "client-key" {
				t.Fatal("rejected input must not be populated with a managed key")
			}
		}
	}
}

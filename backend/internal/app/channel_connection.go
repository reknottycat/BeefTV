package app

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

type ChannelConnection = outbound.ChannelConnection

const (
	CustomRelayAuthModeHeader      = "X-Canvas-Upstream-Auth-Mode"
	CustomRelayAuthHeaderHeader    = "X-Canvas-Upstream-Auth-Header"
	CustomRelayAPIPathPrefixHeader = "X-Canvas-Upstream-API-Path-Prefix"
)

func NormalizeChannelConnection(value ChannelConnection, headers []OutboundHeader) (ChannelConnection, error) {
	connection, err := outbound.NormalizeChannelConnection(value, headers)
	return connection, mapOutboundError(err)
}

func ApplyChannelPathPrefix(rawURL, prefix string) (string, error) {
	value, err := outbound.ApplyChannelPathPrefix(rawURL, prefix)
	return value, mapOutboundError(err)
}

func ApplyChannelAuth(request *http.Request, value ChannelConnection, apiKey string) {
	outbound.ApplyChannelAuth(request, value, apiKey)
	rememberProviderCredential(request, apiKey)
}

type providerCredentialContext struct{}

func rememberProviderCredential(request *http.Request, apiKey string) {
	if apiKey != "" {
		*request = *request.WithContext(context.WithValue(request.Context(), providerCredentialContext{}, apiKey))
	}
}

func redactProviderRequestBytes(request *http.Request, value []byte) []byte {
	if secret, _ := request.Context().Value(providerCredentialContext{}).(string); secret != "" {
		return bytes.ReplaceAll(value, []byte(secret), []byte("[REDACTED]"))
	}
	return value
}

type providerStreamRedactor struct {
	secret, pending []byte
}

func (r *providerStreamRedactor) push(chunk []byte, final bool) []byte {
	r.pending = append(r.pending, chunk...)
	if len(r.secret) == 0 {
		value := append([]byte(nil), r.pending...)
		r.pending = nil
		return value
	}
	r.pending = bytes.ReplaceAll(r.pending, r.secret, []byte("[REDACTED]"))
	keep := 0
	if !final {
		for size := 1; size < len(r.secret) && size <= len(r.pending); size++ {
			if bytes.Equal(r.pending[len(r.pending)-size:], r.secret[:size]) {
				keep = size
			}
		}
	}
	value := append([]byte(nil), r.pending[:len(r.pending)-keep]...)
	r.pending = append([]byte(nil), r.pending[len(r.pending)-keep:]...)
	return value
}

func customChannelConnection(value ChannelConnection) bool {
	mode := strings.ToLower(strings.TrimSpace(value.AuthMode))
	return (mode != "" && mode != "bearer") || strings.TrimSpace(value.AuthHeader) != "" || strings.TrimSpace(value.APIPathPrefix) != ""
}

// Options reuse the existing APIKey value and never select another origin.
func normalizeProviderChannelConnection(config providerConfig) (providerConfig, error) {
	headers, err := NormalizeOutboundHeaders(config.Headers)
	if err != nil {
		return providerConfig{}, err
	}
	config.Headers = headers
	connection, err := NormalizeChannelConnection(ChannelConnection{
		AuthMode: config.AuthMode, AuthHeader: config.AuthHeader, APIPathPrefix: config.APIPathPrefix,
	}, config.Headers)
	if err != nil {
		return providerConfig{}, err
	}
	config.AuthMode = connection.AuthMode
	config.AuthHeader = connection.AuthHeader
	config.APIPathPrefix = connection.APIPathPrefix
	return config, nil
}

func providerChannelConnection(config providerConfig) ChannelConnection {
	return ChannelConnection{AuthMode: config.AuthMode, AuthHeader: config.AuthHeader, APIPathPrefix: config.APIPathPrefix}
}

func validateProviderChannelConnection(ctx context.Context, config providerConfig) error {
	if !customChannelConnection(providerChannelConnection(config)) {
		return nil
	}
	if strings.TrimSpace(config.APIKey) == "" || len(config.APIKey) > 512 || strings.ContainsAny(config.APIKey, "\r\n") {
		return BadAuthRequest("The configured API key is invalid")
	}
	if format := strings.ToLower(strings.TrimSpace(config.APIFormat)); format != "" && format != "openai" {
		return BadAuthRequest("Custom authentication and path prefixes require a standard OpenAI protocol")
	}
	id := strings.TrimSpace(config.InterfaceType)
	if id == "" || id == "openai-image" {
		return nil
	}
	registry, present := protocolRegistryFromContext(ctx)
	if !present {
		registry = protocol.Builtins()
	}
	adapter, ok := registry.Resolve(id)
	if ok {
		switch adapter.Metadata().ID {
		case "chat-completion", "openai-response", "openai-image", "newapi", "newapi-channel-1", "newapi-channel-2":
			return nil
		}
	}
	return BadAuthRequest("Custom authentication and path prefixes are unsupported by this protocol")
}

func newProviderChannelRequest(ctx context.Context, config providerConfig, method, path string, body io.Reader) (*http.Request, error) {
	config, err := normalizeProviderChannelConnection(config)
	if err != nil {
		return nil, err
	}
	if err := validateProviderChannelConnection(ctx, config); err != nil {
		return nil, err
	}
	requestURL, err := ApplyChannelPathPrefix(apiURL(config.BaseURL, path), config.APIPathPrefix)
	if err != nil {
		return nil, err
	}
	if customChannelConnection(providerChannelConnection(config)) {
		if _, err := ApplyChannelPathPrefix(requestURL, "/"); err != nil {
			return nil, err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, err
	}
	ApplyOutboundHeaders(request, config.Headers)
	applyProviderAuth(request, config)
	rememberProviderCredential(request, config.APIKey)
	return request, nil
}

func validateProtocolChannelConnection(config providerConfig, spec protocol.RequestSpec) error {
	if !customChannelConnection(providerChannelConnection(config)) {
		return nil
	}
	auth := spec.Auth
	typeName := strings.ToLower(strings.TrimSpace(auth.Type))
	field := strings.ToLower(strings.TrimSpace(auth.Field))
	if spec.OriginPath || (typeName != "" && typeName != "bearer") || (auth.Header != "" && !strings.EqualFold(auth.Header, "Authorization")) || (auth.Prefix != "" && auth.Prefix != "Bearer ") || (field != "" && field != "apikey" && field != "api_key") || auth.SecretField != "" || auth.Query != "" || auth.Username != "" || auth.Service != "" || auth.Region != "" {
		return BadAuthRequest("Connection options cannot override protocol-specific authentication or origin paths")
	}
	for name := range spec.Headers {
		if strings.EqualFold(name, "Authorization") || (config.AuthMode == "api-key" && strings.EqualFold(name, config.AuthHeader)) {
			return BadAuthRequest("Connection authentication conflicts with protocol headers")
		}
	}
	return nil
}

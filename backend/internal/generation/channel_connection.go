package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

func channelConnection(config Config) outbound.ChannelConnection {
	return outbound.ChannelConnection{AuthMode: config.AuthMode, AuthHeader: config.AuthHeader, APIPathPrefix: config.APIPathPrefix}
}

func HasCustomChannelConnection(config Config) bool {
	mode := strings.ToLower(strings.TrimSpace(config.AuthMode))
	return (mode != "" && mode != "bearer") || strings.TrimSpace(config.AuthHeader) != "" || strings.TrimSpace(config.APIPathPrefix) != ""
}

// NormalizeChannelConfig keeps connection validation shared by config resolution,
// catalog discovery and the actual generation transport.
func NormalizeChannelConfig(config Config) (Config, error) {
	headers, err := outbound.NormalizeOutboundHeaders(config.Headers)
	if err != nil {
		return Config{}, err
	}
	connection, err := outbound.NormalizeChannelConnection(channelConnection(config), headers)
	if err != nil {
		return Config{}, err
	}
	config.Headers = headers
	config.AuthMode, config.AuthHeader, config.APIPathPrefix = connection.AuthMode, connection.AuthHeader, connection.APIPathPrefix
	return config, nil
}

// Callers normalize untrusted configuration before checking protocol policy.
func validateNormalizedChannelConfig(ctx context.Context, config Config) error {
	if !HasCustomChannelConnection(config) {
		return nil
	}
	if base, err := url.Parse(strings.TrimSpace(config.BaseURL)); err == nil && IsBeefAPIHost(base.Hostname()) {
		return outbound.BadAuthRequest("Connection options cannot override the managed BeefAPI transport")
	}
	if strings.TrimSpace(config.APIKey) == "" || len(config.APIKey) > 512 || strings.ContainsAny(config.APIKey, "\r\n") {
		return outbound.BadAuthRequest("The configured API key is invalid")
	}
	if format := strings.ToLower(strings.TrimSpace(config.APIFormat)); format != "" && format != "openai" {
		return outbound.BadAuthRequest("Custom authentication and path prefixes require a standard OpenAI protocol")
	}
	id := strings.TrimSpace(config.InterfaceType)
	if id == "" || id == "openai-image" {
		return nil
	}
	registry, present := ProtocolRegistryFromContext(ctx)
	if !present {
		registry = protocol.Builtins()
	}
	if adapter, ok := registry.Resolve(id); ok {
		switch adapter.Metadata().ID {
		case "chat-completion", "openai-response", "openai-image", "newapi", "newapi-channel-1", "newapi-channel-2":
			return nil
		}
	}
	return outbound.BadAuthRequest("Custom authentication and path prefixes are unsupported by this protocol")
}

// NewChannelRequest accepts a protocol-built absolute URL. Connection options
// may replace its standard endpoint prefix, but never select another origin.
func NewChannelRequest(ctx context.Context, config Config, method, rawURL string, body io.Reader) (*http.Request, error) {
	config, err := NormalizeChannelConfig(config)
	if err != nil {
		return nil, err
	}
	if err := validateNormalizedChannelConfig(ctx, config); err != nil {
		return nil, err
	}
	requestURL, err := channelRequestURL(config, rawURL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, err
	}
	outbound.ApplyOutboundHeaders(request, config.Headers)
	ApplyAuth(request, config)
	return request, nil
}

func channelRequestURL(config Config, rawURL string) (string, error) {
	if !HasCustomChannelConnection(config) {
		return rawURL, nil
	}
	if !SameProviderOrigin(config.BaseURL, rawURL) {
		return "", outbound.BadAuthRequest("Connection options cannot authenticate another origin")
	}
	if _, err := outbound.ApplyChannelPathPrefix(rawURL, "/"); err != nil {
		return "", err
	}
	return outbound.ApplyChannelPathPrefix(rawURL, config.APIPathPrefix)
}

func validateProtocolChannelConnection(config Config, spec protocol.RequestSpec) error {
	if !HasCustomChannelConnection(config) {
		return nil
	}
	auth := spec.Auth
	typeName := strings.ToLower(strings.TrimSpace(auth.Type))
	field := strings.ToLower(strings.TrimSpace(auth.Field))
	if spec.OriginPath || (typeName != "" && typeName != "bearer") || (auth.Header != "" && !strings.EqualFold(auth.Header, "Authorization")) || (auth.Prefix != "" && auth.Prefix != "Bearer ") || (field != "" && field != "apikey" && field != "api_key") || auth.SecretField != "" || auth.Query != "" || auth.Username != "" || auth.Service != "" || auth.Region != "" {
		return outbound.BadAuthRequest("Connection options cannot override protocol-specific authentication or origin paths")
	}
	for name := range spec.Headers {
		if strings.EqualFold(name, "Authorization") || (config.AuthMode == "api-key" && strings.EqualFold(name, config.AuthHeader)) {
			return outbound.BadAuthRequest("Connection authentication conflicts with protocol headers")
		}
	}
	return nil
}

type providerCredentialContext struct{}

func rememberProviderCredential(request *http.Request, apiKey string) {
	if apiKey != "" {
		*request = *request.WithContext(context.WithValue(request.Context(), providerCredentialContext{}, apiKey))
	}
}

func providerCredential(request *http.Request) string {
	secret, _ := request.Context().Value(providerCredentialContext{}).(string)
	return secret
}

func redactProviderRequestBytes(request *http.Request, value []byte) []byte {
	for _, pattern := range providerCredentialPatterns(providerCredential(request)) {
		value = bytes.ReplaceAll(value, pattern, []byte("[REDACTED]"))
	}
	return value
}

func providerCredentialPatterns(secret string) [][]byte {
	if secret == "" {
		return nil
	}
	// JSON/SSE may escape a valid header credential before echoing it. Keep
	// both JSON encoder forms as well as URL encodings used in diagnostics.
	encoded, _ := json.Marshal(secret)
	var plain bytes.Buffer
	encoder := json.NewEncoder(&plain)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(secret)
	plainJSON := strings.TrimSpace(plain.String())
	values := []string{secret, string(encoded[1 : len(encoded)-1]), plainJSON[1 : len(plainJSON)-1], url.QueryEscape(secret), url.PathEscape(secret)}
	seen := map[string]bool{}
	patterns := make([][]byte, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			patterns = append(patterns, []byte(value))
		}
	}
	sort.Slice(patterns, func(i, j int) bool { return len(patterns[i]) > len(patterns[j]) })
	return patterns
}

func redactProviderResponse(request *http.Request, value []byte, mimeType string, failed bool) []byte {
	if providerCredential(request) == "" {
		return value
	}
	if !failed {
		mime := strings.ToLower(mimeType)
		if strings.HasPrefix(mime, "image/") || strings.HasPrefix(mime, "video/") || strings.HasPrefix(mime, "audio/") {
			return value
		}
	}
	if json.Valid(value) {
		return redactProviderJSON(request, value)
	}
	if strings.Contains(strings.ToLower(mimeType), "event-stream") {
		redactor := providerStructuredStreamRedactor{request: request, mimeType: mimeType}
		return redactor.push(value, true)
	}
	if failed || textualProviderResponse(mimeType) {
		return redactProviderRequestBytes(request, value)
	}
	return value
}

func redactProviderJSON(request *http.Request, value []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	var payload any
	if decoder.Decode(&payload) != nil {
		return redactProviderRequestBytes(request, value)
	}
	var redact func(any) any
	redact = func(value any) any {
		switch typed := value.(type) {
		case string:
			return string(redactProviderRequestBytes(request, []byte(typed)))
		case []any:
			for index, item := range typed {
				typed[index] = redact(item)
			}
		case map[string]any:
			for name, item := range typed {
				typed[name] = redact(item)
			}
		}
		return value
	}
	encoded, err := json.Marshal(redact(payload))
	if err != nil {
		return redactProviderRequestBytes(request, value)
	}
	return encoded
}

// SSE is redacted per completed data line so split JSON strings remain private
// without rewriting numeric IDs or non-string protocol fields. JSON fallback
// responses are buffered until EOF by the existing bounded transport reader.
type providerStructuredStreamRedactor struct {
	request  *http.Request
	mimeType string
	pending  []byte
}

func (r *providerStructuredStreamRedactor) push(chunk []byte, final bool) []byte {
	r.pending = append(r.pending, chunk...)
	if !strings.Contains(strings.ToLower(r.mimeType), "event-stream") {
		if !final {
			return nil
		}
		result := redactProviderResponse(r.request, r.pending, r.mimeType, false)
		r.pending = nil
		return result
	}
	var output bytes.Buffer
	for {
		index := bytes.IndexByte(r.pending, '\n')
		if index < 0 && !final {
			break
		}
		if len(r.pending) == 0 {
			break
		}
		length := index + 1
		if index < 0 {
			length = len(r.pending)
		}
		line := r.pending[:length]
		if bytes.HasPrefix(line, []byte("data:")) {
			data := bytes.TrimSpace(line[len("data:"):])
			if json.Valid(data) {
				output.WriteString("data: ")
				output.Write(redactProviderJSON(r.request, data))
				if bytes.HasSuffix(line, []byte("\r\n")) {
					output.WriteString("\r\n")
				} else if bytes.HasSuffix(line, []byte("\n")) {
					output.WriteByte('\n')
				}
			} else {
				output.Write(redactProviderRequestBytes(r.request, line))
			}
		} else {
			output.Write(redactProviderRequestBytes(r.request, line))
		}
		r.pending = r.pending[length:]
	}
	return output.Bytes()
}

func textualProviderResponse(mimeType string) bool {
	mimeType = strings.ToLower(mimeType)
	return strings.HasPrefix(mimeType, "text/") || strings.Contains(mimeType, "json") || strings.Contains(mimeType, "xml")
}

// Keep typed causes for retry/uncertainty classification; only their rendered
// message is replaced. HTTPError bodies are redacted before constructing them.
type redactedProviderError struct {
	cause   error
	message string
}

func (e redactedProviderError) Error() string { return e.message }
func (e redactedProviderError) Unwrap() error { return e.cause }

func redactProviderError(request *http.Request, err error) error {
	if err == nil {
		return nil
	}
	if message := string(redactProviderRequestBytes(request, []byte(err.Error()))); message != err.Error() {
		return redactedProviderError{cause: err, message: message}
	}
	return err
}

func redactProviderObservation(observation TransportObservation, mimeType string) TransportObservation {
	request := observation.Request
	if request == nil || providerCredential(request) == "" {
		return observation
	}
	redact := func(value string) string { return string(redactProviderRequestBytes(request, []byte(value))) }
	clean := request.Clone(request.Context())
	for name, values := range clean.Header {
		for index, value := range values {
			clean.Header[name][index] = redact(value)
		}
	}
	clean.URL.Path, clean.URL.RawPath, clean.URL.RawQuery = redact(clean.URL.Path), redact(clean.URL.RawPath), redact(clean.URL.RawQuery)
	// Receipts do not own request bodies. A replay closure would expose the
	// authenticated payload to an observer without advancing the live request.
	clean.Body, clean.GetBody = nil, nil
	observation.Request = clean
	if json.Valid(observation.Body) {
		observation.Body = redactProviderJSON(request, observation.Body)
	} else if textualProviderResponse(mimeType) {
		observation.Body = redactProviderResponse(request, observation.Body, mimeType, observation.Err != nil)
	} else {
		observation.Body = redactProviderRequestBytes(request, observation.Body)
	}
	observation.Err = redactProviderError(request, observation.Err)
	observation.RequestID = redact(observation.RequestID)
	return observation
}

type providerStreamRedactor struct {
	secret, pending []byte
	patterns        [][]byte
}

func (r *providerStreamRedactor) push(chunk []byte, final bool) []byte {
	r.pending = append(r.pending, chunk...)
	if len(r.secret) == 0 {
		value := append([]byte(nil), r.pending...)
		r.pending = nil
		return value
	}
	if r.patterns == nil {
		r.patterns = providerCredentialPatterns(string(r.secret))
	}
	for _, pattern := range r.patterns {
		r.pending = bytes.ReplaceAll(r.pending, pattern, []byte("[REDACTED]"))
	}
	keep := 0
	if !final {
		for _, pattern := range r.patterns {
			for size := keep + 1; size < len(pattern) && size <= len(r.pending); size++ {
				if bytes.Equal(r.pending[len(r.pending)-size:], pattern[:size]) {
					keep = size
				}
			}
		}
	}
	value := append([]byte(nil), r.pending[:len(r.pending)-keep]...)
	r.pending = append([]byte(nil), r.pending[len(r.pending)-keep:]...)
	return value
}

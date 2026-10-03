package outbound

import (
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// ChannelConnection selects authentication from the existing API key and only
// changes the prefix of an already permitted standard endpoint.
type ChannelConnection struct {
	AuthMode      string `json:"authMode,omitempty"`
	AuthHeader    string `json:"authHeader,omitempty"`
	APIPathPrefix string `json:"apiPathPrefix,omitempty"`
}

func NormalizeChannelConnection(value ChannelConnection, headers []OutboundHeader) (ChannelConnection, error) {
	value.AuthMode = strings.ToLower(strings.TrimSpace(value.AuthMode))
	value.AuthHeader = strings.TrimSpace(value.AuthHeader)
	if value.AuthMode == "" {
		value.AuthMode = "bearer"
	}
	if value.AuthMode != "bearer" && value.AuthMode != "api-key" {
		return ChannelConnection{}, BadAuthRequest("渠道认证只支持 bearer 或 api-key")
	}
	if value.AuthMode == "bearer" {
		if value.AuthHeader != "" {
			return ChannelConnection{}, BadAuthRequest("Bearer 认证不能自定义认证头名称")
		}
	} else {
		if value.AuthHeader == "" {
			value.AuthHeader = "X-Api-Key"
		}
		if len(value.AuthHeader) > 128 || !validOutboundHeaderName(value.AuthHeader) || blockedOutboundHeader(strings.ToLower(value.AuthHeader)) {
			return ChannelConnection{}, BadAuthRequest("渠道认证头名称无效或由系统管理")
		}
		value.AuthHeader = http.CanonicalHeaderKey(value.AuthHeader)
		for _, header := range headers {
			if strings.EqualFold(strings.TrimSpace(header.Name), value.AuthHeader) {
				return ChannelConnection{}, BadAuthRequest("渠道认证头不能同时作为自定义请求头")
			}
		}
	}
	prefix := strings.TrimSpace(value.APIPathPrefix)
	if prefix != "" {
		// Percent escapes are unnecessary in an operator-configured prefix and
		// rejecting them prevents single/double-decoded traversal ambiguity.
		if len(prefix) > 1024 || !strings.HasPrefix(prefix, "/") || strings.HasPrefix(prefix, "//") || strings.ContainsAny(prefix, "%\\?#") {
			return ChannelConnection{}, BadAuthRequest("渠道路径前缀必须是合法的相对路径")
		}
		for _, character := range prefix {
			if character <= 32 || character >= 127 {
				return ChannelConnection{}, BadAuthRequest("渠道路径前缀包含非法字符")
			}
		}
		prefix = strings.TrimSuffix(prefix, "/")
		if prefix == "" {
			prefix = "/"
		}
		if path.Clean(prefix) != prefix {
			return ChannelConnection{}, BadAuthRequest("渠道路径前缀不允许路径跳转")
		}
	}
	value.APIPathPrefix = prefix
	return value, nil
}

func ApplyChannelAuth(request *http.Request, value ChannelConnection, apiKey string) {
	request.Header.Del("Authorization")
	if value.AuthMode == "api-key" {
		request.Header.Set(value.AuthHeader, apiKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
}

var standardChannelEndpoint = regexp.MustCompile(`(?:^|/)(models|responses|chat/completions|images/(?:generations|edits)|video/generations(?:/[^/]+)?|videos(?:/[^/]+(?:/content)?)?)$`)

// ApplyChannelPathPrefix replaces the entire origin-relative API prefix. The
// endpoint suffix, method, query and payload remain under the protocol's policy.
func ApplyChannelPathPrefix(rawURL string, prefix string) (string, error) {
	if prefix == "" {
		return rawURL, nil
	}
	normalized, err := NormalizeChannelConnection(ChannelConnection{APIPathPrefix: prefix}, nil)
	if err != nil {
		return "", err
	}
	target, err := url.Parse(rawURL)
	if err != nil || !target.IsAbs() || target.Host == "" || target.User != nil || target.Fragment != "" {
		return "", BadAuthRequest("渠道请求地址无效")
	}
	decoded, err := url.PathUnescape(target.EscapedPath())
	if err != nil || path.Clean(decoded) != decoded || strings.ContainsAny(decoded, "\\\x00") {
		return "", BadAuthRequest("渠道请求路径无效")
	}
	indices := standardChannelEndpoint.FindStringSubmatchIndex(decoded)
	if indices == nil {
		return "", BadAuthRequest("路径前缀只支持既有标准接口，非标准接口请使用声明式插件")
	}
	suffix := decoded[indices[2]:indices[3]]
	target.Path = strings.TrimSuffix(normalized.APIPathPrefix, "/") + "/" + suffix
	target.RawPath = ""
	return target.String(), nil
}

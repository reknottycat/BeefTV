package app

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

type ChannelModelsRequest struct {
	BaseURL       string           `json:"baseUrl"`
	APIKey        string           `json:"apiKey"`
	APIFormat     string           `json:"apiFormat"`
	InterfaceType string           `json:"interfaceType,omitempty"`
	Headers       []OutboundHeader `json:"headers"`
	AuthMode      string           `json:"authMode,omitempty"`
	AuthHeader    string           `json:"authHeader,omitempty"`
	APIPathPrefix string           `json:"apiPathPrefix,omitempty"`
	ChannelID     string           `json:"channelId"`
	CredentialRef string           `json:"credentialRef"`
}

func (s *Service) FetchChannelModels(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]string, error) {
	items, err := s.FetchChannelModelCatalog(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	return modelcatalog.CatalogModelIDs(items), nil
}

func (s *Service) FetchChannelModelCatalog(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, Unauthorized("请先登录")
	}
	connection := generation.Config{
		AuthMode: input.AuthMode, AuthHeader: input.AuthHeader, APIPathPrefix: input.APIPathPrefix,
	}
	// Reject overrides before resolving a managed secret into caller-controlled headers or paths.
	if generation.HasCustomChannelConnection(connection) && beefapi.IsManagedChannel(input.ChannelID, input.CredentialRef, input.BaseURL) {
		return nil, BadAuthRequest("Managed channels do not accept custom connection overrides")
	}
	if err := s.resolveChannelModelsRequest(&input); err != nil {
		return nil, err
	}
	config, err := generation.NormalizeChannelConfig(generation.Config{
		BaseURL: input.BaseURL, APIKey: input.APIKey, APIFormat: input.APIFormat,
		InterfaceType: input.InterfaceType, Headers: input.Headers,
		AuthMode: input.AuthMode, AuthHeader: input.AuthHeader, APIPathPrefix: input.APIPathPrefix,
	})
	if err != nil {
		return nil, mapOutboundError(err)
	}
	fetcher := func(ctx context.Context, baseURL, apiFormat, apiKey string, headers []modelcatalog.ChannelHeader) ([]byte, error) {
		config.BaseURL, config.APIFormat, config.APIKey, config.Headers = baseURL, apiFormat, apiKey, headers
		return s.fetchChannelModelCatalogBytes(ctx, config)
	}
	catalog, err := modelcatalog.LoadChannelModelCatalog(ctx, fetcher, input.BaseURL, input.APIFormat, input.APIKey, config.Headers, s.catalogExtraSource())
	if err != nil {
		return nil, mapChannelModelCatalogError(err)
	}
	return catalog, nil
}

func (s *Service) fetchChannelModelCatalogBytes(ctx context.Context, config generation.Config) ([]byte, error) {
	baseURL, apiFormat := config.BaseURL, config.APIFormat
	target := apiURL(baseURL, "/models")
	if apiFormat == "gemini" {
		if !strings.HasSuffix(strings.ToLower(baseURL), "/v1beta") {
			baseURL += "/v1beta"
		}
		target = baseURL + "/models"
	}
	request, err := generation.NewChannelRequest(ctx, config, http.MethodGet, target, nil)
	if err != nil {
		mapped := mapOutboundError(err)
		var authErr *AuthError
		if errors.As(mapped, &authErr) {
			return nil, mapped
		}
		return nil, BadAuthRequest("模型服务地址无效")
	}
	if _, err := ValidateOutboundURL(request.URL.String()); err != nil {
		return nil, err
	}
	data, _, err := generation.DoBinary(request)
	if err != nil {
		var httpErr providerHTTPError
		if errors.As(err, &httpErr) {
			return nil, modelcatalog.CatalogFetchError{StatusCode: httpErr.StatusCode, Cause: err}
		}
		return nil, modelcatalog.CatalogFetchError{Cause: err}
	}
	return data, nil
}

func (s *Service) catalogExtraSource() modelcatalog.CatalogExtraSource {
	if s == nil || !s.isPluginEnabled() {
		return nil
	}
	return extraChannelModelCatalogItems
}

func mapChannelModelCatalogError(err error) error {
	if err == nil {
		return nil
	}
	var fetchErr modelcatalog.CatalogFetchError
	if errors.As(err, &fetchErr) {
		return channelModelsUpstreamError(fetchErr.Cause)
	}
	var jsonErr modelcatalog.CatalogJSONError
	if errors.As(err, &jsonErr) {
		return WrapAppError(http.StatusBadGateway, jsonErr.Error(), jsonErr.Cause)
	}
	var rejected modelcatalog.CatalogUpstreamRejectedError
	if errors.As(err, &rejected) {
		return NewAppError(http.StatusBadGateway, rejected.Error())
	}
	return err
}

func channelModelsUpstreamError(err error) error {
	var authErr *AuthError
	if errors.As(err, &authErr) {
		return authErr
	}
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return WrapAppError(http.StatusBadGateway, "连接模型服务失败，请检查渠道地址和网络", err)
	}
	switch httpErr.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return NewAppError(http.StatusBadGateway, "模型服务鉴权失败，请检查 API Key")
	case http.StatusNotFound:
		return NewAppError(http.StatusBadGateway, "模型服务未提供 /models 接口")
	case http.StatusTooManyRequests:
		return NewAppError(http.StatusBadGateway, "模型服务请求过于频繁或额度不足")
	default:
		return WrapAppError(http.StatusBadGateway, httpErr.Error(), err)
	}
}

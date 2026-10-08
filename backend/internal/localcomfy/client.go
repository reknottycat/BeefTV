package localcomfy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

type Client struct {
	endpoint, token string
	http            *http.Client
}

// New accepts deployment configuration only. Every request still uses the
// existing strict outbound policy, exact private-host allowance and no redirects.
func New(endpoint, token string) (*Client, error) {
	endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fail(400, "adapter_endpoint_invalid", "本地适配器部署地址无效")
	}
	if strings.ContainsAny(token, "\r\n") {
		return nil, fail(400, "adapter_token_invalid", "本地适配器认证配置无效")
	}
	return &Client{endpoint: endpoint, token: token, http: outbound.CustomRelayHTTPClient(2 * time.Minute)}, nil
}

var reasonPattern = regexp.MustCompile(`^[a-z0-9_]{1,100}$`)

func (c *Client) bytes(ctx context.Context, method, path string, payload any, limit int64) ([]byte, error) {
	if c == nil {
		return nil, fail(503, "adapter_not_configured", "尚未配置本地生成适配器")
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n#") {
		return nil, fail(400, "adapter_path_invalid", "本地适配器请求路径无效")
	}
	target := c.endpoint + path
	if _, err := outbound.ValidateCustomRelayURL(target); err != nil {
		return nil, fail(503, "adapter_endpoint_rejected", "本地适配器地址未获部署出口策略许可")
	}
	var data []byte
	var err error
	if payload != nil {
		data, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	outbound.ApplyDefaultOutboundHeaders(req)
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fail(503, "adapter_unavailable", "无法连接本地适配器，请稍后查询原作业")
	}
	defer resp.Body.Close()
	if resp.ContentLength > limit {
		return nil, fail(502, "adapter_response_too_large", "本地适配器响应超过限制")
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, fail(502, "adapter_invalid_response", "本地适配器响应读取失败")
	}
	if resp.StatusCode != http.StatusOK {
		var body struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(data, &body)
		if !reasonPattern.MatchString(body.Reason) {
			body.Reason = "adapter_request_failed"
		}
		status := resp.StatusCode
		if status < 400 {
			status = 502
		}
		return nil, fail(status, body.Reason, "本地适配器请求失败（"+body.Reason+"）")
	}
	return data, nil
}
func (c *Client) request(ctx context.Context, method, path string, payload, target any) error {
	data, err := c.bytes(ctx, method, path, payload, 24<<20)
	if err != nil {
		return err
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Code != 0 || len(envelope.Data) == 0 {
		return fail(502, "adapter_invalid_response", "本地适配器返回无效数据")
	}
	if target != nil && json.Unmarshal(envelope.Data, target) != nil {
		return fail(502, "adapter_invalid_response", "本地适配器返回无效数据")
	}
	return nil
}
func (c *Client) Config(ctx context.Context) (Config, error) {
	var config Config
	if c == nil {
		return config, nil
	}
	err := c.request(ctx, http.MethodGet, "/config", nil, &config)
	config.Configured = true
	return config, err
}
func (c *Client) Recipes(ctx context.Context) ([]Recipe, error) {
	var recipes []Recipe
	err := c.request(ctx, http.MethodGet, "/recipes", nil, &recipes)
	return recipes, err
}
func (c *Client) Job(ctx context.Context, id string) (Job, error) {
	var job Job
	if !ValidID(id) {
		return job, fail(400, "invalid_job_id", "本地作业ID无效")
	}
	err := c.request(ctx, http.MethodGet, "/jobs/"+id, nil, &job)
	return job, err
}
func IsMissing(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Reason == "submission_unknown"
}

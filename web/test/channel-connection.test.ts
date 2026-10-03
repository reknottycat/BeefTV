import { expect, test } from "bun:test";
import {
    applyChannelAuth, applyChannelPathPrefix, channelConnectionForRequest, hasCustomChannelConnection,
    isStandardChannelConnectionProtocol, normalizeChannelConnection, redactChannelSecrets, validateChannelConnection,
} from "../src/lib/channel-connection";

test("legacy metadata keeps Bearer and the existing URL", () => {
    expect(normalizeChannelConnection({})).toEqual({ authMode: "bearer", authHeader: "", apiPathPrefix: "" });
    expect(hasCustomChannelConnection(normalizeChannelConnection({}))).toBe(false);
    expect(applyChannelPathPrefix("https://example.invalid/v1/models", "")).toBe("https://example.invalid/v1/models");
});

test("API Key headers normalize and authentication overrides caller Authorization", () => {
    const connection = normalizeChannelConnection({ authMode: " API-KEY ", authHeader: " x-test-auth " });
    const headers = new Headers({ Authorization: "Bearer TEST-stale", "X-Business": "TEST-business" });
    applyChannelAuth(headers, connection, "TEST-credential");
    expect(connection.authHeader).toBe("X-Test-Auth");
    expect(headers.get("X-Test-Auth")).toBe("TEST-credential");
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("X-Business")).toBe("TEST-business");
    expect(normalizeChannelConnection({ authMode: "api-key" }).authHeader).toBe("X-Api-Key");
    applyChannelAuth(headers, normalizeChannelConnection({}), "TEST-bearer");
    expect(headers.get("Authorization")).toBe("Bearer TEST-bearer");
});

test("authentication rejects reserved names and business-header collisions", () => {
    for (const authHeader of ["Host", "Authorization", "Cookie", "Content-Type", "Connection", "X-Canvas-Test", "X-Forwarded-Test", "x-goog-api-key", "bad name", "X-" + "a".repeat(128)]) {
        expect(() => normalizeChannelConnection({ authMode: "api-key", authHeader })).toThrow();
    }
    expect(() => normalizeChannelConnection({ authMode: "api-key", authHeader: "X-Auth" }, [{ name: " x-AUTH ", value: "TEST-value" }])).toThrow("渠道认证头不能同时作为自定义请求头");
    expect(() => normalizeChannelConnection({ authMode: "bearer", authHeader: "X-Auth" })).toThrow();
    expect(() => normalizeChannelConnection({ authMode: "basic" })).toThrow();
    expect(() => applyChannelAuth(new Headers(), normalizeChannelConnection({}), "TEST-secret\r\nX-Bad: 1")).toThrow("API Key 包含非法控制字符");
});

test("prefix normalization permits origin-relative API roots and checks byte lengths", () => {
    expect(normalizeChannelConnection({ apiPathPrefix: " /gateway/v1/ " }).apiPathPrefix).toBe("/gateway/v1");
    expect(normalizeChannelConnection({ apiPathPrefix: "/" }).apiPathPrefix).toBe("/");
    for (const apiPathPrefix of ["https://other.invalid", "gateway", "//other.invalid", "/a//b", "/a//", "/a/../b", "/./b", "/a?x=1", "/a#b", "/%2e", "/a\\b", "/a b", "/a\u007f", "/接口", "/" + "界".repeat(342), "/" + "a".repeat(1024)]) {
        expect(() => normalizeChannelConnection({ apiPathPrefix })).toThrow();
    }
});

test("prefix overrides every supported canonical endpoint while preserving origin and query", () => {
    for (const suffix of ["models", "responses", "chat/completions", "images/generations", "images/edits", "videos", "videos/TEST-task", "videos/TEST-task/content", "video/generations", "video/generations/TEST-task"]) {
        expect(applyChannelPathPrefix(`https://example.invalid/old/v1/${suffix}?alt=sse`, "/gateway/v2")).toBe(`https://example.invalid/gateway/v2/${suffix}?alt=sse`);
        expect(applyChannelPathPrefix(`https://example.invalid/v1/${suffix}`, "/")).toBe(`https://example.invalid/${suffix}`);
    }
});

test("prefix refuses arbitrary plugin paths, cross-origin metadata and traversal", () => {
    for (const url of ["https://example.invalid/generate", "https://example.invalid/v1/audio/speech", "https://user:TEST-secret@example.invalid/v1/models", "https://example.invalid/v1/models#fragment", "https://example.invalid/a/../models", "https://example.invalid/a/%2e%2e/models", "https://example.invalid/a//models", "file:///v1/models"]) {
        expect(() => applyChannelPathPrefix(url, "/gateway")).toThrow();
    }
});

test("custom fields reject nonstandard protocols without changing their legacy defaults", () => {
    expect(channelConnectionForRequest({ apiFormat: "gemini", interfaceType: "gemini-image" }).authMode).toBe("bearer");
    for (const interfaceType of ["chat-completion", "openai-response", "openai-image", "newapi", "newapi-channel-1", "newapi-channel-2", "openai-video", "openai-videos", "newapi-video-generations", undefined]) {
        expect(isStandardChannelConnectionProtocol(interfaceType)).toBe(true);
        expect(channelConnectionForRequest({ apiFormat: "openai", interfaceType, authMode: "api-key", apiPathPrefix: "/gateway" }).authMode).toBe("api-key");
    }
    for (const interfaceType of ["claude-api", "gemini-image", "xai-video", "volcengine-ark-video", "custom.plugin"]) {
        expect(isStandardChannelConnectionProtocol(interfaceType)).toBe(false);
        expect(() => channelConnectionForRequest({ apiFormat: "openai", interfaceType, apiPathPrefix: "/gateway" })).toThrow();
    }
    expect(() => channelConnectionForRequest({ apiFormat: "claude", authMode: "api-key" })).toThrow();
    expect(() => channelConnectionForRequest({ apiFormat: "openai", authMode: "api-key", apiKey: "" })).toThrow("当前渠道 API Key 无效");
    expect(() => channelConnectionForRequest({ apiFormat: "openai", apiPathPrefix: "/", apiKey: "a".repeat(513) })).toThrow("当前渠道 API Key 无效");
});

test("draft validation returns safe static copy and redact strips synthetic credentials", () => {
    expect(validateChannelConnection({})).toBeUndefined();
    const error = validateChannelConnection({ apiPathPrefix: "/TEST-secret?key=TEST-secret" });
    expect(error).toBe("渠道路径前缀必须是合法的相对路径");
    expect(error).not.toContain("TEST-secret");
    const payload = { error: { message: "upstream echoed TEST-secret", "TEST-secret": "TEST-header" }, request_id: "request-123" };
    const sanitized = redactChannelSecrets(payload, ["TEST-secret", "TEST-header"]);
    expect(JSON.stringify(sanitized)).not.toContain("TEST-secret");
    expect(JSON.stringify(sanitized)).not.toContain("TEST-header");
    expect(payload.error.message).toContain("TEST-secret");
});

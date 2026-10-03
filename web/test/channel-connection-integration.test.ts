import { afterEach, expect, test } from "bun:test";
import axios, { AxiosError } from "axios";
import { channelRequest } from "../src/services/api/custom-channel-relay";
import { ChannelResponseError, createChannelTransport } from "../src/services/api/channel-transport";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { fetchChannelModels } from "../src/services/api/image-models";
import { apiClient } from "../src/services/api/request";
import { channelConnectionSignature, createModelChannel, defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "../src/stores/use-config-store";

const originalWindow = globalThis.window;
const originalAxiosRequest = axios.request;
const originalApiRequest = apiClient.request;
const originalAdapter = axios.defaults.adapter;
afterEach(() => {
    if (originalWindow) globalThis.window = originalWindow;
    else Reflect.deleteProperty(globalThis, "window");
    axios.request = originalAxiosRequest;
    apiClient.request = originalApiRequest;
    axios.defaults.adapter = originalAdapter;
});

function testChannel() {
    return createModelChannel({
        id: "TEST-channel", name: "TEST-channel", baseUrl: "https://example.invalid/v1", apiKey: "TEST-only-credential",
        apiFormat: "openai", authMode: "api-key", authHeader: "X-Test-Auth", apiPathPrefix: "/gateway/v2",
        headers: [{ name: "X-Tenant", value: "TEST-business-header" }], models: ["opaque-model"],
        modelProfiles: [{ model: "opaque-model", capability: "text", protocol: "chat-completion" }],
    });
}

function stubLocation(protocol: string) {
    const window = new EventTarget();
    Object.defineProperty(window, "location", { value: { protocol, hostname: "example.invalid" } });
    globalThis.window = window as Window & typeof globalThis;
}

test("fields survive snapshot reopening, per-model resolution and task DTO rebuilding", () => {
    const channel = testChannel();
    const snapshot = JSON.parse(JSON.stringify({ config: { ...defaultConfig, channels: [channel], model: "TEST-channel::opaque-model", textModel: "TEST-channel::opaque-model" } }));
    const config = normalizeConfigSnapshot(snapshot).config;
    expect(config.channels[0]).toMatchObject({ authMode: "api-key", authHeader: "X-Test-Auth", apiPathPrefix: "/gateway/v2" });
    const resolved = resolveModelRequestConfig(config, "TEST-channel::opaque-model");
    expect(resolved).toMatchObject({ authMode: "api-key", authHeader: "X-Test-Auth", apiPathPrefix: "/gateway/v2" });
    expect(backendProviderConfig(config, "text")).toMatchObject({ authMode: "api-key", authHeader: "X-Test-Auth", apiPathPrefix: "/gateway/v2", headers: channel.headers });
    expect(channelConnectionSignature({ ...channel, apiPathPrefix: "/another" })).not.toBe(channelConnectionSignature(channel));
    expect(channelConnectionSignature({ ...channel, authHeader: "X-Another" })).not.toBe(channelConnectionSignature(channel));
    expect(() => normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ ...channel, apiPathPrefix: "/bad?TEST-key" }] } })).not.toThrow();
});

test("Web relay transports the credential in existing Bearer with separate canonical metadata", () => {
    stubLocation("http:");
    const request = channelRequest(testChannel(), "https://example.invalid/v1/responses", {
        "X-Canvas-Upstream-Auth-Mode": "forged", "X-Canvas-Upstream-Auth-Header": "Host", "X-Canvas-Upstream-API-Path-Prefix": "//bad.invalid",
    });
    expect(request.url).toBe("/api/ai/custom");
    expect(request.headers.authorization).toBe("Bearer TEST-only-credential");
    expect(request.headers["x-canvas-upstream-auth-mode"]).toBe("api-key");
    expect(request.headers["x-canvas-upstream-auth-header"]).toBe("X-Test-Auth");
    expect(request.headers["x-canvas-upstream-api-path-prefix"]).toBe("/gateway/v2");
    expect(request.headers["x-canvas-upstream-url"]).toBe("https://example.invalid/v1/responses");
    expect(request.headers["x-test-auth"]).toBeUndefined();
    expect(JSON.parse(atob(request.headers["x-canvas-upstream-headers"]))).toEqual(testChannel().headers);
    expect(request.url).not.toContain("TEST-only-credential");
});

test("Wails direct calls apply the approved prefix and selected auth without old Bearer", () => {
    stubLocation("wails:");
    const request = channelRequest(testChannel(), "https://example.invalid/v1/chat/completions", { Authorization: "Bearer TEST-old" });
    expect(request.url).toBe("https://example.invalid/gateway/v2/chat/completions");
    expect(request.credentials).toBe("omit");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-test-auth"]).toBe("TEST-only-credential");
    expect(request.headers["x-tenant"]).toBe("TEST-business-header");
});

test("backend catalogue DTO retains configured connection and business headers", async () => {
    let body: Record<string, unknown> = {};
    apiClient.request = (async (config) => {
        body = config.data as Record<string, unknown>;
        return { data: { code: 0, data: { models: ["opaque-model"] }, msg: "ok" } };
    }) as typeof apiClient.request;
    expect((await fetchChannelModels(testChannel(), true)).models).toEqual(["opaque-model"]);
    expect(body).toMatchObject({ authMode: "api-key", authHeader: "X-Test-Auth", apiPathPrefix: "/gateway/v2", headers: testChannel().headers });
});

test("local catalogue discovery also carries connection metadata and configured headers", async () => {
    let headers: Record<string, string> = {};
    axios.request = (async (config) => {
        headers = config.headers as Record<string, string>;
        return { data: { data: [{ id: "opaque-model" }] }, status: 200 };
    }) as typeof axios.request;
    expect((await fetchChannelModels(testChannel(), false)).models).toEqual(["opaque-model"]);
    expect(headers["x-canvas-upstream-auth-mode"]).toBe("api-key");
    expect(headers["x-canvas-upstream-api-path-prefix"]).toBe("/gateway/v2");
    expect(JSON.parse(atob(headers["x-canvas-upstream-headers"]))).toEqual(testChannel().headers);
});

test("JSON, multipart, polling and binary calls retain metadata without multipart content type", async () => {
    const captured: Array<Record<string, unknown>> = [];
    axios.request = (async (config) => {
        captured.push(config as unknown as Record<string, unknown>);
        return { data: config.responseType === "blob" ? new Blob(["TEST-media"], { type: "video/mp4" }) : { id: "TEST-task" }, status: 200 };
    }) as typeof axios.request;
    const transport = createChannelTransport(testChannel(), "video");
    await transport.postJson("https://example.invalid/v1/video/generations", { model: "opaque-model" });
    const form = new FormData(); form.set("model", "opaque-model");
    await transport.postForm("https://example.invalid/v1/videos", form);
    await transport.get("https://example.invalid/v1/videos/TEST-task");
    await transport.getBlob("https://example.invalid/v1/videos/TEST-task/content");
    expect(captured).toHaveLength(4);
    for (const item of captured) {
        const headers = item.headers as Record<string, string>;
        expect(headers["x-canvas-upstream-auth-header"]).toBe("X-Test-Auth");
        expect(headers["x-canvas-upstream-api-path-prefix"]).toBe("/gateway/v2");
    }
    expect((captured[1]!.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(captured[1]!.data).toBe(form);
    expect(captured[2]!.method).toBe("get");
    expect(captured[3]!.responseType).toBe("blob");
});

test("echoed fixture credentials never enter normalized error data or stacks", async () => {
    const channel = testChannel();
    axios.defaults.adapter = async (config) => {
        throw new AxiosError("TEST-only-credential", "ERR_BAD_RESPONSE", config, undefined, {
            config, data: { error: { code: "invalid_api_key", message: "Rejected TEST-only-credential TEST-business-header" } }, status: 401, statusText: "Unauthorized", headers: {},
        });
    };
    try {
        await createChannelTransport(channel, "image").postJson("https://example.invalid/v1/images/generations", {});
        throw new Error("mock response was unexpectedly accepted");
    } catch (error) {
        expect(error).toBeInstanceOf(ChannelResponseError);
        const diagnostic = JSON.stringify(error) + String((error as Error).stack);
        expect(diagnostic).not.toContain("TEST-only-credential");
        expect(diagnostic).not.toContain("TEST-business-header");
        expect((error as ChannelResponseError).code).toBe("invalid_api_key");
    }
});

test("URL credentials and special protocols are rejected with static messages", () => {
    expect(() => channelRequest(testChannel(), "https://TEST-only-credential@example.invalid/v1/models")).toThrow();
    expect(() => channelRequest(testChannel(), "https://example.invalid/v1/models?apiKey=TEST-only-credential")).toThrow();
    expect(() => channelRequest({ ...testChannel(), interfaceType: "custom.plugin" }, "https://example.invalid/generate")).toThrow();
});

import { afterEach, expect, test } from "bun:test";
import axios from "axios";
import { requestGeminiStreamingResponse, requestStreamingChatCompletion, requestStreamingClaude, requestStreamingResponse } from "../src/services/api/image-streaming";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) globalThis.window = originalWindow;
    else Reflect.deleteProperty(globalThis, "window");
});

const secret = "TEST-only-stream-credential";
const entries = [requestStreamingResponse, requestStreamingChatCompletion, requestStreamingClaude, requestGeminiStreamingResponse];

function config(): AiConfig {
    return { ...defaultConfig, baseUrl: "https://example.invalid/v1", apiKey: secret, model: "TEST-model" };
}

function chunksResponse(text: string) {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
            controller.close();
        },
    }), { headers: { "Content-Type": "text/event-stream" } });
}

test("all four streaming entry points redact a credential echoed by a split error frame", async () => {
    for (const entry of entries) {
        globalThis.fetch = (async () => chunksResponse(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: `Rejected ${secret}` } })}\n\n`)) as typeof fetch;
        try {
            await entry(config(), { model: "TEST-model" });
            throw new Error("accepted mock error frame");
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect(String((error as Error).message) + String((error as Error).stack) + JSON.stringify(error)).not.toContain(secret);
            expect((error as Error).message).toContain("[已隐藏]");
        }
    }
});

test("Chat SSE uses selected Wails auth and prefix while preserving payload and reasoning", async () => {
    const window = new EventTarget();
    Object.defineProperty(window, "location", { value: { protocol: "wails:" } });
    globalThis.window = window as Window & typeof globalThis;
    let calledUrl = "";
    let calledOptions: RequestInit | undefined;
    globalThis.fetch = (async (url, options) => {
        calledUrl = String(url); calledOptions = options;
        return chunksResponse('data: {"choices":[{"delta":{"reasoning_content":"TEST-reasoning"}}]}\n\ndata: {"choices":[{"delta":{"content":"TEST-answer"}}]}\n\n');
    }) as typeof fetch;
    let delta = ""; let reasoning = "";
    const output = await requestStreamingChatCompletion({ ...config(), authMode: "api-key", authHeader: "X-Test-Auth", apiPathPrefix: "/gateway" }, { model: "TEST-model", messages: [{ role: "user", content: "TEST-input" }] }, (value) => { delta = value; }, { onReasoning: (value) => { reasoning = value; } });
    expect(calledUrl).toBe("https://example.invalid/gateway/chat/completions");
    const headers = new Headers(calledOptions!.headers);
    expect(headers.get("X-Test-Auth")).toBe(secret);
    expect(headers.has("Authorization")).toBe(false);
    expect(JSON.parse(String(calledOptions!.body))).toEqual({ model: "TEST-model", messages: [{ role: "user", content: "TEST-input" }], stream: true });
    expect(output).toEqual({ content: "TEST-answer", toolCalls: [], reasoning: "TEST-reasoning" });
    expect(delta).toBe("TEST-answer");
    expect(reasoning).toBe("TEST-reasoning");
});

test("HTTP and JSON fallback errors cannot retain a reflected credential", async () => {
    for (const entry of entries) {
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: `Unauthorized ${secret}` } }), { status: 401, headers: { "Content-Type": "application/json" } })) as typeof fetch;
        try {
            await entry(config(), {});
            throw new Error("accepted mock HTTP rejection");
        } catch (error) {
            expect(String((error as Error).message) + String((error as Error).stack)).not.toContain(secret);
        }
    }
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: `Rejected ${secret}` } }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await expect(requestStreamingChatCompletion(config(), {})).rejects.toThrow("[已隐藏]");
});

test("fetch cancellation preserves the original AbortError and Axios cancellation identity", async () => {
    for (const cancellation of [new DOMException("TEST-abort", "AbortError"), new axios.CanceledError("TEST-cancel")]) {
        for (const entry of entries) {
            globalThis.fetch = (async () => { throw cancellation; }) as typeof fetch;
            await expect(entry(config(), {})).rejects.toBe(cancellation);
        }
    }
});

test("reader failures redact fixture credentials without retaining the raw error stack", async () => {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error(`TEST-reader reflected ${secret}`)); },
    }), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
    try {
        await requestStreamingResponse(config(), {});
        throw new Error("accepted mock reader failure");
    } catch (error) {
        expect((error as Error).message).toBe("TEST-reader reflected [已隐藏]");
        expect(String((error as Error).stack)).not.toContain(secret);
    }
});

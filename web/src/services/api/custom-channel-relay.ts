import { apiBaseURL } from "@/services/api/request";
import { applyChannelAuth, applyChannelPathPrefix, channelConnectionForRequest } from "@/lib/channel-connection";
import { isSystemProxyBaseUrl, MANAGED_BEEFAPI_CREDENTIAL_REF, type AiConfig, type ChannelHeader } from "@/stores/use-config-store";

type RelayConfig = Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "authMode" | "authHeader" | "apiPathPrefix"> & { headers?: ChannelHeader[]; credentialRef?: string; interfaceType?: string };

export type ChannelRequest = {
    url: string;
    headers: Record<string, string>;
    credentials: RequestCredentials;
};

function isManagedEnterpriseRelay(config: Pick<RelayConfig, "baseUrl" | "credentialRef">) {
    if (config.credentialRef === MANAGED_BEEFAPI_CREDENTIAL_REF) return true;
    try {
        return new URL((config.baseUrl || "").trim()).hostname.toLowerCase() === "enterprise.beefapi.com";
    } catch {
        return false;
    }
}

/** 自定义渠道统一经登录态后端中转，避免依赖第三方服务的浏览器 CORS。 */
export function channelRequest(config: RelayConfig, upstreamUrl: string, headers: HeadersInit = {}): ChannelRequest {
    if (/[\u0000-\u001f\u007f]/.test(config.apiKey)) throw new Error("API Key 包含非法控制字符");
    const normalizedHeaders = new Headers(headers);
    normalizedHeaders.delete("X-Canvas-Upstream-Auth-Mode");
    normalizedHeaders.delete("X-Canvas-Upstream-Auth-Header");
    normalizedHeaders.delete("X-Canvas-Upstream-API-Path-Prefix");
    const managed = isManagedEnterpriseRelay(config);
    const connection = channelConnectionForRequest(config);
    // Mac Wails uses wails:; WebView2 uses http://wails.localhost and still has CORS.
    if (typeof window !== "undefined" && window.location?.protocol === "wails:" && !managed) {
        const normalizedUpstreamUrl = applyChannelPathPrefix(requireHttpUrl(upstreamUrl, "当前模型请求地址"), connection.apiPathPrefix);
        for (const header of config.headers || []) {
            const name = header.name.trim();
            if (name) normalizedHeaders.set(name, header.value);
        }
        applyChannelAuth(normalizedHeaders, connection, config.apiKey);
        return { url: normalizedUpstreamUrl, headers: Object.fromEntries(normalizedHeaders.entries()), credentials: "omit" };
    }
    if (isSystemProxyBaseUrl(config.baseUrl)) {
        return { url: upstreamUrl, headers: Object.fromEntries(normalizedHeaders.entries()), credentials: "include" };
    }

    const normalizedBaseUrl = requireHttpUrl(config.baseUrl, "当前模型渠道 Base URL");
    const normalizedUpstreamUrl = requireHttpUrl(upstreamUrl, "当前模型请求地址");
    normalizedHeaders.delete("X-Canvas-Upstream-Headers");
    normalizedHeaders.delete("x-goog-api-key");
    normalizedHeaders.set("Authorization", `Bearer ${config.apiKey}`);
    normalizedHeaders.set("X-Canvas-Upstream-URL", normalizedUpstreamUrl);
    normalizedHeaders.set("X-Canvas-Upstream-Format", config.apiFormat === "gemini" ? "gemini" : config.apiFormat === "claude" ? "claude" : "openai");
    normalizedHeaders.set("X-Canvas-Upstream-Base-URL", normalizedBaseUrl);
    normalizedHeaders.set("X-Canvas-Upstream-Auth-Mode", connection.authMode);
    if (connection.authHeader) normalizedHeaders.set("X-Canvas-Upstream-Auth-Header", connection.authHeader);
    if (connection.apiPathPrefix) normalizedHeaders.set("X-Canvas-Upstream-API-Path-Prefix", connection.apiPathPrefix);
    if (config.headers?.length) normalizedHeaders.set("X-Canvas-Upstream-Headers", encodeChannelHeaders(config.headers));
    return {
        url: `${apiBaseURL.replace(/\/+$/u, "")}/ai/custom`,
        headers: Object.fromEntries(normalizedHeaders.entries()),
        credentials: "include",
    };
}

function requireHttpUrl(value: string, label: string) {
    const normalized = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error(`${label} 无效，请填写完整地址，例如：https://api.example.com/v1`);
    }
    if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash
        || Array.from(parsed.searchParams.keys()).some((key) => /^(?:api[_-]?key|secret[_-]?key|access[_-]?token|authorization|password|token)$/i.test(key))) {
        throw new Error(`${label} 无效，请填写完整地址，例如：https://api.example.com/v1`);
    }
    return parsed.toString();
}

function encodeChannelHeaders(headers: ChannelHeader[]) {
    const bytes = new TextEncoder().encode(JSON.stringify(headers));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

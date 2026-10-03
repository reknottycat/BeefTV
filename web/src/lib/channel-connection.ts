export type ChannelAuthMode = "bearer" | "api-key";

export type ChannelConnectionFields = {
    authMode?: ChannelAuthMode;
    authHeader?: string;
    apiPathPrefix?: string;
};

type HeaderEntry = { name: string; value: string };
type ConnectionInput = { authMode?: unknown; authHeader?: unknown; apiPathPrefix?: unknown };

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BLOCKED_HEADERS = new Set([
    "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "content-type", "accept",
    "connection", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "forwarded", "x-goog-api-key",
]);
const STANDARD_PROTOCOLS = new Set(["chat-completion", "openai-response", "openai-image", "newapi", "newapi-channel-1", "newapi-channel-2", "openai-video", "openai-videos", "newapi-video-generations"]);
const STANDARD_ENDPOINT = /(?:^|\/)(models|responses|chat\/completions|images\/(?:generations|edits)|video\/generations(?:\/[^/]+)?|videos(?:\/[^/]+(?:\/content)?)?)$/;

export function isStandardChannelConnectionProtocol(protocol?: string) {
    return !protocol?.trim() || STANDARD_PROTOCOLS.has(protocol.trim());
}

function metadataString(value: unknown, message: string) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new Error(message);
    return value.trim();
}

export function hasCustomChannelConnection(value: ConnectionInput) {
    return Boolean(value.authMode && value.authMode !== "bearer" || value.authHeader || value.apiPathPrefix);
}

export function normalizeChannelConnection(value: ConnectionInput, headers: readonly HeaderEntry[] = []) {
    const authMode = metadataString(value.authMode, "渠道认证模式无效").toLowerCase() || "bearer";
    if (authMode !== "bearer" && authMode !== "api-key") throw new Error("渠道认证只支持 bearer 或 api-key");
    let authHeader = metadataString(value.authHeader, "渠道认证头名称无效");
    if (authMode === "bearer") {
        if (authHeader) throw new Error("Bearer 认证不能自定义认证头名称");
    } else {
        authHeader ||= "X-Api-Key";
        const lower = authHeader.toLowerCase();
        if (authHeader.length > 128 || !HEADER_NAME.test(authHeader) || BLOCKED_HEADERS.has(lower) || lower.startsWith("x-canvas-") || lower.startsWith("x-forwarded-")) {
            throw new Error("渠道认证头名称无效或由系统管理");
        }
        if (headers.some((header) => header.name.trim().toLowerCase() === lower)) throw new Error("渠道认证头不能同时作为自定义请求头");
        authHeader = authHeader.toLowerCase().replace(/(^|-)([a-z])/g, (_, separator: string, character: string) => separator + character.toUpperCase());
    }
    let apiPathPrefix = metadataString(value.apiPathPrefix, "渠道路径前缀无效");
    if (apiPathPrefix) {
        if (new TextEncoder().encode(apiPathPrefix).length > 1024 || !apiPathPrefix.startsWith("/") || apiPathPrefix.includes("//") || /[%\\?#\u0000-\u0020\u007f-\uffff]/.test(apiPathPrefix)) {
            throw new Error("渠道路径前缀必须是合法的相对路径");
        }
        apiPathPrefix = apiPathPrefix.replace(/\/$/, "") || "/";
        if (apiPathPrefix.includes("//") || apiPathPrefix.split("/").some((part) => part === "." || part === "..")) throw new Error("渠道路径前缀不允许路径跳转");
    }
    return { authMode: authMode as ChannelAuthMode, authHeader, apiPathPrefix };
}

export function validateChannelConnection(value: ConnectionInput, headers: readonly HeaderEntry[] = []): string | undefined {
    try {
        normalizeChannelConnection(value, headers);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : "渠道连接配置无效";
    }
}

export function channelConnectionForRequest(value: ConnectionInput & { apiFormat?: string; interfaceType?: string; headers?: HeaderEntry[]; apiKey?: string }) {
    const connection = normalizeChannelConnection(value, value.headers);
    const format = value.apiFormat?.trim().toLowerCase();
    if (hasCustomChannelConnection(connection) && (format && format !== "openai" || !isStandardChannelConnectionProtocol(value.interfaceType))) {
        throw new Error("自定义认证和路径前缀只支持标准 OpenAI 接口，专用协议请保留原有配置");
    }
    if (hasCustomChannelConnection(connection) && value.apiKey !== undefined && (!value.apiKey.trim() || new TextEncoder().encode(value.apiKey).length > 512 || /[\u0000-\u001f\u007f]/.test(value.apiKey))) {
        throw new Error("当前渠道 API Key 无效");
    }
    return connection;
}

export function applyChannelAuth(headers: Headers, connection: ReturnType<typeof normalizeChannelConnection>, apiKey: string) {
    if (/[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error("API Key 包含非法控制字符");
    headers.delete("Authorization");
    try {
        if (connection.authMode === "api-key") headers.set(connection.authHeader, apiKey);
        else headers.set("Authorization", `Bearer ${apiKey}`);
    } catch {
        throw new Error("API Key 字符无法用于请求头");
    }
}

export function applyChannelPathPrefix(rawUrl: string, prefix: string) {
    if (!prefix) return rawUrl;
    const { apiPathPrefix } = normalizeChannelConnection({ apiPathPrefix: prefix });
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("渠道请求地址无效");
    }
    if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("渠道请求地址无效");
    // URL normalizes literal dot segments; inspect the original path first.
    const rawPath = rawUrl.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/, "").split(/[?#]/, 1)[0] || "/";
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(rawPath);
    } catch {
        throw new Error("渠道请求路径无效");
    }
    if (/[\\\u0000]/.test(decodedPath) || decodedPath.includes("//") || decodedPath.split("/").some((part) => part === "." || part === "..")) throw new Error("渠道请求路径无效");
    const matched = STANDARD_ENDPOINT.exec(decodedPath);
    if (!matched) throw new Error("路径前缀只支持既有标准接口，非标准接口请使用声明式插件");
    url.pathname = `${apiPathPrefix === "/" ? "" : apiPathPrefix}/${matched[1]}`;
    return url.toString();
}

export function redactChannelSecrets(value: unknown, secrets: readonly string[]): unknown {
    const tokens = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
    const redact = (text: string) => tokens.reduce((result, token) => result.split(token).join("[已隐藏]"), text);
    const seen = new WeakSet<object>();
    const visit = (entry: unknown, depth: number): unknown => {
        if (typeof entry === "string") return redact(entry);
        if (!entry || typeof entry !== "object") return entry;
        if (depth > 8 || seen.has(entry)) return "[已隐藏]";
        seen.add(entry);
        if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [redact(key), visit(item, depth + 1)]));
    };
    return visit(value, 0);
}

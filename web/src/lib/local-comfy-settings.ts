export function publicLocalComfyEndpoint(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
        const endpoint = new URL(value);
        if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return "";
        endpoint.username = "";
        endpoint.password = "";
        endpoint.search = "";
        endpoint.hash = "";
        return endpoint.toString().replace(/\/$/, "");
    } catch {
        return "";
    }
}

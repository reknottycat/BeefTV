const CATALOG_PATHS = new Set(["/api/local-comfy/v1/config", "/api/local-comfy/v1/recipes"]);

function isCatalogRead(request) {
    if (request?.method !== "GET") return false;
    try {
        const url = new URL(request.url);
        return url.protocol === "http:" && url.hostname === "127.0.0.1" && CATALOG_PATHS.has(url.pathname) && !url.search;
    } catch {
        return false;
    }
}

// StrictMode cancels an unmounted query's first request. Keep it as a failure
// unless a later request for that exact fixture URL finishes successfully.
export function createDirectorNetworkObserver(problems) {
    const requests = new Map();
    const cancellations = new Map();
    let sequence = 0;
    return {
        handle(method, event) {
            if (method === "Network.requestWillBeSent") {
                requests.set(event.requestId, { method: event.request.method, url: event.request.url, sequence: ++sequence });
                return;
            }
            const request = requests.get(event.requestId);
            if (method === "Network.responseReceived") {
                if (request) request.status = event.response.status;
                if (event.response.status >= 400) problems.push({ kind: "network.status", text: `${event.response.status} ${event.response.url}` });
                return;
            }
            if (method === "Network.loadingFailed") {
                const problem = { kind: "network.failed", text: `${event.type || "?"} ${event.errorText || "?"} canceled=${event.canceled === true} ${request?.method || "?"} ${request?.url || "?"}` };
                problems.push(problem);
                if (event.canceled === true && event.errorText === "net::ERR_ABORTED" && isCatalogRead(request)) {
                    const pending = cancellations.get(request.url) || [];
                    pending.push({ sequence: request.sequence, problem });
                    cancellations.set(request.url, pending);
                }
                requests.delete(event.requestId);
                return;
            }
            if (method === "Network.loadingFinished") {
                if (isCatalogRead(request) && request.status >= 200 && request.status < 300) {
                    const pending = cancellations.get(request.url) || [];
                    for (const item of pending) {
                        if (item.sequence >= request.sequence) continue;
                        const index = problems.indexOf(item.problem);
                        if (index !== -1) problems.splice(index, 1);
                    }
                    cancellations.set(request.url, pending.filter((item) => item.sequence >= request.sequence));
                }
                requests.delete(event.requestId);
            }
        },
        reset() {
            cancellations.clear();
        },
    };
}

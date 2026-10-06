import { expect, test } from "bun:test";
import { createDirectorNetworkObserver } from "../scripts/director-network-observer.mjs";

const url = "http://127.0.0.1:3000/api/local-comfy/v1/recipes";
function setup() {
    const problems: { kind: string; text: string }[] = [];
    const observer = createDirectorNetworkObserver(problems);
    const request = (id: string, target = url, method = "GET") => observer.handle("Network.requestWillBeSent", { requestId: id, request: { method, url: target } });
    const abort = (id: string, canceled = true, errorText = "net::ERR_ABORTED") => observer.handle("Network.loadingFailed", { requestId: id, type: "XHR", canceled, errorText });
    const response = (id: string, status = 200, target = url) => observer.handle("Network.responseReceived", { requestId: id, response: { status, url: target } });
    const finish = (id: string) => observer.handle("Network.loadingFinished", { requestId: id });
    return { problems, observer, request, abort, response, finish };
}

test("catalog cancellation remains a problem until a later identical GET completes", () => {
    const h = setup();
    h.request("first"); h.abort("first");
    expect(h.problems).toHaveLength(1);
    h.request("retry"); h.response("retry");
    expect(h.problems).toHaveLength(1);
    h.finish("retry");
    expect(h.problems).toHaveLength(0);
});

test("a prior successful request cannot excuse a later cancellation", () => {
    const h = setup();
    h.request("prior"); h.request("aborted"); h.abort("aborted");
    h.response("prior"); h.finish("prior");
    expect(h.problems).toHaveLength(1);
});

for (const [name, target, method, canceled, errorText] of [
    ["not explicitly canceled", url, "GET", false, "net::ERR_ABORTED"],
    ["real network error", url, "GET", true, "net::ERR_CONNECTION_REFUSED"],
    ["mutation", url, "POST", true, "net::ERR_ABORTED"],
    ["other endpoint", "http://127.0.0.1:3000/api/tasks", "GET", true, "net::ERR_ABORTED"],
    ["external host", "https://example.invalid/api/local-comfy/v1/recipes", "GET", true, "net::ERR_ABORTED"],
] as const) test(`${name} remains a failure even after a successful request`, () => {
    const h = setup();
    h.request("failed", target, method); h.abort("failed", canceled, errorText);
    h.request("retry", target, method); h.response("retry", 200, target); h.finish("retry");
    expect(h.problems).toHaveLength(1);
});

test("unsuccessful recovery and unrelated HTTP errors are never removed", () => {
    const h = setup();
    h.request("aborted"); h.abort("aborted");
    h.request("retry"); h.response("retry", 502); h.finish("retry");
    expect(h.problems).toHaveLength(2);
    h.request("success"); h.response("success"); h.finish("success");
    expect(h.problems).toHaveLength(1);
    expect(h.problems[0]!.text).toContain("502");
});

test("reset does not suppress unknown cancellations or clear another scenario's errors", () => {
    const h = setup();
    h.request("aborted"); h.abort("aborted"); h.problems.length = 0; h.observer.reset();
    h.abort("unknown"); h.request("retry"); h.response("retry"); h.finish("retry");
    expect(h.problems).toHaveLength(1);
});

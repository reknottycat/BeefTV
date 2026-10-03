import { expect, test } from "bun:test";
import { publicLocalComfyEndpoint } from "../src/lib/local-comfy-settings";

test("local workflow endpoint display preserves its host, port and configured path", () => {
    expect(publicLocalComfyEndpoint("http://192.0.2.10:8188/comfy/")).toBe("http://192.0.2.10:8188/comfy");
});

test("endpoint display excludes credentials, query parameters and fragments", () => {
    expect(publicLocalComfyEndpoint("https://synthetic-user:synthetic-pass@provider.example/comfy?key=synthetic-value#private")).toBe("https://provider.example/comfy");
});

test("missing or invalid endpoints remain explicitly unknown", () => {
    for (const value of [undefined, null, "", "not a URL"]) expect(publicLocalComfyEndpoint(value)).toBe("");
});

test("non HTTP endpoints cannot be displayed as an available ComfyUI address", () => {
    expect(publicLocalComfyEndpoint("javascript:alert(1)")).toBe("");
    expect(publicLocalComfyEndpoint("file:///private/settings")).toBe("");
});

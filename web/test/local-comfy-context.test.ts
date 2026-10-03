import { describe, expect, test } from "bun:test";
import { localComfyCanvasPath, localComfyJobActive, localComfyJobRetryable, localComfyReferenceProblem, localComfySeed } from "../src/pages/local-comfy/context";

describe("local Comfy workflow boundaries", () => {
    test("canvas handoff keeps private prompt and reference data out of the URL", () => {
        const path = localComfyCanvasPath({ projectId: "project a", nodeId: "node/1", shotId: "shot?2", prompt: "private script", referenceAssetIds: ["private asset"] });
        const parsed = new URL(path, "http://localhost");
        expect(parsed.pathname).toBe("/local-comfy");
        expect(parsed.searchParams.get("projectId")).toBe("project a");
        expect(parsed.searchParams.get("nodeId")).toBe("node/1");
        expect(parsed.searchParams.get("shotId")).toBe("shot?2");
        expect(parsed.searchParams.has("prompt")).toBe(false);
        expect(path).not.toContain("private");
    });
    test("uncertain submissions cannot become automatic retries", () => {
        expect(localComfyJobActive("submission_unknown")).toBe(false);
        expect(localComfyJobRetryable("submission_unknown")).toBe(false);
        expect(localComfyJobRetryable("running")).toBe(false);
        expect(localComfyJobRetryable("completed")).toBe(true);
        expect(localComfyJobRetryable("failed")).toBe(true);
    });
    test("polling only covers submitted active jobs", () => {
        expect(localComfyJobActive("submitted")).toBe(true);
        expect(localComfyJobActive("running")).toBe(true);
        expect(localComfyJobActive("completed")).toBe(false);
    });
    test("seed preserves zero and the maximum uint32 value", () => {
        expect(localComfySeed("0")).toBe(0);
        expect(localComfySeed("4294967295")).toBe(4294967295);
    });
    test("invalid seeds are rejected before any GPU submission", () => {
        for (const value of ["", "-1", "1.2", "4294967296", "NaN", "1e5"]) expect(() => localComfySeed(value)).toThrow();
    });
    const firstFrame = [{ role: "first_frame", width: 864, height: 480, mime_types: ["image/png"] }];
    test("a larger PNG with the same aspect ratio is a valid first frame", () => {
        expect(localComfyReferenceProblem(firstFrame, [{ mime_type: "image/png", width: 1728, height: 960 }])).toBe("");
        expect(localComfyReferenceProblem(undefined, [{ mime_type: "image/jpeg" }])).toBe("");
    });
    test("portrait references cannot be stretched into a landscape first frame", () => {
        expect(localComfyReferenceProblem(firstFrame, [{ mime_type: "image/png", width: 960, height: 1728 }])).toContain("相同画幅比例");
        expect(localComfyReferenceProblem(firstFrame, [{ mime_type: "image/png", width: 432, height: 240 }])).toContain("尺寸至少");
    });
    test("first-frame MIME and unknown dimensions are rejected before submission", () => {
        expect(localComfyReferenceProblem(firstFrame, [{ mime_type: "image/jpeg", width: 864, height: 480 }])).toContain("PNG");
        expect(localComfyReferenceProblem(firstFrame, [{ mime_type: "image/png" }])).toContain("尺寸尚未读取");
    });
});

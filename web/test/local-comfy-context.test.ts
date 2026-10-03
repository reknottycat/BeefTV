import { describe, expect, test } from "bun:test";
import type { LocalComfyProject, LocalComfyShot } from "../src/services/api/local-comfy";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { loadMissingLocalComfyCanvas, localComfyCanvasPath, localComfyJobActive, localComfyJobRetryable, localComfyMatchesCanvas, localComfyProjectForCanvas, localComfyProjectInput, localComfyProjectMatchesCanvas, localComfyReferenceProblem, localComfySeed, localComfyShotForContext, localComfySourceForContext } from "../src/pages/local-comfy/context";

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

const canvasContext = { projectId: "canvas-a", nodeId: "image-a", shotId: "native-shot-a" };
const canvas = {
    id: "canvas-a", projectId: "native-project-a", revision: 4, title: "Canvas",
    nodes: [
        { id: "image-a", type: "image", metadata: { directorShotId: "native-shot-a", prompt: "Shot A" } },
        { id: "image-b", type: "image", metadata: { directorShotId: "native-shot-b", prompt: "Shot B" } },
    ],
    connections: [],
} as unknown as CanvasProject;
const sidecar = (patch: Partial<LocalComfyProject> = {}): LocalComfyProject => ({
    id: "sidecar-a", name: "Sidecar", upstream_project_id: "native-project-a", canvas_project_id: "canvas-a",
    storage_scope: "sidecar", script: "", created_at: "2026-10-03T00:00:00Z", ...patch,
});
const shot = (patch: Partial<LocalComfyShot> = {}): LocalComfyShot => ({
    id: "sidecar-shot-a", project_id: "sidecar-a", name: "Shot A", upstream_shot_id: "native-shot-a",
    reference_asset_ids: [], created_at: "2026-10-03T00:00:00Z", ...patch,
});

describe("local Comfy canvas and native project isolation", () => {
    test("new registration keeps native project and canvas IDs separate", () => {
        expect(localComfyProjectInput("Local", "canvas-a", canvas)).toEqual({ name: "Local", upstream_project_id: "native-project-a", canvas_project_id: "canvas-a" });
        expect(localComfyProjectInput("Standalone", "", undefined)).toEqual({ name: "Standalone", upstream_project_id: undefined, canvas_project_id: undefined });
        expect(() => localComfyProjectInput("Local", "canvas-a", undefined)).toThrow();
        expect(() => localComfyProjectInput("Local", "canvas-b", canvas)).toThrow();
    });
    test("an explicit canvas association cannot fall back to a different canvas", () => {
        expect(localComfyProjectMatchesCanvas(sidecar(), canvas)).toBe(true);
        expect(localComfyProjectMatchesCanvas(sidecar({ canvas_project_id: "canvas-b" }), canvas)).toBe(false);
        expect(localComfyProjectMatchesCanvas(sidecar({ upstream_project_id: "native-project-b" }), canvas)).toBe(false);
    });
    test("legacy canvas upstream IDs remain readable without rewriting records", () => {
        const legacy = sidecar({ upstream_project_id: "canvas-a", canvas_project_id: undefined });
        const original = structuredClone(legacy);
        expect(localComfyProjectMatchesCanvas(legacy, canvas)).toBe(true);
        expect(localComfyProjectMatchesCanvas({ ...legacy, canvas_project_id: "" }, canvas)).toBe(true);
        expect(legacy).toEqual(original);
    });
    test("native-only records need the actual loaded canvas relationship", () => {
        const nativeOnly = sidecar({ canvas_project_id: undefined });
        expect(localComfyProjectMatchesCanvas(nativeOnly, undefined)).toBe(false);
        expect(localComfyProjectMatchesCanvas(nativeOnly, { id: "canvas-a" })).toBe(false);
        expect(localComfyProjectMatchesCanvas(nativeOnly, { id: "canvas-a", projectId: "native-project-b" })).toBe(false);
        expect(localComfyProjectMatchesCanvas(nativeOnly, canvas)).toBe(true);
    });
    test("an explicit canvas registration takes precedence over legacy matches", () => {
        const nativeOnly = sidecar({ id: "native-only", canvas_project_id: undefined });
        const legacy = sidecar({ id: "legacy", upstream_project_id: "canvas-a", canvas_project_id: undefined });
        const explicit = sidecar();
        expect(localComfyProjectForCanvas([nativeOnly, legacy, explicit], canvas)).toBe(explicit);
        expect(localComfyProjectForCanvas([nativeOnly, legacy], canvas)).toBe(legacy);
        expect(localComfyProjectForCanvas([explicit], undefined)).toBeUndefined();
    });
    test("query context changes select the matching shot without guessing the first", () => {
        const shots = [shot(), shot({ id: "sidecar-shot-b", upstream_shot_id: "native-shot-b" })];
        expect(localComfyShotForContext(shots, canvasContext)?.id).toBe("sidecar-shot-a");
        expect(localComfyShotForContext(shots, { ...canvasContext, shotId: "native-shot-b" })?.id).toBe("sidecar-shot-b");
        expect(localComfyShotForContext(shots, { ...canvasContext, shotId: "missing" })).toBeUndefined();
        expect(localComfyShotForContext(shots, { projectId: "" })?.id).toBe("sidecar-shot-a");
    });
    test("node and director shot must both match before carrying its prompt", () => {
        expect(localComfySourceForContext(canvasContext, canvas)?.metadata?.prompt).toBe("Shot A");
        expect(localComfySourceForContext({ ...canvasContext, nodeId: "image-b", shotId: "native-shot-b" }, canvas)?.metadata?.prompt).toBe("Shot B");
        expect(localComfySourceForContext({ ...canvasContext, shotId: "native-shot-b" }, canvas)).toBeUndefined();
        expect(localComfySourceForContext({ ...canvasContext, projectId: "canvas-b" }, canvas)).toBeUndefined();
    });
    test("binding rejects another sidecar's shot and another shot's job", () => {
        const job = { project_id: "sidecar-a", shot_id: "sidecar-shot-a" };
        expect(localComfyMatchesCanvas(canvasContext, canvas, sidecar(), shot(), job)).toBe(true);
        expect(localComfyMatchesCanvas(canvasContext, canvas, sidecar(), shot({ project_id: "sidecar-b" }), job)).toBe(false);
        expect(localComfyMatchesCanvas(canvasContext, canvas, sidecar(), shot(), { ...job, shot_id: "sidecar-shot-b" })).toBe(false);
        expect(localComfyMatchesCanvas(canvasContext, canvas, sidecar(), shot(), { ...job, project_id: "sidecar-b" })).toBe(false);
        expect(localComfyMatchesCanvas(canvasContext, undefined, sidecar(), shot(), job)).toBe(false);
    });
    test("an idle technical image can link its own sidecar shot without borrowing a production shot", () => {
        const technical = { ...canvas, nodes: [{ ...canvas.nodes[0], id: "technical-source", metadata: { status: "idle" as const, nodeRole: "generator" as const, prompt: "Technical illustration" } }] };
        const context = { projectId: canvas.id, nodeId: "technical-source" };
        const technicalShot = shot({ id: "technical-shot", upstream_shot_id: "technical-source" });
        expect(localComfyMatchesCanvas(context, technical, sidecar(), technicalShot, { project_id: "sidecar-a", shot_id: "technical-shot" })).toBe(true);
        expect(localComfyMatchesCanvas({ ...context, shotId: "native-shot-a" }, technical, sidecar(), technicalShot)).toBe(false);
        expect(technical.nodes[0].metadata.status).toBe("idle");
        expect(canvas.nodes).toHaveLength(2);
    });
});

describe("local Comfy cold canvas loading", () => {
    test("a missing canvas is loaded once with its real native relationship", async () => {
        let current: CanvasProject | undefined;
        let reads = 0;
        const result = await loadMissingLocalComfyCanvas("canvas-a", {
            readCurrent: () => current, load: async () => { reads++; return canvas; },
            publish: (loaded) => { current = loaded; }, active: () => true,
        });
        expect(result).toBe(canvas);
        expect(current?.projectId).toBe("native-project-a");
        expect(reads).toBe(1);
    });
    test("an existing draft prevents even a backend read", async () => {
        let reads = 0;
        let publishes = 0;
        expect(await loadMissingLocalComfyCanvas("canvas-a", {
            readCurrent: () => canvas, load: async () => { reads++; return canvas; },
            publish: () => { publishes++; }, active: () => true,
        })).toBe(canvas);
        expect(reads).toBe(0);
        expect(publishes).toBe(0);
    });
    test("a draft loaded while the request waits is never overwritten", async () => {
        let current: CanvasProject | undefined;
        let finish!: (value: CanvasProject) => void;
        let publishes = 0;
        const pending = loadMissingLocalComfyCanvas("canvas-a", {
            readCurrent: () => current, load: () => new Promise<CanvasProject>((resolve) => { finish = resolve; }),
            publish: () => { publishes++; }, active: () => true,
        });
        const draft = { ...canvas, title: "Unsaved edit", revision: 5 };
        current = draft;
        finish(canvas);
        expect(await pending).toBe(draft);
        expect(current.title).toBe("Unsaved edit");
        expect(current.revision).toBe(5);
        expect(publishes).toBe(0);
    });
    test("a departed route cannot publish its late canvas response", async () => {
        let publishes = 0;
        expect(await loadMissingLocalComfyCanvas("canvas-a", {
            readCurrent: () => undefined, load: async () => canvas,
            publish: () => { publishes++; }, active: () => false,
        })).toBeUndefined();
        expect(publishes).toBe(0);
    });
    test("a mismatched canvas response fails without updating the cache", async () => {
        let publishes = 0;
        await expect(loadMissingLocalComfyCanvas("canvas-a", {
            readCurrent: () => undefined, load: async () => ({ ...canvas, id: "canvas-b" }),
            publish: () => { publishes++; }, active: () => true,
        })).rejects.toThrow("ID");
        expect(publishes).toBe(0);
    });
});

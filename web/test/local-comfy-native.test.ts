import { describe, expect, test } from "bun:test";
import { localComfyCatalogState } from "../src/lib/use-local-comfy-model-catalog";
import { localComfyGenerationProblem, localComfyRecipeSupportProblem, localComfySelectableModels } from "../src/lib/local-comfy-models";
import { backendProviderConfig, parseBackendGenerationResult, prepareBackendGenerationTask, runBackendGenerationTaskBatch, submitBackendGenerationTask, type GenerationTaskDependencies } from "../src/services/api/generation-task";
import { canRetrieveProviderResult, type CreateTaskInput, type GenerationTask } from "../src/services/api/task-center";
import { defaultConfig, normalizeConfigSnapshot, selectableModelsByCapability, type AiConfig } from "../src/stores/use-config-store";
import { buildGenerationConfig, resolveCanvasGenerationModel } from "../src/lib/canvas/canvas-project-generation";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { projectGenerationModelSelection } from "../src/lib/project-generation-model-defaults";
import { taskRetryBlocked, providerCancelStatusLabel } from "../src/pages/tasks/task-shared";
import type { LocalComfyConfig, LocalComfyRecipe } from "../src/services/api/local-comfy";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const version = "a".repeat(64);
const recipes: LocalComfyRecipe[] = [
    { id: "my-image", name: "我的图片配方", mode: "t2i", reference_slots: 0, ready: true, recipe_version: version, output: { width: 768, height: 512 } },
    { id: "my-video", name: "我的视频配方", mode: "i2v", reference_slots: 1, ready: true, recipe_version: version, output: { width: 864, height: 480, fps: 24, duration_seconds: 124 / 24, mime_type: "video/mp4" }, reference_constraints: [{ role: "first_frame", width: 864, height: 480, mime_types: ["image/png"] }] },
];
const runtime: LocalComfyConfig = { configured: true, generation_enabled: true, max_reference_bytes: 32 * 1024 * 1024, recipe_count: recipes.length };
function config(mode: "image" | "video" = "image"): AiConfig {
    return { ...defaultConfig, ...localComfyCatalogState({ config: runtime, recipes, failed: false }), model: `local-comfy:my-${mode}`, imageModel: "local-comfy:my-image", videoModel: "local-comfy:my-video", apiKey: "TEST-SECRET-NOT-FOR-COMFY", baseUrl: "https://example.invalid/cloud" };
}
function task(status: GenerationTask["status"] = "queued", type = "canvas_image"): GenerationTask {
    return { id: "native-1", type, provider: "local-comfy", model: "local-comfy:my-image", prompt: "TEST", status, attempts: 1, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" };
}
function backend() {
    const requests: CreateTaskInput[] = [];
    const ids = new Map<string, GenerationTask>();
    const dependencies: GenerationTaskDependencies = {
        createId: () => `operation-${requests.length}`,
        async createTask(input) {
            requests.push(input);
            const key = (input.input?.metadata as { clientOperationId: string }).clientOperationId;
            if (!ids.has(key)) ids.set(key, { ...task(), id: `task-${ids.size}`, clientOperationId: key });
            return ids.get(key)!;
        },
        async waitTask(_id, options) {
            return { ...options!.initialTask!, status: "succeeded", resultJson: JSON.stringify({ images: [{ storageKey: "resource:result-1", url: "/api/resources/result-1/file" }] }) };
        },
    };
    return { requests, ids, dependencies };
}

describe("native Comfy availability is an explicit current contract", () => {
    test("first load, offline, no connection, no recipes, disabled, unsupported and ready stay distinct", () => {
        expect(localComfyCatalogState({ failed: false }).localComfyStatus).toBe("loading");
        expect(localComfyCatalogState({ failed: true }).localComfyStatus).toBe("offline");
        expect(localComfyCatalogState({ config: { ...runtime, configured: false }, failed: false }).localComfyStatus).toBe("unconfigured");
        expect(localComfyCatalogState({ config: runtime, recipes: [], failed: false }).localComfyStatus).toBe("empty");
        expect(localComfyCatalogState({ config: { ...runtime, generation_enabled: false }, recipes, failed: false }).localComfyStatus).toBe("disabled");
        expect(localComfyCatalogState({ config: runtime, recipes: [{ ...recipes[0], output: undefined }], failed: false }).localComfyStatus).toBe("unsupported");
        expect(localComfyCatalogState({ config: runtime, recipes: [{ ...recipes[0], ready: false }], failed: false }).localComfyStatus).toBe("not_ready");
        expect(config().localComfyStatus).toBe("ready");
    });
    test("last readable recipes survive offline but cannot submit; a refresh with cached data remains ready", () => {
        const offline = localComfyCatalogState({ config: runtime, recipes, failed: true });
        expect(offline.localComfyModels).toBe(recipes);
        expect(localComfyGenerationProblem(offline, "local-comfy:my-image")).toContain("无法连接");
        expect(offline.localComfyGenerationEnabled).toBe(false);
        expect(localComfyCatalogState({ config: runtime, recipes, failed: false }).localComfyGenerationEnabled).toBe(true);
    });
    test("arbitrary registered IDs work only with versioned, supported output contracts", () => {
        expect(localComfySelectableModels(config(), "image")).toEqual(["local-comfy:my-image"]);
        expect(localComfyRecipeSupportProblem({ ...recipes[1], output: { width: 864, height: 480 } })).toContain("帧率或时长");
        expect(localComfyRecipeSupportProblem({ ...recipes[0], recipe_version: "" })).toContain("版本");
        expect(localComfyRecipeSupportProblem({ ...recipes[1], output: { ...recipes[1].output!, mime_type: "video/webm" } })).toContain("仅支持 MP4");
        expect(localComfyRecipeSupportProblem({ ...recipes[1], output: { ...recipes[1].output!, mime_type: undefined } })).toContain("仅支持 MP4");
        expect(localComfySelectableModels({ localComfyModels: [{ ...recipes[0], output: undefined }] })).toEqual([]);
        expect(selectableModelsByCapability(config(), "text")).toEqual([]);
        expect(modelCapabilityConfigFor(config(), "local-comfy:my-image").image?.size.default).toBe("768x512");
        expect(modelCapabilityConfigFor(config(), "local-comfy:my-video").video?.duration.default).toBe(124 / 24);
    });
    test("hydration keeps saved local choices but never restores permission or recipe cache", () => {
        const restored = normalizeConfigSnapshot({ config: config() }).config;
        expect(restored.imageModel).toBe("local-comfy:my-image");
        expect(restored.localComfyModels).toBeUndefined();
        expect(restored.localComfyGenerationEnabled).toBeUndefined();
        expect(restored.localComfyStatus).toBeUndefined();
        expect(restored.textModel).not.toStartWith("local-comfy:");
        expect(resolveCanvasGenerationModel(restored, "local-comfy:removed", "image")).toBe("local-comfy:removed");
        const node = { id: "node-1", type: CanvasNodeType.Image, metadata: { model: "local-comfy:removed" } } as CanvasNodeData;
        expect(buildGenerationConfig(restored, node, "image").model).toBe("local-comfy:removed");
    });
    test("project catalog updates cannot replace a manual local selection with the cloud default", () => {
        const current = "local-comfy:my-video";
        const cloudDefault = "cloud::video";
        for (const failed of [true, false]) {
            const refreshed = localComfyCatalogState({ config: runtime, recipes, failed });
            expect(refreshed.localComfyStatus).toBe(failed ? "offline" : "ready");
            expect(projectGenerationModelSelection(current, cloudDefault, false)).toBe(current);
        }
        expect(projectGenerationModelSelection(current, cloudDefault, true)).toBe(cloudDefault);
        expect(projectGenerationModelSelection("", current, false)).toBe(current);
    });
});

describe("native Comfy generation and original-job recovery", () => {
    test("request is version-pinned, owns references and never sends a cloud key or base URL", async () => {
        const input = await prepareBackendGenerationTask({ mode: "image", prompt: "TEST", config: config(), clientOperationId: "stable-1" });
        expect(input.provider).toBe("local-comfy");
        expect(input.input?.localComfy).toEqual({ recipeId: "my-image", recipeVersion: version, seed: 0 });
        expect(JSON.stringify(input)).not.toContain("TEST-SECRET");
        expect(JSON.stringify(input)).not.toContain("example.invalid");
        expect(backendProviderConfig(config())).toEqual({});
    });
    test("offline and disabled states block before any backend task is created", async () => {
        const mock = backend();
        for (const status of ["offline", "disabled"] as const) {
            const current = { ...config(), localComfyStatus: status, localComfyGenerationEnabled: false };
            await expect(submitBackendGenerationTask({ mode: "image", prompt: "TEST", config: current }, mock.dependencies)).rejects.toThrow();
            await expect(runBackendGenerationTaskBatch({ mode: "image", prompt: "TEST", config: current, count: 2 }, mock.dependencies)).rejects.toThrow();
        }
        expect(mock.requests).toHaveLength(0);
    });
    test("video requires exact owned first frame and does not inherit Ark URLs", async () => {
        const current = { ...config("video"), baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" };
        const options = { mode: "video" as const, prompt: "TEST", config: current, clientOperationId: "video-1" };
        const image = { id: "ref-1", name: "ref.png", type: "image/png", dataUrl: "", storageKey: "resource:ref-1", width: 864, height: 480, arkAssetId: "must-not-use" };
        const input = await prepareBackendGenerationTask({ ...options, referenceImages: [image] });
        expect(input.input?.referenceImages).toMatchObject([{ storageKey: "resource:ref-1" }]);
        expect(JSON.stringify(input)).not.toContain("asset://");
        await expect(prepareBackendGenerationTask({ ...options, referenceImages: [{ ...image, width: 1728, height: 960 }] })).resolves.toMatchObject({ provider: "local-comfy" });
        await expect(prepareBackendGenerationTask({ ...options, referenceImages: [{ ...image, width: 1728, height: 1080 }] })).rejects.toThrow("比例");
        await expect(prepareBackendGenerationTask({ ...options, referenceImages: [] })).rejects.toThrow("需要 1 张");
        await expect(prepareBackendGenerationTask({ ...options, referenceImages: [{ ...image, storageKey: undefined, url: "https://example.invalid/image.png" }] })).rejects.toThrow("不能直接引用外部");
        await expect(prepareBackendGenerationTask({ ...options, referenceImages: [{ ...image, width: 1 }] })).rejects.toThrow("864×480");
    });
    test("replays retain a stable operation identity and batch items get separate identities", async () => {
        const mock = backend();
        const options = { mode: "image" as const, prompt: "TEST", config: config(), clientOperationId: "same" };
        expect((await submitBackendGenerationTask(options, mock.dependencies)).id).toBe((await submitBackendGenerationTask(options, mock.dependencies)).id);
        expect(mock.ids.size).toBe(1);
        await runBackendGenerationTaskBatch({ ...options, clientOperationId: "batch", count: 2 }, mock.dependencies);
        expect(mock.requests.slice(2).map((input) => (input.input?.metadata as { clientOperationId: string }).clientOperationId)).toEqual(["batch:0", "batch:1"]);
    });
    test("cancelled/failed image and video can retrieve an original job even if submission receipt was lost", () => {
        for (const status of ["failed", "cancelled"] as const) for (const kind of ["canvas_image", "canvas_video"]) {
            expect(canRetrieveProviderResult(task(status, kind))).toBe(true);
            expect(taskRetryBlocked(task(status, kind))).toBe(true);
        }
        expect(canRetrieveProviderResult(task("running"))).toBe(false);
        expect(canRetrieveProviderResult({ ...task("cancelled"), provider: "other" })).toBe(false);
        expect(providerCancelStatusLabel(task("cancelled"))).toContain("GPU 任务可能仍在运行");
    });
    test("sidecar URLs are never accepted as native result resources", () => {
        expect(() => parseBackendGenerationResult({ ...task("succeeded"), resultJson: JSON.stringify({ images: [{ url: "/adapter/asset/1" }] }) })).toThrow("归档");
        expect(parseBackendGenerationResult({ ...task("succeeded"), resultJson: JSON.stringify({ images: [{ storageKey: "resource:result-1", url: "/api/resources/result-1/file" }] }) }).images?.[0].dataUrl).toBe("/api/resources/result-1/file");
    });
});

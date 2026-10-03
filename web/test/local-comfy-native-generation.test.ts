import { describe, expect, test } from "bun:test";
import { backendProviderConfig, parseBackendGenerationResult, prepareBackendGenerationTask, runBackendGenerationTask, runBackendGenerationTaskBatch, submitBackendGenerationTask, type GenerationTaskDependencies } from "../src/services/api/generation-task";
import { canRetrieveVideoResult, type CreateTaskInput, type GenerationTask } from "../src/services/api/task-center";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { buildGenerationConfig, resolveCanvasGenerationModel } from "../src/lib/canvas/canvas-project-generation";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { LocalComfyRecipe } from "../src/services/api/local-comfy";

const recipes: LocalComfyRecipe[] = [
    { id: "qwen_image_2_1", name: "Qwen", mode: "t2i", reference_slots: 0, ready: true },
    { id: "h3_i2v_turbo4", name: "H3", mode: "i2v", reference_slots: 1, ready: true, reference_constraints: [{ role: "first_frame", width: 864, height: 480, mime_types: ["image/png"] }] },
];
function config(mode: "image" | "video" = "image", enabled = true): AiConfig {
    const model = `local-comfy:${mode === "video" ? "h3_i2v_turbo4" : "qwen_image_2_1"}`;
    return { ...defaultConfig, model, imageModel: "local-comfy:qwen_image_2_1", videoModel: "local-comfy:h3_i2v_turbo4", apiKey: "TEST-CLOUD-KEY-MUST-NOT-BE-SENT", baseUrl: "https://example.invalid/cloud", localComfyModels: recipes, localComfyGenerationEnabled: enabled, localComfyDefaults: { image: { recipeId: "qwen_image_2_1", seed: "42" }, video: { recipeId: "h3_i2v_turbo4", seed: "42" } } };
}
function mockBackend() {
    const requests: CreateTaskInput[] = [];
    const durable = new Map<string, GenerationTask>();
    let ids = 0;
    const dependencies: GenerationTaskDependencies = {
        createId: () => `TEST-generated-operation-${++ids}`,
        async createTask(input) {
            requests.push(input);
            const metadata = input.input?.metadata as { clientOperationId: string };
            let task = durable.get(metadata.clientOperationId);
            if (!task) {
                task = { id: `TEST-task-${durable.size}`, clientOperationId: metadata.clientOperationId, type: input.type!, provider: input.provider, model: input.model, prompt: input.prompt, status: "queued", attempts: 1, inputJson: JSON.stringify(input.input), createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
                durable.set(metadata.clientOperationId, task);
            }
            return task;
        },
        async waitTask(_id, options) {
            const task: GenerationTask = { ...options!.initialTask!, status: "succeeded", providerRequestId: "TEST-sidecar-job", resultJson: JSON.stringify({ mode: "image", images: [{ storageKey: "resource:TEST-result", url: "/api/resources/TEST-result/file", width: 512, height: 512, mimeType: "image/png", bytes: 68 }], localComfy: { recipeId: "qwen_image_2_1", jobId: "TEST-sidecar-job", status: "completed" } }) };
            options?.onTaskUpdate?.(task);
            return task;
        },
    };
    return { dependencies, requests, durable };
}

describe("native local submit and restore use normal persistent task contracts", () => {
    test("generation disabled gates run, submit and batch before reference preparation or backend requests", async () => {
        const backend = mockBackend();
        const options = { mode: "video" as const, prompt: "TEST", config: config("video", false), referenceImages: [{ id: "TEST", name: "TEST.png", type: "image/png", dataUrl: "", width: 1, height: 1 }] };
        await expect(runBackendGenerationTask(options, backend.dependencies)).rejects.toThrow("本地生成未启用");
        await expect(submitBackendGenerationTask(options, backend.dependencies)).rejects.toThrow("本地生成未启用");
        await expect(runBackendGenerationTaskBatch({ ...options, count: 2 }, backend.dependencies)).rejects.toThrow("本地生成未启用");
        expect(backend.requests).toHaveLength(0);
        expect(backend.durable.size).toBe(0);
    });
    test("pure request preparation remains available with generation disabled and sends no cloud config", async () => {
        const input = await prepareBackendGenerationTask({ mode: "image", prompt: "TEST dry-run", config: config("image", false), clientOperationId: "TEST-dry-run", metadata: { nodeId: "TEST-node" } });
        expect(input.input?.localComfy).toEqual({ recipeId: "qwen_image_2_1", seed: 42 });
        expect(input.input?.metadata).toMatchObject({ clientOperationId: "TEST-dry-run", nodeId: "TEST-node" });
        expect(input.input).not.toHaveProperty("config");
        expect(JSON.stringify(input)).not.toContain("TEST-CLOUD-KEY");
        expect(JSON.stringify(input)).not.toContain("example.invalid/cloud");
        expect(backendProviderConfig(config())).toEqual({});
    });
    test("local H3 never rewrites owned resources as inherited Ark assets and rejects external URL references", async () => {
        const options = { mode: "video" as const, prompt: "TEST H3", config: { ...config("video", false), baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" }, clientOperationId: "TEST-h3-dry-run" };
        const image = { id: "TEST-ref", name: "TEST.png", type: "image/png", dataUrl: "", storageKey: "resource:TEST-ref", width: 864, height: 480, arkAssetId: "TEST-ark-asset" };
        const input = await prepareBackendGenerationTask({ ...options, referenceImages: [image] });
        expect(input.input?.referenceImages).toMatchObject([{ storageKey: "resource:TEST-ref" }]);
        expect(JSON.stringify(input)).not.toContain("asset://");
        await expect(prepareBackendGenerationTask({ ...options, referenceImages: [{ ...image, storageKey: undefined, url: "https://example.invalid/ref.png" }] })).rejects.toThrow("不能直接引用外部");
    });
    test("native task submission retains stable identity for backend deduplication and mock terminal results normalize owned resources", async () => {
        const backend = mockBackend();
        const options = { mode: "image" as const, prompt: "TEST", config: config(), clientOperationId: "TEST-stable" };
        const first = await submitBackendGenerationTask(options, backend.dependencies);
        const second = await submitBackendGenerationTask(options, backend.dependencies);
        expect(first.id).toBe(second.id);
        expect(backend.durable.size).toBe(1);
        const updates: string[] = [];
        const result = await runBackendGenerationTask({ ...options, onTaskUpdate: (task) => updates.push(task.status) }, backend.dependencies);
        expect(result.images?.[0].dataUrl).toBe("/api/resources/TEST-result/file");
        expect(result.images?.[0].storageKey).toBe("resource:TEST-result");
        expect(result.localComfy?.jobId).toBe("TEST-sidecar-job");
        expect(updates).toEqual(["queued", "succeeded"]);
        expect(backend.durable.size).toBe(1);
    });
    test("local batches have per-image operation IDs and preserve explicit per-task retry contexts", async () => {
        const backend = mockBackend();
        const options = { mode: "image" as const, prompt: "TEST batch", config: config(), clientOperationId: "TEST-batch", count: 2 };
        expect((await runBackendGenerationTaskBatch(options, backend.dependencies)).every((result) => result.status === "fulfilled")).toBe(true);
        expect(backend.requests.map((request) => (request.input?.metadata as { clientOperationId: string }).clientOperationId)).toEqual(["TEST-batch:0", "TEST-batch:1"]);
        const retry = [0, 1].map((index) => ({ retryOf: `TEST-parent-${index}`, attemptGroupId: "TEST-group", clientOperationId: `TEST-retry-${index}` }));
        await runBackendGenerationTaskBatch({ ...options, retryContextsByBatchIndex: retry }, backend.dependencies);
        expect(backend.requests.slice(2).map((request) => request.input?.metadata)).toEqual(retry.map((context, batchIndex) => ({ ...context, batchIndex, batchCount: 2 })));
        expect(backend.durable.size).toBe(4);
    });
    test("missing IDs are generated for native local tasks rather than empty dedupe keys", async () => {
        const backend = mockBackend();
        const task = await submitBackendGenerationTask({ mode: "image", prompt: "TEST", config: config() }, backend.dependencies);
        expect(task.clientOperationId).toBe("TEST-generated-operation-1");
    });
    test("local image and video recovery accepts persisted IDs or submission-unknown lookup while other ID-less failures remain blocked", () => {
        const base: GenerationTask = { id: "TEST", type: "canvas_image", provider: "local-comfy", prompt: "TEST", status: "failed", providerRequestId: "TEST-sidecar-job", attempts: 1, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
        expect(canRetrieveVideoResult(base)).toBe(true);
        expect(canRetrieveVideoResult({ ...base, type: "canvas_video" })).toBe(true);
        expect(canRetrieveVideoResult({ ...base, status: "cancelled" })).toBe(false);
        expect(canRetrieveVideoResult({ ...base, providerRequestId: undefined })).toBe(false);
        expect(canRetrieveVideoResult({ ...base, providerRequestId: undefined, stage: "submission_unknown" })).toBe(true);
        expect(canRetrieveVideoResult({ ...base, historyOnly: true, stage: "submission_unknown" })).toBe(false);
        expect(canRetrieveVideoResult({ ...base, provider: "openai" })).toBe(false);
        expect(() => parseBackendGenerationResult({ ...base, status: "succeeded", resultJson: JSON.stringify({ images: [{ url: "/api/local-comfy/v1/assets/TEST/content" }] }) })).toThrow("尚未归档");
    });
    test("canvas model resolution preserves local or stale local choices without cloud fallback or inherited credentials", () => {
        const current = { ...config(), count: "4" };
        const node: CanvasNodeData = { id: "TEST-node", type: CanvasNodeType.Image, title: "TEST", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { model: "local-comfy:qwen_image_2_1_preview512", size: "16:9", quality: "high" } };
        const selected = buildGenerationConfig(current, node, "image");
        expect(selected.model).toBe("local-comfy:qwen_image_2_1_preview512");
        expect(selected.imageModel).toBe(selected.model);
        expect(selected.apiKey).toBe("");
        expect(selected.baseUrl).toBe("");
        expect(selected.count).toBe("1");
        expect(current.count).toBe("4");
        expect(resolveCanvasGenerationModel(current, "local-comfy:removed", "image")).toBe("local-comfy:removed");
        expect(buildGenerationConfig(current, { ...node, metadata: { model: "local-comfy:removed" } }, "image").model).toBe("local-comfy:removed");
    });
});

import { describe, expect, test } from "bun:test";
import { assertLocalComfyReferences, buildLocalComfyGenerationTaskInput } from "../src/lib/local-comfy-task-input";
import { createGenerationTaskMaterializer, type GenerationTaskEffectResult, type GenerationTaskEffectStore } from "../src/services/generation-task-materializer";
import type { LocalComfyRecipe } from "../src/services/api/local-comfy";
import type { GenerationTask } from "../src/services/api/task-center";
import type { ReferenceImage } from "../src/types/image";

const imageRecipe: LocalComfyRecipe = { id: "qwen_image_2_1", name: "Qwen", mode: "t2i", ready: true, reference_slots: 0 };
const videoRecipe: LocalComfyRecipe = { id: "h3_i2v_turbo4", name: "H3", mode: "i2v", ready: true, reference_slots: 1, reference_constraints: [{ role: "first_frame", width: 864, height: 480, mime_types: ["image/png"] }] };
const firstFrame: ReferenceImage = { id: "selected-image", name: "TEST-first-frame.png", type: "image/png", dataUrl: "", storageKey: "resource:TEST-owned-image", width: 864, height: 480 };

function input(recipe = imageRecipe, images: ReferenceImage[] = []) {
    return { projectId: "TEST-project", mode: recipe.mode === "i2v" ? "video" : "image", model: `local-comfy:${recipe.id}`, prompt: "TEST native local task", recipe, seed: "42", referenceImages: images, clientOperationId: "TEST-operation", metadata: { nodeId: "TEST-node", shotId: "TEST-shot" } };
}

describe("native local task input without upstream requests", () => {
    test("registered image recipe maps to a normal native task without a cloud config", () => {
        const task = buildLocalComfyGenerationTaskInput(input());
        expect(task).toMatchObject({ type: "canvas_image", provider: "local-comfy", model: "local-comfy:qwen_image_2_1", projectId: "TEST-project", prompt: "TEST native local task" });
        expect(task.input).toEqual({ mode: "image", prompt: "TEST native local task", localComfy: { recipeId: "qwen_image_2_1", seed: 42 }, referenceImages: [], metadata: { nodeId: "TEST-node", shotId: "TEST-shot", clientOperationId: "TEST-operation" } });
        expect(task.input).not.toHaveProperty("config");
        expect(task).not.toHaveProperty("logicalModelId");
    });
    test("H3 maps a real selected owned image and fixed recipe rather than cloud duration or size", () => {
        const task = buildLocalComfyGenerationTaskInput(input(videoRecipe, [firstFrame]));
        expect(task.operation).toBe("image_to_video");
        expect(task.input?.referenceImages).toEqual([{ storageKey: "resource:TEST-owned-image", name: "TEST-first-frame.png", type: "image/png", width: 864, height: 480 }]);
        expect(task.input).not.toHaveProperty("videoSeconds");
        expect(task.input).not.toHaveProperty("size");
    });
    test("missing or extra references cannot be replaced by prompt text", () => {
        expect(() => buildLocalComfyGenerationTaskInput(input(videoRecipe))).toThrow("需要 1 张");
        expect(() => buildLocalComfyGenerationTaskInput(input(imageRecipe, [firstFrame]))).toThrow("需要 0 张");
    });
    test("URL or data URL references must be saved as native resources before task submission", () => {
        for (const url of ["https://example.invalid/ref.png", "data:image/png;base64,TEST", "/api/local-comfy/v1/assets/TEST/content"]) {
            expect(() => buildLocalComfyGenerationTaskInput(input(videoRecipe, [{ ...firstFrame, storageKey: undefined, url }]))).toThrow("保存为素材资源");
        }
    });
    test("H3 rejects wrong first-frame size, MIME, additional media and mask", () => {
        expect(() => assertLocalComfyReferences(videoRecipe, [{ ...firstFrame, width: 1024 }])).toThrow("864×480");
        expect(() => assertLocalComfyReferences(videoRecipe, [{ ...firstFrame, type: "image/jpeg" }])).toThrow("类型");
        for (const options of [{ videoCount: 1 }, { audioCount: 1 }, { mask: firstFrame }]) expect(() => assertLocalComfyReferences(videoRecipe, [firstFrame], options)).toThrow("不支持");
    });
    test("key-only owned references defer authoritative metadata checks to the backend", () => {
        expect(() => buildLocalComfyGenerationTaskInput(input(videoRecipe, [{ ...firstFrame, width: undefined, height: undefined, type: "" }]))).not.toThrow();
    });
    test("stale recipes, cross-mode IDs, empty prompts and invalid seeds fail explicitly", () => {
        expect(() => buildLocalComfyGenerationTaskInput({ ...input(), recipe: { ...imageRecipe, ready: false } })).toThrow("未就绪");
        expect(() => buildLocalComfyGenerationTaskInput({ ...input(), mode: "video" })).toThrow("用途");
        expect(() => buildLocalComfyGenerationTaskInput({ ...input(), model: "local-comfy:removed" })).toThrow("用途");
        expect(() => buildLocalComfyGenerationTaskInput({ ...input(), prompt: " " })).toThrow("提示词");
        for (const seed of ["", "-1", "1.5", "4294967296"]) expect(() => buildLocalComfyGenerationTaskInput({ ...input(), seed })).toThrow("种子");
        expect((buildLocalComfyGenerationTaskInput({ ...input(), seed: "4294967295" }).input?.localComfy as { seed: number }).seed).toBe(4294967295);
    });
    test("stable retry and shot context survives while empty or excessive operation IDs fail", () => {
        expect(buildLocalComfyGenerationTaskInput({ ...input(), retryOf: "TEST-parent-task", attemptGroupId: "TEST-group" }).input?.metadata).toMatchObject({ clientOperationId: "TEST-operation", nodeId: "TEST-node", shotId: "TEST-shot", retryOf: "TEST-parent-task", attemptGroupId: "TEST-group" });
        for (const clientOperationId of ["", " ", "x".repeat(201)]) expect(() => buildLocalComfyGenerationTaskInput({ ...input(), clientOperationId })).toThrow("操作标识");
    });
});

test("replayed local result materialization and native node attachment remain idempotent after a session restore", async () => {
    const persisted = new Map<string, GenerationTaskEffectResult>();
    const effects: GenerationTaskEffectStore = {
        async claim(key) { return persisted.has(key) ? { status: "completed", result: persisted.get(key)! } : { status: "claimed", fence: 1 }; },
        async renew() { return { fence: 1 }; },
        async complete(key, _task, result) { persisted.set(key, result); },
        async release() {},
    };
    let inserts = 0;
    let attachments = 0;
    const restore = () => createGenerationTaskMaterializer({ effects, materializeOutput: async () => { inserts++; return { materializedAssetId: "TEST-owned-native-asset" }; } });
    const task: GenerationTask = { id: "TEST-native-local-task", type: "canvas_image", provider: "local-comfy", model: "local-comfy:qwen_image_2_1", prompt: "TEST", status: "succeeded", attempts: 1, outputs: [{ outputIndex: 0, mediaType: "image", providerArtifactRef: "resource:TEST-owned-image" }], createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
    for (let session = 0; session < 3; session++) {
        const materializer = restore();
        const result = await materializer.materialize(structuredClone(task));
        expect(result.resultState).toBe("READY");
        expect(result.outputs?.[0].materializedAssetId).toBe("TEST-owned-native-asset");
        await materializer.attachNode(result, "TEST-node", 0, async () => { attachments++; });
    }
    expect(inserts).toBe(1);
    expect(attachments).toBe(1);
});

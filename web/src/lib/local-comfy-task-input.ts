import { localComfyRecipeMode, localComfySeedProblem } from "./local-comfy-defaults";
import type { LocalComfyRecipe } from "../services/api/local-comfy";
import type { CreateTaskInput } from "../services/api/task-center";
import type { ReferenceImage } from "../types/image";

export function assertLocalComfyReferences(recipe: LocalComfyRecipe, images: readonly ReferenceImage[], options: { videoCount?: number; audioCount?: number; mask?: unknown; requireOwned?: boolean } = {}) {
    if (options.videoCount || options.audioCount || options.mask) throw new Error("当前本地配方只接受登记的参考图片，不支持视频、音频或蒙版");
    if (images.length !== recipe.reference_slots) throw new Error(`本地配方需要 ${recipe.reference_slots} 张参考图片，当前为 ${images.length} 张`);
    images.forEach((image, index) => {
        const hasNativeResourceKey = Boolean(image.storageKey?.startsWith("resource:") && image.storageKey.slice("resource:".length).trim());
        if (options.requireOwned && !hasNativeResourceKey) {
            throw new Error("本地参考图需先上传并保存为素材资源");
        }
        const constraint = recipe.reference_constraints?.[index];
        if (!constraint) return;
        // Workflow resource references carry image/* until the backend reads their actual MIME.
        const deferResourceMime = image.type === "image/*" && hasNativeResourceKey;
        if (image.type && !deferResourceMime && !constraint.mime_types.includes(image.type)) throw new Error(`第 ${index + 1} 张参考图类型不符合本地配方要求`);
        // The backend validates authoritative owned resource metadata again;
        // references restored with only a resource key defer absent dimensions.
        if ((image.width !== undefined && image.width !== constraint.width) || (image.height !== undefined && image.height !== constraint.height)) {
            throw new Error(`第 ${index + 1} 张参考图需为 ${constraint.width}×${constraint.height}，请先准备符合尺寸的图片`);
        }
    });
}

export function buildLocalComfyGenerationTaskInput(options: {
    projectId?: string;
    mode: string;
    prompt: string;
    model: string;
    recipe: LocalComfyRecipe;
    seed: string;
    referenceImages: readonly ReferenceImage[];
    clientOperationId: string;
    retryOf?: string;
    attemptGroupId?: string;
    metadata?: Record<string, unknown>;
}): CreateTaskInput {
    const { projectId, mode, prompt, model, recipe, seed, clientOperationId, referenceImages, metadata, retryOf, attemptGroupId } = options;
    if (!recipe.ready) throw new Error("本地配方当前未就绪，请检查工作流配置");
    if (model !== `local-comfy:${recipe.id}` || localComfyRecipeMode(recipe) !== mode) throw new Error("本地配方与当前生成用途不一致");
    if (!prompt.trim()) throw new Error("请填写本地生成提示词");
    const seedProblem = localComfySeedProblem(seed);
    if (seedProblem) throw new Error(seedProblem);
    if (!clientOperationId.trim() || clientOperationId.length > 200) throw new Error("本地任务缺少有效的生成操作标识");
    assertLocalComfyReferences(recipe, referenceImages, { requireOwned: true });
    return {
        ...(projectId ? { projectId } : {}),
        type: `canvas_${mode}`,
        operation: mode === "video" && referenceImages.length ? "image_to_video" : mode,
        provider: "local-comfy",
        model,
        prompt,
        input: {
            mode,
            prompt,
            localComfy: { recipeId: recipe.id, seed: Number(seed) },
            referenceImages: referenceImages.map((image) => ({ id: image.id, storageKey: image.storageKey, name: image.name, type: image.type, ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) })),
            metadata: { ...metadata, clientOperationId, ...(retryOf ? { retryOf } : {}), ...(attemptGroupId ? { attemptGroupId } : {}) },
        },
    };
}

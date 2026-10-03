import type { ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { LocalComfyRecipe } from "@/services/api/local-comfy";

const PREFIX = "local-comfy:";
export const LOCAL_COMFY_MODEL_GROUP = "local-comfy";
export type LocalComfyModelConfig = {
    localComfyModels?: readonly LocalComfyRecipe[];
    localComfyGenerationEnabled?: boolean;
};

const registered = {
    qwen_image_2_1: { capability: "image", mode: "t2i", references: 0, width: 1024, height: 1024, name: "Qwen-Image-2.1 · 1024" },
    qwen_image_2_1_preview512: { capability: "image", mode: "t2i", references: 0, width: 512, height: 512, name: "Qwen-Image-2.1 · 512 预览" },
    h3_i2v_turbo4: { capability: "video", mode: "i2v", references: 1, width: 864, height: 480, name: "H3 I2V · Turbo 4 步" },
} as const;

export function encodeLocalComfyModel(recipeId: string) { return `${PREFIX}${recipeId.trim()}`; }
export function isLocalComfyModel(value: string) { return value.startsWith(PREFIX); }
export function decodeLocalComfyModel(value: string): string | null {
    return isLocalComfyModel(value) ? value.slice(PREFIX.length) : null;
}
export function localComfyRegisteredModel(value: string) {
    const recipeId = decodeLocalComfyModel(value);
    return recipeId && Object.prototype.hasOwnProperty.call(registered, recipeId) ? registered[recipeId as keyof typeof registered] : undefined;
}

// Runtime metadata comes from the fixed same-origin adapter. It never creates a
// cloud channel, and directory entries outside this integration are not enabled.
export function validatedLocalComfyRecipes(recipes: readonly LocalComfyRecipe[]): LocalComfyRecipe[] {
    return recipes.filter((recipe) => {
        const contract = localComfyRegisteredModel(encodeLocalComfyModel(recipe.id));
        return contract && recipe.mode === contract.mode && recipe.reference_slots === contract.references;
    }).map((recipe) => ({ ...recipe }));
}
export function localComfyModelFor(config: LocalComfyModelConfig, value: string): LocalComfyRecipe | undefined {
    const recipeId = decodeLocalComfyModel(value);
    if (!recipeId || !localComfyRegisteredModel(value)) return undefined;
    return validatedLocalComfyRecipes(config.localComfyModels || []).find((recipe) => recipe.id === recipeId);
}
export function localComfySelectableModels(config: LocalComfyModelConfig, capability?: string) {
    return validatedLocalComfyRecipes(config.localComfyModels || []).filter((recipe) => recipe.ready && (!capability || localComfyRegisteredModel(encodeLocalComfyModel(recipe.id))?.capability === capability)).map((recipe) => encodeLocalComfyModel(recipe.id));
}
export function localComfyModelDisplayName(config: LocalComfyModelConfig, value: string) {
    return localComfyRegisteredModel(value)?.name || localComfyModelFor(config, value)?.name || decodeLocalComfyModel(value) || value;
}
export function localComfyModelProblem(config: LocalComfyModelConfig, value: string, capability?: string) {
    const recipe = localComfyModelFor(config, value);
    if (!recipe) return "已保存的本地配方当前未登记或目录未读取，请重新核对";
    if (capability && localComfyRegisteredModel(value)?.capability !== capability) return "本地配方与当前生成用途不符";
    if (!recipe.ready) return "本地配方未就绪，请核对工作流文件";
    return "";
}
export function localComfyGenerationProblem(config: LocalComfyModelConfig, value: string) {
    return localComfyModelProblem(config, value) || (config.localComfyGenerationEnabled === true ? "" : "本地生成未启用；已保存模型，可核对参数，暂不能提交生成");
}
export function localComfyModelSummary(value: string) {
    const contract = localComfyRegisteredModel(value);
    return !contract ? "本地配方当前未登记" : contract.capability === "image" ? `登记工作流固定 ${contract.width}×${contract.height}，仅接受文本` : "登记工作流固定 864×480、124 帧 / 24 fps；需要 1 张 PNG 首帧";
}

export function localComfyModelCapabilityConfig(value: string): ModelCapabilityConfig | undefined {
    const contract = localComfyRegisteredModel(value);
    if (!contract) return undefined;
    if (contract.capability === "image") return { version: 1, image: {
        references: { promptMaxChars: 0, maxImages: 0, maxImageBytes: 0, maskSupported: false },
        size: { parameter: "none", values: [`${contract.width}x${contract.height}`], default: `${contract.width}x${contract.height}`, allowCustom: false },
        quality: { supported: false, values: ["auto"], default: "auto" },
        transparentBackground: { supported: false, default: false }, responseFormat: { supported: false }, outputFormat: { supported: false }, maxOutputs: 1,
    } };
    return { version: 1, video: {
        references: { promptMaxChars: 0, minImages: 1, maxImages: 1, maxImageBytes: 32 * 1024 * 1024, minImageWidth: 864, maxImageWidth: 864, minImageHeight: 480, maxImageHeight: 480, maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0, maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0 },
        duration: { selection: "enum", values: [124 / 24], default: 124 / 24 }, durationSupported: false,
        ratios: ["864x480"], defaultRatio: "864x480", resolutions: ["480p"], defaultResolution: "480p",
        generateAudio: { supported: false, default: false }, watermark: { supported: false, default: false }, operations: ["image_to_video"], defaultOperation: "image_to_video",
    } };
}

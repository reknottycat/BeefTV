import type { ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { LocalComfyRecipe } from "@/services/api/local-comfy";

const PREFIX = "local-comfy:";
export const LOCAL_COMFY_MODEL_GROUP = "local-comfy";
export type LocalComfyStatus = "loading" | "offline" | "unconfigured" | "empty" | "disabled" | "unsupported" | "not_ready" | "ready";
export type LocalComfyModelConfig = {
    localComfyModels?: readonly LocalComfyRecipe[];
    localComfyGenerationEnabled?: boolean;
    localComfyStatus?: LocalComfyStatus;
    localComfyMaxReferenceBytes?: number;
};

export function encodeLocalComfyModel(recipeId: string) { return `${PREFIX}${recipeId.trim()}`; }
export function isLocalComfyModel(value: string) { return value.startsWith(PREFIX); }
export function decodeLocalComfyModel(value: string) { return isLocalComfyModel(value) ? value.slice(PREFIX.length) : null; }
export function localComfyRecipeCapability(recipe: Pick<LocalComfyRecipe, "mode">) {
    if (recipe.mode === "t2i" || recipe.mode === "i2i") return "image";
    if (recipe.mode === "t2v" || recipe.mode === "i2v") return "video";
    return undefined;
}

export function localComfyRecipeSupportProblem(recipe: LocalComfyRecipe) {
    const capability = localComfyRecipeCapability(recipe);
    if (!capability) return "当前工作台不支持此配方的生成类型";
    if (!/^[a-f0-9]{64}$/i.test(recipe.recipe_version || "")) return "配方缺少有效版本，请更新本地服务后刷新";
    if (!Number.isInteger(recipe.reference_slots) || recipe.reference_slots < 0) return "配方参考图数量无效，请检查配方配置";
    const needsReference = recipe.mode === "i2i" || recipe.mode === "i2v";
    if (needsReference !== (recipe.reference_slots > 0)) return "配方模式与参考图数量不一致，请检查配方配置";
    if (capability === "video" && recipe.reference_slots > 1) return "当前本地视频生成只支持单张首帧，请使用单首帧配方";
    const output = recipe.output;
    if (!output || !Number.isInteger(output.width) || output.width <= 0 || !Number.isInteger(output.height) || output.height <= 0) return "配方缺少输出尺寸，请在本地配方配置中补充 output.width 和 output.height";
    if (capability === "video" && (!Number.isFinite(output.fps) || output.fps! <= 0 || !Number.isFinite(output.duration_seconds) || output.duration_seconds! <= 0)) return "视频配方缺少帧率或时长，请补充 output.fps 和 output.duration_seconds";
    if (capability === "video" && output.mime_type !== "video/mp4") return "此版本原生视频仅支持 MP4，请在配方明确 output.mime_type=video/mp4";
    return "";
}

export function validatedLocalComfyRecipes(recipes: readonly LocalComfyRecipe[]) {
    return recipes.filter((recipe) => !localComfyRecipeSupportProblem(recipe));
}
export function localComfyModelFor(config: LocalComfyModelConfig, value: string) {
    return config.localComfyModels?.find((recipe) => recipe.id === decodeLocalComfyModel(value));
}
export function localComfySelectableModels(config: LocalComfyModelConfig, capability?: string) {
    return validatedLocalComfyRecipes(config.localComfyModels || []).filter((recipe) => recipe.ready && (!capability || localComfyRecipeCapability(recipe) === capability)).map((recipe) => encodeLocalComfyModel(recipe.id));
}
export function localComfyModelDisplayName(config: LocalComfyModelConfig, value: string) {
    return localComfyModelFor(config, value)?.name || decodeLocalComfyModel(value) || value;
}
export function localComfyStatusMessage(status?: LocalComfyStatus) {
    switch (status) {
        case "loading": return "正在读取本地配方，请稍候";
        case "offline": return "本地生成服务暂时无法连接；已保留模型选择，请在设置中重试读取";
        case "unconfigured": return "尚未连接本地生成服务，请在设置中查看配置说明";
        case "empty": return "尚无已登记配方，请在设置中查看登记说明";
        case "disabled": return "本地生成尚未启用；可以选择模型，启用后再提交生成";
        case "unsupported": return "已登记配方暂不支持原生生成，请在设置中查看需补全的配置";
        case "not_ready": return "本地工作流尚未就绪，请检查已登记配方后刷新状态";
        default: return "";
    }
}
export function localComfyModelProblem(config: LocalComfyModelConfig, value: string, capability?: string) {
    const recipe = localComfyModelFor(config, value);
    if (!recipe) return localComfyStatusMessage(config.localComfyStatus) || "已保存的本地配方当前未登记，请在设置中核对；原选择已保留";
    const unsupported = localComfyRecipeSupportProblem(recipe);
    if (unsupported) return unsupported;
    if (capability && localComfyRecipeCapability(recipe) !== capability) return "本地配方与当前生成用途不符";
    if (!recipe.ready) return "本地配方未就绪，请检查工作流配置";
    return "";
}
export function localComfyGenerationProblem(config: LocalComfyModelConfig, value: string) {
    return localComfyStatusMessage(config.localComfyStatus) || localComfyModelProblem(config, value) || (config.localComfyGenerationEnabled === true ? "" : "本地生成状态尚未确认，请在设置中刷新状态");
}
export function localComfyModelSummary(value: string, config: LocalComfyModelConfig) {
    const recipe = localComfyModelFor(config, value);
    if (!recipe?.output) return "输出规格尚未登记";
    const { width, height, fps, duration_seconds: duration } = recipe.output;
    return `${width}×${height}${localComfyRecipeCapability(recipe) === "video" ? ` · ${duration} 秒 / ${fps} fps` : ""} · ${recipe.reference_slots ? `需要 ${recipe.reference_slots} 张参考图` : "文本生成"}`;
}
export function localComfyReferenceVideoOperation(value: string, operation: string | undefined, input: { imageCount: number; characterCount: number; videoCount: number; audioCount: number }, config: LocalComfyModelConfig) {
    return localComfyModelFor(config, value)?.mode === "i2v" && operation === "reference_to_video" && input.imageCount + input.characterCount === 1 && input.videoCount === 0 && input.audioCount === 0 ? "image_to_video" : operation;
}

export function localComfyModelCapabilityConfig(value: string, config: LocalComfyModelConfig): ModelCapabilityConfig | undefined {
    const recipe = localComfyModelFor(config, value);
    if (!recipe || localComfyRecipeSupportProblem(recipe)) return undefined;
    const output = recipe.output!;
    const size = `${output.width}x${output.height}`;
    const maxBytes = config.localComfyMaxReferenceBytes || 0;
    if (localComfyRecipeCapability(recipe) === "image") return { version: 1, image: {
        references: { promptMaxChars: 0, maxImages: recipe.reference_slots, maxImageBytes: maxBytes, maskSupported: false },
        size: { parameter: "none", values: [size], default: size, allowCustom: false },
        quality: { supported: false, values: ["auto"], default: "auto" }, transparentBackground: { supported: false, default: false },
        responseFormat: { supported: false }, outputFormat: { supported: false }, maxOutputs: 1,
    } };
    const first = recipe.reference_constraints?.[0];
    const operation = recipe.mode === "i2v" ? "image_to_video" : "text_to_video";
    return { version: 1, video: {
        references: { promptMaxChars: 0, minImages: recipe.reference_slots, maxImages: recipe.reference_slots, maxImageBytes: maxBytes,
            ...(first ? { minImageWidth: first.width, minImageHeight: first.height } : {}),
            maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0, maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0 },
        duration: { selection: "enum", values: [output.duration_seconds!], default: output.duration_seconds! }, durationSupported: false,
        ratios: [size], defaultRatio: size, resolutions: [`${output.height}p`], defaultResolution: `${output.height}p`,
        generateAudio: { supported: false, default: false }, watermark: { supported: false, default: false }, operations: [operation], defaultOperation: operation,
    } };
}

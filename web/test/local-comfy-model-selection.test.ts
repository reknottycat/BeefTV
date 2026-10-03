import { describe, expect, test } from "bun:test";
import { createModelChannel, defaultConfig, modelDisplayName, normalizeConfigSnapshot, resolveModelRequestConfig, selectableModelsByCapability, useConfigStore, type AiConfig } from "../src/stores/use-config-store";
import { modelCompatibilityError, resolveCompatibleModel, resolveModelGenerationDefaults } from "../src/lib/model-selection";
import type { LocalComfyRecipe } from "../src/services/api/local-comfy";

const recipes: LocalComfyRecipe[] = [
    { id: "qwen_image_2_1", name: "Qwen", mode: "t2i", ready: true, reference_slots: 0 },
    { id: "qwen_image_2_1_preview512", name: "Qwen preview", mode: "t2i", ready: true, reference_slots: 0 },
    { id: "h3_i2v_turbo4", name: "H3", mode: "i2v", ready: true, reference_slots: 1 },
];
const image = "local-comfy:qwen_image_2_1";
const video = "local-comfy:h3_i2v_turbo4";
const config: AiConfig = { ...defaultConfig, imageModel: image, videoModel: video, model: image, localComfyModels: recipes, localComfyGenerationEnabled: false };
const input = { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 };

describe("native model selection and hydration with local recipes", () => {
    test("saved native IDs survive cold hydration while runtime permission is discarded", () => {
        const restored = normalizeConfigSnapshot({ config: JSON.parse(JSON.stringify(config)) }).config;
        expect(restored.imageModel).toBe(image);
        expect(restored.videoModel).toBe(video);
        expect(restored.model).toBe(image);
        expect(restored.textModel).toBe("");
        expect(restored.localComfyModels).toBeUndefined();
        expect(restored.localComfyGenerationEnabled).toBeUndefined();
        expect(selectableModelsByCapability(restored, "image")).toEqual([]);
    });
    test("cold hydration keeps text drafts editable without making a missing credential the default", () => {
        const channel = createModelChannel({ id: "draft", baseUrl: "https://example.test/v1", apiKey: "", models: ["text-draft"], modelProfiles: [{ model: "text-draft", capability: "text", protocol: "chat-completion" }] });
        const restored = normalizeConfigSnapshot({ config: { ...config, channels: [channel], textModel: "draft::text-draft" } }).config;
        expect(restored.textModels).toEqual(["draft::text-draft"]);
        expect(restored.textModel).toBe("");
        expect(restored.imageModel).toBe(image);
        expect(restored.videoModel).toBe(video);
        expect(normalizeConfigSnapshot({ config: { ...restored, channels: [{ ...channel, apiKey: "TEST-MOCK-CREDENTIAL" }] } }).config.textModel).toBe("draft::text-draft");
        expect(normalizeConfigSnapshot({ config: { ...restored, channels: [{ ...channel, apiKey: "TEST-MOCK-CREDENTIAL", enabled: false }] } }).config.textModel).toBe("");
    });
    test("stale local choices are retained even when a cloud model is available", () => {
        const channel = createModelChannel({ id: "cloud", models: ["cloud-image"], modelProfiles: [{ model: "cloud-image", capability: "image", protocol: "openai-image" }] });
        const restored = normalizeConfigSnapshot({ config: { ...config, channels: [channel], imageModel: "local-comfy:removed-recipe" } }).config;
        expect(restored.imageModel).toBe("local-comfy:removed-recipe");
        expect(restored.channels).toHaveLength(1);
        expect(resolveCompatibleModel({ ...restored, localComfyModels: recipes }, restored.imageModel, { capability: "image" })).toBe("local-comfy:removed-recipe");
        expect(modelCompatibilityError({ ...restored, localComfyModels: recipes }, restored.imageModel, { capability: "image" })).toContain("未登记");
    });
    test("runtime native menus filter exact image/video capability without creating a cloud channel", () => {
        expect(config.channels).toEqual([]);
        expect(selectableModelsByCapability(config, "image")).toEqual([image, "local-comfy:qwen_image_2_1_preview512"]);
        expect(selectableModelsByCapability(config, "video")).toEqual([video]);
        expect(selectableModelsByCapability(config, "text")).toEqual([]);
        expect(modelDisplayName(config, image)).toContain("Qwen-Image-2.1");
    });
    test("known cross-mode local selections survive hydration and show an explicit capability problem", () => {
        const channel = createModelChannel({ id: "cloud", models: ["cloud-image", "cloud-video"], modelProfiles: [{ model: "cloud-image", capability: "image", protocol: "openai-image" }, { model: "cloud-video", capability: "video", protocol: "openai-videos" }] });
        const restored = normalizeConfigSnapshot({ config: { ...config, channels: [channel], imageModel: video, videoModel: image } }).config;
        expect(restored.imageModel).toBe(video);
        expect(restored.videoModel).toBe(image);
        expect(modelCompatibilityError({ ...restored, localComfyModels: recipes }, restored.imageModel, { capability: "image" })).toContain("用途不符");
        expect(modelCompatibilityError({ ...restored, localComfyModels: recipes }, restored.videoModel, { capability: "video" })).toContain("用途不符");
    });
    test("local IDs never become text or audio defaults or selectable candidates", () => {
        const restored = normalizeConfigSnapshot({ config: { ...config, textModel: image, audioModel: video } }).config;
        expect(restored.textModel).toBe("");
        expect(restored.audioModel).toBe("");
        expect(selectableModelsByCapability(config, "text")).toEqual([]);
        expect(selectableModelsByCapability(config, "audio")).toEqual([]);
    });
    test("local request config never inherits cloud credentials or headers", () => {
        const prepared = resolveModelRequestConfig({ ...config, apiKey: "TEST-CLOUD-KEY", baseUrl: "https://example.invalid", channels: [createModelChannel({ id: "cloud", apiKey: "TEST-CHANNEL-KEY", secretKey: "TEST-CHANNEL-SECRET", headers: [{ name: "X-Test", value: "TEST-HEADER" }], models: ["cloud-image"] })] }, image);
        expect(prepared.model).toBe(image);
        expect(prepared.apiKey).toBe("");
        expect(prepared.secretKey).toBe("");
        expect(prepared.headers).toEqual([]);
        expect(prepared.baseUrl).toBe("");
        expect(prepared.channelId).toBe("");
        expect(prepared.credentialRef).toBeUndefined();
    });
    test("generation readiness requires a live server permission in addition to registration", () => {
        expect(useConfigStore.getState().isAiConfigReady(config, image)).toBe(false);
        expect(useConfigStore.getState().isAiConfigReady({ ...config, localComfyGenerationEnabled: true }, image)).toBe(true);
        expect(useConfigStore.getState().isAiConfigReady({ ...config, localComfyModels: [], localComfyGenerationEnabled: true }, image)).toBe(false);
    });
    test("legacy cloud dimensions do not block local choice; unsupported references still do", () => {
        expect(modelCompatibilityError(config, image, { capability: "image", input, imageSize: "16:9" })).toBe("");
        expect(modelCompatibilityError(config, image, { capability: "image", input: { ...input, imageCount: 1 } })).toContain("0 张参考图");
        expect(modelCompatibilityError(config, video, { capability: "video", input, videoSeconds: "30" })).toBe("");
        expect(modelCompatibilityError(config, video, { capability: "video", input: { ...input, imageCount: 1 } })).toBe("");
        expect(modelCompatibilityError(config, video, { capability: "video", input: { ...input, imageCount: 2 } })).toContain("1 张参考图");
        expect(modelCompatibilityError(config, video, { capability: "video", input: { ...input, videoCount: 1 } })).toContain("0 个参考视频");
    });
    test("new native nodes use fixed recipe parameters rather than persisted cloud defaults", () => {
        expect(resolveModelGenerationDefaults(config, image, "image", {}, { size: "16:9", count: "4" })).toMatchObject({ size: "1024x1024", count: "1", quality: "auto" });
        expect(resolveModelGenerationDefaults(config, video, "video", {}, { videoSeconds: "30", size: "16:9", vquality: "1080" })).toMatchObject({ videoSeconds: String(124 / 24), size: "864x480", vquality: "480", videoGenerateAudio: "false" });
    });
});

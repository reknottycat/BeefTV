import { describe, expect, test } from "bun:test";
import { decodeLocalComfyModel, encodeLocalComfyModel, isLocalComfyModel, localComfyGenerationProblem, localComfyModelCapabilityConfig, localComfyModelFor, localComfyModelProblem, localComfyReferenceVideoOperation, localComfySelectableModels, validatedLocalComfyRecipes } from "../src/lib/local-comfy-models";
import type { LocalComfyRecipe } from "../src/services/api/local-comfy";

const recipes: LocalComfyRecipe[] = [
    { id: "qwen_image_2_1", name: "Qwen", mode: "t2i", ready: true, reference_slots: 0 },
    { id: "qwen_image_2_1_preview512", name: "Qwen preview", mode: "t2i", ready: true, reference_slots: 0 },
    { id: "h3_i2v_turbo4", name: "H3", mode: "i2v", ready: true, reference_slots: 1, reference_constraints: [{ role: "first_frame", width: 864, height: 480, mime_types: ["image/png"] }] },
];
const config = { localComfyModels: recipes, localComfyGenerationEnabled: false };

describe("native local Comfy model contracts", () => {
    test("IDs stay separate from cloud channel models", () => {
        expect(encodeLocalComfyModel(" qwen_image_2_1 ")).toBe("local-comfy:qwen_image_2_1");
        expect(decodeLocalComfyModel("channel::qwen_image_2_1")).toBeNull();
        expect(isLocalComfyModel("qwen_image_2_1")).toBe(false);
        expect(decodeLocalComfyModel("local-comfy:h3_i2v_turbo4")).toBe("h3_i2v_turbo4");
    });
    test("only registered integration contracts enter capability menus", () => {
        expect(localComfySelectableModels(config, "image")).toEqual(["local-comfy:qwen_image_2_1", "local-comfy:qwen_image_2_1_preview512"]);
        expect(localComfySelectableModels(config, "video")).toEqual(["local-comfy:h3_i2v_turbo4"]);
        expect(localComfySelectableModels(config, "text")).toEqual([]);
        expect(localComfySelectableModels(config, "audio")).toEqual([]);
        expect(localComfySelectableModels({ localComfyModels: [...recipes, { id: "rh-directory-model", name: "Directory only", mode: "t2i", ready: true, reference_slots: 0 }] })).toHaveLength(3);
    });
    test("changed reference or mode contracts fail closed", () => {
        expect(validatedLocalComfyRecipes(recipes.map((recipe) => ({ ...recipe, reference_slots: recipe.reference_slots + 1 })))).toEqual([]);
        expect(validatedLocalComfyRecipes(recipes.map((recipe) => ({ ...recipe, mode: "ref2va" })))).toEqual([]);
        expect(localComfyModelProblem(config, "local-comfy:h3_i2v_turbo4", "image")).toContain("用途不符");
    });
    test("selection is allowed while actual generation is closed", () => {
        for (const model of localComfySelectableModels(config)) {
            expect(localComfyModelProblem(config, model)).toBe("");
            expect(localComfyGenerationProblem(config, model)).toContain("生成未启用");
            expect(localComfyGenerationProblem({ ...config, localComfyGenerationEnabled: true }, model)).toBe("");
        }
        expect(localComfyGenerationProblem({ localComfyModels: recipes }, "local-comfy:qwen_image_2_1")).toContain("生成未启用");
    });
    test("missing registration stays unavailable rather than choosing another recipe", () => {
        expect(localComfyModelFor(config, "local-comfy:removed-recipe")).toBeUndefined();
        expect(localComfyModelProblem(config, "local-comfy:removed-recipe")).toContain("未登记");
        expect(localComfyModelProblem({}, "local-comfy:qwen_image_2_1")).toContain("目录未读取");
        const unavailable = { localComfyModels: recipes.map((recipe) => ({ ...recipe, ready: false })), localComfyGenerationEnabled: true };
        expect(localComfySelectableModels(unavailable)).toEqual([]);
        expect(localComfyGenerationProblem(unavailable, "local-comfy:qwen_image_2_1")).toContain("未就绪");
    });
    test("Qwen exposes actual fixed dimensions without invented reference-image support", () => {
        const image = localComfyModelCapabilityConfig("local-comfy:qwen_image_2_1")!.image!;
        expect(image.size).toEqual({ parameter: "none", values: ["1024x1024"], default: "1024x1024", allowCustom: false });
        expect(image.references.maxImages).toBe(0);
        expect(image.maxOutputs).toBe(1);
        expect(image.quality.supported).toBe(false);
        expect(localComfyModelCapabilityConfig("local-comfy:qwen_image_2_1_preview512")!.image!.size.default).toBe("512x512");
    });
    test("H3 advertises the exact successful recipe rather than generic cloud options", () => {
        const video = localComfyModelCapabilityConfig("local-comfy:h3_i2v_turbo4")!.video!;
        expect(video.operations).toEqual(["image_to_video"]);
        expect(video.references.minImages).toBe(1);
        expect(video.references.maxImages).toBe(1);
        expect(video.references.maxVideos).toBe(0);
        expect(video.references.maxAudios).toBe(0);
        expect(video.duration.values).toEqual([124 / 24]);
        expect(video.durationSupported).toBe(false);
        expect(video.ratios).toEqual(["864x480"]);
        expect(video.resolutions).toEqual(["480p"]);
        expect(video.generateAudio.supported).toBe(false);
    });
    test("only registered single-frame I2V maps generic bound references to its actual operation", () => {
        const input = { imageCount: 1, characterCount: 0, videoCount: 0, audioCount: 0 };
        const model = "local-comfy:h3_i2v_turbo4";
        expect(localComfyReferenceVideoOperation(model, "reference_to_video", input)).toBe("image_to_video");
        expect(localComfyReferenceVideoOperation(model, "reference_to_video", { ...input, imageCount: 0, characterCount: 1 })).toBe("image_to_video");
        for (const value of ["cloud::h3_i2v_turbo4", "local-comfy:removed", "local-comfy:qwen_image_2_1"]) {
            expect(localComfyReferenceVideoOperation(value, "reference_to_video", input)).toBe("reference_to_video");
        }
        for (const invalid of [{ ...input, imageCount: 0 }, { ...input, imageCount: 2 }, { ...input, characterCount: 1 }, { ...input, videoCount: 1 }, { ...input, audioCount: 1 }]) {
            expect(localComfyReferenceVideoOperation(model, "reference_to_video", invalid)).toBe("reference_to_video");
        }
        for (const operation of [undefined, "image_to_video", "text_to_video", "extend", "inpaint", "audio_to_video"]) {
            expect(localComfyReferenceVideoOperation(model, operation, input)).toBe(operation);
        }
    });
    test("reference constraints survive catalog projection without mutating the source", () => {
        const before = JSON.stringify(recipes);
        expect(localComfyModelFor(config, "local-comfy:h3_i2v_turbo4")!.reference_constraints).toEqual(recipes[2].reference_constraints);
        expect(JSON.stringify(recipes)).toBe(before);
    });
});

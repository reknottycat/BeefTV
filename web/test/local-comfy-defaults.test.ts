import { describe, expect, test } from "bun:test";
import { applyLocalComfyEntryDefaults, localComfyDefaultProblem, localComfyDefaultsReady, localComfyEntrySelection, localComfyRecipeMode, localComfySeedProblem, normalizeLocalComfyDefaults, normalizeLocalComfyMode, persistLocalComfyDefaultDraft, type LocalComfyDefaults, type LocalRecipeOption } from "../src/lib/local-comfy-defaults";

const recipes: LocalRecipeOption[] = [
    { id: "qwen_image_2_1", name: "Qwen-Image-2.1 NVFP4", mode: "t2i", ready: true, reference_slots: 0 },
    { id: "h3_i2v_turbo4", name: "MiniMax H3 I2V Turbo 4", mode: "i2v", ready: true, reference_slots: 1 },
    { id: "qwen_image_2_1_preview512", name: "Qwen-Image-2.1 NVFP4 512 preview", mode: "t2i", ready: true, reference_slots: 0 },
];

describe("local workflow defaults use registered recipes independently of cloud models", () => {
    test("zero-channel default edits commit the updated snapshot instead of depending on native autosave", async () => {
        let current: { channels: string[]; localComfyDefaults: LocalComfyDefaults } = { channels: [], localComfyDefaults: {} };
        const snapshots: typeof current[] = [];
        await persistLocalComfyDefaultDraft({ video: { recipeId: "h3_i2v_turbo4", seed: "0" } }, {
            updateDefaults: (defaults) => { current = { ...current, localComfyDefaults: defaults }; },
            readConfig: () => current,
            commitConfig: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
        });
        expect(snapshots).toEqual([{ channels: [], localComfyDefaults: { video: { recipeId: "h3_i2v_turbo4", seed: "0" } } }]);
        await persistLocalComfyDefaultDraft({}, {
            updateDefaults: (defaults) => { current = { ...current, localComfyDefaults: defaults }; },
            readConfig: () => current,
            commitConfig: async (snapshot) => { snapshots.push(structuredClone(snapshot)); },
        });
        expect(snapshots[1]).toEqual({ channels: [], localComfyDefaults: {} });
    });
    test("old or malformed configuration stays explicitly unconfigured", () => {
        for (const value of [undefined, null, false, "qwen_image_2_1", [], { image: [] }, { video: { recipeId: " " } }]) {
            expect(normalizeLocalComfyDefaults(value)).toEqual({});
        }
        expect(localComfyEntrySelection(undefined, "image")).toEqual({ recipeId: "", seed: "0" });
        expect(normalizeLocalComfyMode("text")).toBeUndefined();
        expect(normalizeLocalComfyMode("video")).toBe("video");
    });

    test("only recipe metadata survives normalization and serialization", () => {
        const normalized = normalizeLocalComfyDefaults({
            image: { recipeId: " qwen_image_2_1 ", seed: 0, apiKey: "TEST-ONLY-SECRET", prompt: "private script" },
            video: { recipeId: "h3_i2v_turbo4", seed: "4294967295", referenceAssetIds: ["private-reference"] },
            channelId: "cloud-channel",
        });
        expect(normalized).toEqual({ image: { recipeId: "qwen_image_2_1", seed: "0" }, video: { recipeId: "h3_i2v_turbo4", seed: "4294967295" } });
        const persisted = JSON.stringify(normalized);
        expect(persisted).not.toContain("private");
        expect(persisted).not.toContain("SECRET");
        expect(localComfyEntrySelection(JSON.parse(persisted), "video")).toEqual({ recipeId: "h3_i2v_turbo4", seed: "4294967295" });
    });

    test("recipe modes map to actual image and video uses only", () => {
        for (const mode of ["t2i", "i2i"]) expect(localComfyRecipeMode({ mode })).toBe("image");
        for (const mode of ["t2v", "i2v"]) expect(localComfyRecipeMode({ mode })).toBe("video");
        for (const mode of ["text", "audio", "ref2va", ""]) expect(localComfyRecipeMode({ mode })).toBeUndefined();
    });

    test("ready status, exact recipe registration and intended use are required", () => {
        expect(localComfyDefaultProblem({ recipeId: "qwen_image_2_1", seed: "0" }, recipes, "image")).toBe("");
        expect(localComfyDefaultProblem({ recipeId: "h3_i2v_turbo4", seed: "1" }, recipes, "video")).toBe("");
        expect(localComfyDefaultProblem({ recipeId: "h3_i2v_turbo4", seed: "0" }, recipes, "image")).not.toBe("");
        expect(localComfyDefaultProblem({ recipeId: "qwen_image_2_1", seed: "0" }, recipes.map((recipe) => ({ ...recipe, ready: false })), "image")).not.toBe("");
        expect(localComfyDefaultProblem({ recipeId: "removed-recipe", seed: "0" }, recipes, "image")).not.toBe("");
    });

    test("stale selections and invalid seed drafts are retained without fallback", () => {
        const saved = normalizeLocalComfyDefaults({ image: { recipeId: "removed-recipe", seed: "" } });
        expect(saved.image?.seed).toBe("");
        expect(localComfyEntrySelection(saved, "image")).toEqual({ recipeId: "removed-recipe", seed: "" });
        expect(localComfyEntrySelection(saved, "video")).toEqual({ recipeId: "", seed: "0" });
        expect(localComfyDefaultsReady(saved, recipes, true)).toBe(false);
    });

    test("the original uint32 seed range includes zero and its maximum", () => {
        for (const seed of ["0", "1", "4294967295"]) expect(localComfySeedProblem(seed)).toBe("");
        for (const seed of ["", "-1", "1.2", "4294967296", "NaN", "1e5", " 0", "0 "]) expect(localComfySeedProblem(seed)).not.toBe("");
    });

    test("unloaded, pending or failed recipe reads cannot unlock local-only save-and-return", () => {
        const saved = { image: { recipeId: "qwen_image_2_1", seed: "0" } };
        expect(localComfyDefaultsReady(saved, undefined, false)).toBe(false);
        expect(localComfyDefaultsReady(saved, recipes, false)).toBe(false);
        expect(localComfyDefaultsReady(saved, [], true)).toBe(false);
        expect(localComfyDefaultsReady(saved, recipes, true)).toBe(true);
        expect(localComfyDefaultsReady({ video: saved.image }, recipes, true)).toBe(false);
        expect(localComfyDefaultsReady({ image: { ...saved.image, seed: "-1" } }, recipes, true)).toBe(false);
    });

    test("late preference hydration preserves explicit per-shot overrides", () => {
        const initial = localComfyEntrySelection(undefined, "image");
        const saved = localComfyEntrySelection({ image: { recipeId: "qwen_image_2_1", seed: "24" } }, "image");
        expect(applyLocalComfyEntryDefaults(saved, initial, { recipe: false, seed: false })).toEqual(saved);
        const edited = { recipeId: "qwen_image_2_1_preview512", seed: "73" };
        expect(applyLocalComfyEntryDefaults(saved, edited, { recipe: true, seed: true })).toEqual(edited);
        expect(applyLocalComfyEntryDefaults(saved, edited, { recipe: false, seed: true })).toEqual({ recipeId: "qwen_image_2_1", seed: "73" });
        expect(applyLocalComfyEntryDefaults(saved, edited, { recipe: true, seed: false })).toEqual({ recipeId: "qwen_image_2_1_preview512", seed: "24" });
        expect(saved).toEqual({ recipeId: "qwen_image_2_1", seed: "24" });
        expect(edited).toEqual({ recipeId: "qwen_image_2_1_preview512", seed: "73" });
    });

    test("a new video entry resets transient overrides using its own saved default", () => {
        const saved = { image: { recipeId: "qwen_image_2_1", seed: "10" }, video: { recipeId: "h3_i2v_turbo4", seed: "11" } };
        const transient = { recipeId: "qwen_image_2_1_preview512", seed: "99" };
        const video = localComfyEntrySelection(saved, "video");
        expect(applyLocalComfyEntryDefaults(video, transient, { recipe: false, seed: false })).toEqual(saved.video);
        expect(localComfyEntrySelection(JSON.parse(JSON.stringify(saved)), "image")).toEqual(saved.image);
    });
});

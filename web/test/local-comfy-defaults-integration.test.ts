import { expect, test } from "bun:test";
import { localComfyEntrySelection, persistLocalComfyDefaultDraft } from "../src/lib/local-comfy-defaults";
import { awaitModelConfigSaved } from "../src/lib/channel-settings-actions";
import { createModelConfigRepository } from "../src/services/model-config-repository";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, useConfigStore, type AiConfig } from "../src/stores/use-config-store";

const preferences = { image: { recipeId: "qwen_image_2_1", seed: "0" }, video: { recipeId: "h3_i2v_turbo4", seed: "4294967295" } };

test("canonical mock persistence restores local image/video defaults and preserves cloud choices", async () => {
    const cloud = createModelChannel({ id: "cloud", models: ["image-model", "video-model"], modelProfiles: [{ model: "image-model", capability: "image", protocol: "openai-image" }, { model: "video-model", capability: "video", protocol: "newapi" }], apiKey: "" });
    let config: AiConfig = { ...defaultConfig, channels: [cloud], imageModel: "cloud::image-model", videoModel: "cloud::video-model", localComfyDefaults: {} };
    let disk = JSON.stringify({ ...config, localComfyDefaults: {} });
    let revision = 7;
    let writes = 0;
    const dependencies = {
        read: async () => ({ config: JSON.parse(disk) as AiConfig, revision, health: "ready" as const, source: "mock-local" }),
        write: async (snapshot: AiConfig, expectedRevision: number) => {
            expect(expectedRevision).toBe(revision);
            disk = JSON.stringify(snapshot);
            writes += 1;
            return { saved: true, revision: ++revision };
        },
    };
    const firstSession = createModelConfigRepository(dependencies);
    await firstSession.hydrate();
    await persistLocalComfyDefaultDraft(preferences, {
        updateDefaults: (defaults) => { config = { ...config, localComfyDefaults: defaults }; },
        readConfig: () => config,
        commitConfig: firstSession.commit,
    });
    await awaitModelConfigSaved(firstSession.flush, firstSession.getState);
    expect(firstSession.getState()).toMatchObject({ status: "saved", dirty: false, revision: 8 });
    const reloaded = normalizeConfigSnapshot({ config: (await createModelConfigRepository(dependencies).hydrate()).config }).config;
    expect(reloaded.localComfyDefaults).toEqual(preferences);
    expect(localComfyEntrySelection(reloaded.localComfyDefaults, "video")).toEqual(preferences.video);
    expect(reloaded.imageModel).toBe("cloud::image-model");
    expect(reloaded.videoModel).toBe("cloud::video-model");
    expect(reloaded.channels.map((channel) => channel.id)).toEqual(["cloud"]);
    expect(writes).toBe(1);
});

test("failed default persistence remains dirty and explicit retry saves the same metadata", async () => {
    let attempts = 0;
    let written: AiConfig | undefined;
    const repository = createModelConfigRepository({
        read: async () => ({ config: defaultConfig, revision: 3, health: "ready", source: "mock-local" }),
        write: async (config, expectedRevision) => {
            attempts += 1;
            if (attempts <= 2) throw new Error("mock disk unavailable");
            written = structuredClone(config);
            return { saved: true, revision: expectedRevision + 1 };
        },
    });
    await repository.hydrate();
    let config: AiConfig = { ...defaultConfig, channels: [], localComfyDefaults: {} };
    await persistLocalComfyDefaultDraft(preferences, {
        updateDefaults: (defaults) => { config = { ...config, localComfyDefaults: defaults }; },
        readConfig: () => config,
        commitConfig: repository.commit,
    });
    expect(repository.getState()).toMatchObject({ status: "error", dirty: true });
    await expect(awaitModelConfigSaved(repository.flush, repository.getState)).rejects.toThrow();
    expect(written).toBeUndefined();
    await awaitModelConfigSaved(repository.flush, repository.getState);
    expect(repository.getState()).toMatchObject({ status: "saved", dirty: false, revision: 4 });
    expect(written?.localComfyDefaults).toEqual(preferences);
    expect(written?.channels).toEqual([]);
});

test("hydration retains stale defaults as metadata without creating a cloud model or channel", () => {
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [], models: [], model: "", imageModel: "", videoModel: "", textModel: "", localComfyDefaults: { image: { recipeId: "removed-recipe", seed: "-1" } } } }).config;
    expect(config.localComfyDefaults).toEqual({ image: { recipeId: "removed-recipe", seed: "-1" } });
    expect(config.channels).toEqual([]);
    expect(config.imageModels).toEqual([]);
    expect(config.videoModels).toEqual([]);
    expect(config.imageModel).toBe("");
    expect(config.videoModel).toBe("");
    expect(useConfigStore.getState().isAiConfigReady(config, "")).toBe(false);
});

test("valid local defaults keep the native cloud-generation guard unchanged", () => {
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [], models: [], apiKey: "", model: "", imageModel: "", videoModel: "", textModel: "", localComfyDefaults: preferences } }).config;
    expect(config.localComfyDefaults).toEqual(preferences);
    expect(config.models).toEqual([]);
    expect(config.channels).toEqual([]);
    expect(useConfigStore.getState().isAiConfigReady(config, "qwen_image_2_1")).toBe(false);
    expect(useConfigStore.getState().isAiConfigReady(config, "h3_i2v_turbo4")).toBe(false);
});

import { describe, expect, test } from "bun:test";
import { awaitModelConfigSaved, manualChannelModelPatch, modelConfigSaveLabel } from "../src/lib/channel-settings-actions";
import type { ModelConfigPersistenceState } from "../src/services/model-config-repository";

describe("explicit manual channel models", () => {
    test("an opaque provider model ID gets the selected image use without renaming it", () => {
        const result = manualChannelModelPatch({ apiFormat: "openai", models: [] }, "  vendor/opaque-123  ", "image");
        expect(result.models).toEqual(["vendor/opaque-123"]);
        expect(result.modelProfiles).toEqual([expect.objectContaining({ model: "vendor/opaque-123", capability: "image", protocol: "openai-image" })]);
    });

    test("an explicit text use wins over a misleading model-name heuristic", () => {
        const result = manualChannelModelPatch({ apiFormat: "openai", models: [] }, "video-script-writer", "text");
        expect(result.modelProfiles[0]).toMatchObject({ capability: "text", protocol: "chat-completion" });
    });

    test("adding a model preserves the existing user's protocol and original channel", () => {
        const channel = { apiFormat: "openai" as const, models: ["kept"], modelProfiles: [{ model: "kept", capability: "text" as const, protocol: "openai-response", displayName: "Kept" }] };
        const result = manualChannelModelPatch(channel, "new-model", "video");
        expect(channel.models).toEqual(["kept"]);
        expect(result.models).toEqual(["kept", "new-model"]);
        expect(result.modelProfiles[0]).toEqual(channel.modelProfiles[0]);
        expect(result.modelProfiles[1]).toMatchObject({ capability: "video", protocol: "newapi-channel-2" });
    });

    test("duplicate manual addition cannot overwrite an existing model use", () => {
        const channel = { apiFormat: "openai" as const, models: ["kept"], modelProfiles: [{ model: "kept", capability: "text" as const, protocol: "openai-response" }] };
        expect(() => manualChannelModelPatch(channel, " kept ", "image")).toThrow("该模型已存在");
        expect(channel.modelProfiles[0].capability).toBe("text");
    });

    test("empty model IDs cannot create an empty tag", () => {
        expect(() => manualChannelModelPatch({ apiFormat: "openai", models: [] }, " \n ", "text")).toThrow("请输入模型 ID");
    });

    test("Gemini models keep their format instead of inventing a Chat protocol", () => {
        const result = manualChannelModelPatch({ apiFormat: "gemini", models: [] }, "opaque-model", "text");
        expect(result.modelProfiles[0]).toMatchObject({ capability: "text", protocol: undefined });
    });
});

const state = (patch: Partial<ModelConfigPersistenceState> = {}): ModelConfigPersistenceState => ({ status: "saved", revision: 7, dirty: false, error: "", ...patch });

describe("confirmed model config completion", () => {
    test("completion waits for the pending write before reading its result", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let checked = false;
        const result = awaitModelConfigSaved(() => pending, () => { checked = true; return state(); });
        await Promise.resolve();
        expect(checked).toBe(false);
        release();
        await result;
        expect(checked).toBe(true);
    });

    test("a flush that resolves after a handled write failure cannot allow completion", async () => {
        await expect(awaitModelConfigSaved(async () => undefined, () => state({ status: "error", dirty: true, error: "disk unavailable" }))).rejects.toThrow("配置尚未保存");
    });

    test("edits arriving during the flush remain pending instead of claiming success", async () => {
        await expect(awaitModelConfigSaved(async () => undefined, () => state({ dirty: true }))).rejects.toThrow("编辑内容已保留");
    });

    test("unrestored configuration cannot be called saved", async () => {
        await expect(awaitModelConfigSaved(async () => undefined, () => state({ status: "hydrating" }))).rejects.toThrow("配置尚未保存");
    });

    test("a rejected flush prevents completion", async () => {
        await expect(awaitModelConfigSaved(async () => { throw new Error("write rejected"); }, () => state())).rejects.toThrow("write rejected");
    });

    test("an unchanged configuration confirmed by hydration can return without a new write", async () => {
        await expect(awaitModelConfigSaved(async () => undefined, () => state({ status: "idle" }))).resolves.toBeUndefined();
    });

    test("a failed save can be retried with the retained same draft", async () => {
        let current = state({ status: "error", dirty: true });
        await expect(awaitModelConfigSaved(async () => undefined, () => current)).rejects.toThrow("配置尚未保存");
        await awaitModelConfigSaved(async () => { current = state({ revision: 8 }); }, () => current);
        expect(current.revision).toBe(8);
    });

    test("save feedback separates dirty, saving, failed and persisted states", () => {
        expect(modelConfigSaveLabel(state({ status: "idle", dirty: true }))).toBe("待保存");
        expect(modelConfigSaveLabel(state({ status: "saving", dirty: true }))).toBe("保存中");
        expect(modelConfigSaveLabel(state({ status: "error", dirty: true }))).toContain("保存失败");
        expect(modelConfigSaveLabel(state())).toBe("已保存到本地工作区");
    });
});

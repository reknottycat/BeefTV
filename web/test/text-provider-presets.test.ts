import { expect, test } from "bun:test";

import { TEXT_PROVIDER_PRESETS, textProviderChannelDraft } from "../src/lib/text-provider-presets";
import { applyChannelPathPrefix, normalizeChannelConnection } from "../src/lib/channel-connection";

test("public text presets use the current documented provider models", () => {
    expect(TEXT_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")).toMatchObject({
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-flash", "deepseek-v4-pro"],
    });
    expect(textProviderChannelDraft("deepseek").apiPathPrefix).toBe("/");
    expect(applyChannelPathPrefix("https://api.deepseek.com/v1/chat/completions", textProviderChannelDraft("deepseek").apiPathPrefix || "")).toBe("https://api.deepseek.com/chat/completions");
    expect(textProviderChannelDraft("minimax")).toMatchObject({
        baseUrl: "https://api.minimax.cn/v1",
        models: ["MiniMax-M2.7"],
        apiPathPrefix: "",
    });
});

test("each preset is an unconnected draft using the existing text protocol", () => {
    for (const preset of TEXT_PROVIDER_PRESETS) {
        const draft = textProviderChannelDraft(preset.id);
        expect(draft.apiFormat).toBe("openai");
        expect(draft.authMode).toBe("bearer");
        expect(draft.authHeader).toBe("");
        expect(normalizeChannelConnection(draft, draft.headers).authMode).toBe("bearer");
        expect(draft.apiKey).toBe("");
        expect(draft.secretKey).toBe("");
        expect(draft.headers).toEqual([]);
        expect(draft.credentialRef).toBeUndefined();
        expect(draft.id).toBeUndefined();
        expect(draft.modelProfiles?.map((profile) => profile.model)).toEqual(draft.models);
        for (const profile of draft.modelProfiles || []) {
            expect(profile.capability).toBe("text");
            expect(profile.protocol).toBe("chat-completion");
        }
    }
});

test("text templates do not advertise image or video recognition", () => {
    for (const preset of TEXT_PROVIDER_PRESETS) {
        for (const profile of textProviderChannelDraft(preset.id).modelProfiles || []) {
            expect(profile.capabilityConfig?.text?.references).toMatchObject({
                maxImages: 0,
                maxImageBytes: 0,
                maxVideos: 0,
                maxVideoBytes: 0,
            });
            expect(profile.capabilityConfig?.image).toBeUndefined();
            expect(profile.capabilityConfig?.video).toBeUndefined();
        }
    }
});

test("editing a new draft does not mutate another draft or its public template", () => {
    const first = textProviderChannelDraft("minimax");
    first.models?.push("TEST-user-model");
    first.headers?.push({ name: "X-TEST-Business", value: "TEST-only" });
    if (first.modelProfiles?.[0]?.capabilityConfig?.text) {
        first.modelProfiles[0].capabilityConfig.text.references.maxImages = 1;
    }
    const second = textProviderChannelDraft("minimax");
    expect(second.models).toEqual(["MiniMax-M2.7"]);
    expect(second.headers).toEqual([]);
    expect(second.modelProfiles?.[0]?.capabilityConfig?.text?.references.maxImages).toBe(0);
    expect(TEXT_PROVIDER_PRESETS.find((preset) => preset.id === "minimax")?.models).toEqual(["MiniMax-M2.7"]);
});

import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ModelChannel } from "@/stores/use-config-store";

export type TextProviderPresetId = "deepseek" | "minimax";

type TextProviderPreset = {
    id: TextProviderPresetId;
    name: string;
    baseUrl: string;
    models: readonly string[];
    documentationUrl: string;
    apiPathPrefix?: string;
    connectionNotice?: string;
};

// Public documentation defaults, not account-specific model discovery.
export const TEXT_PROVIDER_PRESETS: readonly TextProviderPreset[] = [
    {
        id: "deepseek",
        name: "DeepSeek 文本渠道",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-flash", "deepseek-v4-pro"],
        documentationUrl: "https://api-docs.deepseek.com/zh-cn/",
        apiPathPrefix: "/",
        connectionNotice: "已按官方说明配置根路径 /chat/completions。填写对应账号的 API Key 后再使用，连接尚未验证。",
    },
    {
        id: "minimax",
        name: "MiniMax 文本渠道",
        baseUrl: "https://api.minimax.cn/v1",
        models: ["MiniMax-M2.7"],
        documentationUrl: "https://platform.minimax.cn/docs/api-reference/text-openai-api",
    },
];

export function textProviderChannelDraft(id: TextProviderPresetId): Partial<ModelChannel> {
    const preset = TEXT_PROVIDER_PRESETS.find((item) => item.id === id);
    if (!preset) throw new Error("未知文本渠道预置");
    return {
        name: preset.name,
        baseUrl: preset.baseUrl,
        apiFormat: "openai",
        authMode: "bearer",
        authHeader: "",
        apiPathPrefix: preset.apiPathPrefix || "",
        apiKey: "",
        secretKey: "",
        headers: [],
        models: [...preset.models],
        modelProfiles: preset.models.map((model) => ({
            model,
            capability: "text",
            protocol: "chat-completion",
            capabilityConfig: {
                version: 1,
                text: defaultModelCapabilityConfig("chat-completion", model).text,
            },
        })),
    };
}

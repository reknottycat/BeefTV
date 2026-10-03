import type { ModelConfigPersistenceState } from "@/services/model-config-repository";
import type { ModelCapability, ModelChannel } from "@/stores/use-config-store";
import { ensureModelProfilesWithUiDefaults } from "@/lib/model-protocols";

export function manualChannelModelPatch(channel: Pick<ModelChannel, "models" | "modelProfiles" | "apiFormat">, name: string, capability: ModelCapability) {
    const model = name.trim();
    if (!model) throw new Error("请输入模型 ID，例如 gpt-4.1-mini");
    if (channel.models.includes(model)) throw new Error("该模型已存在，请在下方点击“配置使用”修改用途");
    const models = [...channel.models, model];
    return {
        models,
        modelProfiles: ensureModelProfilesWithUiDefaults(models, [...(channel.modelProfiles || []), { model, capability }], [], channel.apiFormat),
    };
}

export function modelConfigSaveLabel(state: ModelConfigPersistenceState) {
    if (state.status === "error" && state.error.startsWith("其他页面已修改模型配置。")) return "其他页面已修改配置。本页编辑已保留，请刷新后重新应用修改。";
    if (state.status === "hydrating") return "正在读取已保存配置";
    if (state.status === "saving") return "保存中";
    if (state.status === "error") return "保存失败，编辑内容已保留";
    if (state.dirty) return "待保存";
    if (state.status === "saved") return "已保存到本地工作区";
    return "已加载本地配置";
}

export async function awaitModelConfigSaved(flush: () => Promise<void>, getState: () => ModelConfigPersistenceState) {
    await flush();
    const state = getState();
    if (state.dirty || (state.status !== "idle" && state.status !== "saved")) {
        if (state.error.startsWith("其他页面已修改模型配置。")) throw new Error(modelConfigSaveLabel(state));
        throw new Error("配置尚未保存，编辑内容已保留。请点击“重试保存”后再完成或返回。");
    }
}

import { modelDisplayName, selectableModelsByCapability, logicalModelIDForConfig, resolveModelRequestConfig, type AiConfig, type RunningHubWorkflow } from "@/stores/use-config-store";
import { modelCapabilityConfigFor, workflowImageCapabilityConfig, workflowVideoCapabilityConfig, workflowVideoFieldsFromJson, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { isLocalComfyModel, localComfyGenerationProblem } from "@/lib/local-comfy-models";
import { workflowProviderPluginEnabled } from "@/lib/plugins/builtin/workflows";
import { usePluginStore } from "@/stores/use-plugin-store";

export type CreativeProductionTool = { model: string; mode: "image" | "video"; name: string; source: "model" | "comfyui" | "runninghub"; executable: boolean; reason?: string; capability: ModelCapabilityConfig };
export function runningHubCreativeModel(workflow: RunningHubWorkflow) {
    const kind = workflow.kind === "app" ? "app" : "workflow";
    const id = kind === "app" ? workflow.webappId || workflow.workflowId : workflow.workflowId;
    return `runninghub:${kind}:${encodeURIComponent(id.trim())}`;
}
export function creativeRunningHubWorkflow(config: AiConfig, model: string) {
    return config.runningHub.workflows.find((workflow) => runningHubCreativeModel(workflow) === model);
}
export function creativeToolCapability(config: AiConfig, model: string): ModelCapabilityConfig {
    const workflow = creativeRunningHubWorkflow(config, model);
    if (!workflow) return modelCapabilityConfigFor(config, model);
    const fields = workflow.fields?.length ? workflow.fields : workflowVideoFieldsFromJson(workflow.workflowJson);
    const images = fields.filter((field) => field.enabled !== false && field.fieldType === "image" && (field.sourceFromUpstream || field.source === "referenceImages"));
    const references = { minImages: images.filter((field) => "required" in field && field.required).length, maxImages: images.length };
    if ((workflow.capability || config.runningHub.capability) === "video") {
        const video = workflowVideoCapabilityConfig(fields);
        return { version: 1, video: { ...video, references: { ...video.references, ...references } } };
    }
    const image = workflowImageCapabilityConfig(fields);
    return { version: 1, image: { ...image, references: { ...image.references, maxImages: references.maxImages } } };
}
// Only registered native recipes and saved workflows enter execution. The broader
// model directory is discovery data, and cannot grant provider/account access.
export function creativeProductionTools(config: AiConfig): CreativeProductionTool[] {
    const tools = (["image", "video"] as const).flatMap((mode) =>
        selectableModelsByCapability(config, mode).map((model): CreativeProductionTool => {
            const local = isLocalComfyModel(model);
            const selected = { ...config, model };
            const reason = local ? localComfyGenerationProblem(config, model) : !logicalModelIDForConfig(selected) && !resolveModelRequestConfig(selected, model).channelId ? "自动制作需要系统受管模型，请在模型设置中登记" : "";
            return { model, mode, name: modelDisplayName(config, model), source: local ? "comfyui" : "model", executable: !reason, reason: reason || undefined, capability: creativeToolCapability(config, model) };
        }),
    );
    for (const workflow of config.runningHub.workflows) {
        const mode = workflow.capability || config.runningHub.capability;
        if ((mode !== "image" && mode !== "video") || !workflow.workflowId.trim()) continue;
        const model = runningHubCreativeModel(workflow);
        const capability = creativeToolCapability(config, model);
        const references = capability.video?.references.maxImages || capability.image?.references.maxImages || 0;
        const reason = !config.runningHub.enabled
            ? "RunningHub 连接未启用"
            : !workflowProviderPluginEnabled(usePluginStore.getState().runtimeStatuses, "runninghub")
              ? "RunningHub 工作流插件未启用"
              : !config.runningHub.baseUrl.trim() || !config.runningHub.apiKey.trim()
                ? "请在 RunningHub 设置中补齐连接和积分 API Key"
                : !workflow.fields?.length && !workflow.workflowJson
                  ? "请先读取并保存工作流参数"
                  : references > 0
                    ? "当前本地工作区尚不支持向 RunningHub 上传参考素材，请使用无需参考素材的条目或 DGX 配方"
                    : mode === "video" && (!capability.video?.ratios.length || (!capability.video.duration.values?.length && capability.video.duration.selection === "enum"))
                      ? "工作流尚未提供可验证的视频时长或画面比例，请补齐参数"
                      : "";
        tools.push({ model, mode, name: workflow.title?.trim() || workflow.workflowId, source: "runninghub", executable: !reason, reason: reason || undefined, capability });
    }
    return tools;
}
export const CREATIVE_PRODUCTION_TOOLS_PROMPT =
    "availableModels 包含系统模型、DGX / ComfyUI 已登记配方和 RunningHub 已保存工作流。生成项使用完整 model ID，由程序按 source 调度真实通道；executable=false 的条目目前不能提交，应说明 reason 或选择符合已确认规格的可执行工具。不得把模型目录、节点安装或账户 Key 存在当作调用授权。DGX 的固定尺寸、帧数和参考图要求不得改写成通用模型规格。图片、视频之外的音频/3D 目录条目尚未接入此自动制作链路，不得伪造已生成或已渲染。";
export function creativeMediaModels(config: AiConfig, mode: "image" | "video") {
    return creativeProductionTools(config)
        .filter((tool) => tool.mode === mode)
        .map((tool) => tool.model);
}
export function creativeMediaConfig(config: AiConfig, model: string): AiConfig {
    const tool = creativeProductionTools(config).find((candidate) => candidate.model === model);
    if (!tool) throw new Error("所选制作工具已不在当前能力目录中，请重新规划");
    if (!tool.executable) throw new Error(`${tool.name}：${tool.reason}`);
    const workflow = creativeRunningHubWorkflow(config, model);
    return workflow
        ? {
              ...config,
              model,
              taskWorkflowProvider: "runninghub",
              runningHub: { ...config.runningHub, workflowId: workflow.workflowId, selectedKind: workflow.kind === "app" ? "app" : "workflow", capability: workflow.capability || config.runningHub.capability },
          }
        : { ...config, model, taskWorkflowProvider: "model" };
}

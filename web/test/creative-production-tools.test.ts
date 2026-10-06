import { afterEach, expect, test } from "bun:test";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { usePluginStore } from "../src/stores/use-plugin-store";
import { creativeMediaConfig, creativeProductionTools, creativeToolCapability, runningHubCreativeModel } from "../src/lib/creation/creative-production-tools";
import { normalizeCreativeProposal, creativeProposalOps, creativeVideoSpecificationError } from "../src/lib/creation/creative-agent-state";

const statuses = usePluginStore.getState().runtimeStatuses;
afterEach(() => usePluginStore.setState({ runtimeStatuses: statuses }));
const workflow = { kind: "app" as const, workflowId: "app:1", title: "真实图片工作流", capability: "image" as const, fields: [{ nodeId: "1", fieldName: "text", fieldType: "string", source: "prompt", enabled: true }] };
function configured(): AiConfig {
    usePluginStore.setState({ runtimeStatuses: { ...statuses, "runninghub-workflow-provider": "enabled" } });
    return {
        ...defaultConfig,
        localComfyModels: [{ id: "qwen_image_2_1", name: "Qwen", mode: "t2i", reference_slots: 0, ready: true }],
        localComfyGenerationEnabled: true,
        runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "TEST", baseUrl: "https://www.runninghub.cn", workflows: [workflow] },
    };
}
test("能力目录包含真实配方与保存工作流，生成开关不由目录授予", () => {
    const config = configured();
    expect(creativeProductionTools(config).find((tool) => tool.source === "comfyui")?.executable).toBe(true);
    const disabled = { ...config, localComfyGenerationEnabled: false };
    expect(creativeProductionTools(disabled).find((tool) => tool.source === "comfyui")?.reason).toContain("未启用");
    expect(() => creativeMediaConfig(disabled, "local-comfy:qwen_image_2_1")).toThrow("未启用");
    expect(creativeProductionTools(config).some((tool) => tool.model === "local-comfy:unregistered")).toBe(false);
});
test("RunningHub 稳定标识按条目选择，插件关闭或连接缺失阻止调用", () => {
    const config = configured(),
        model = runningHubCreativeModel(workflow);
    const selected = creativeMediaConfig(config, model);
    expect(selected.taskWorkflowProvider).toBe("runninghub");
    expect(selected.runningHub.workflowId).toBe(workflow.workflowId);
    expect(selected.runningHub.selectedKind).toBe("app");
    expect(creativeMediaConfig(config, "local-comfy:qwen_image_2_1").taskWorkflowProvider).toBe("model");
    expect(() => creativeMediaConfig({ ...config, runningHub: { ...config.runningHub, apiKey: "" } }, model)).toThrow("积分 API Key");
    usePluginStore.setState({ runtimeStatuses: {} });
    expect(() => creativeMediaConfig(config, model)).toThrow("插件未启用");
});
test("RunningHub 引用图上传未接通时不虚报可执行", () => {
    const config = configured();
    config.runningHub.workflows = [{ ...workflow, fields: [...workflow.fields, { nodeId: "2", fieldName: "image", fieldType: "image", source: "referenceImages", required: true }] }];
    const tool = creativeProductionTools(config).find((tool) => tool.source === "runninghub")!;
    expect(tool.executable).toBe(false);
    expect(tool.reason).toContain("上传参考素材");
    expect(tool.capability.image?.references.maxImages).toBe(1);
});
test("工作流视频时长仅采用已声明参数，不借用普通模型默认值", () => {
    const config = configured();
    const saved = {
        ...workflow,
        capability: "video" as const,
        fields: [
            { nodeId: "1", fieldName: "seconds", source: "videoSeconds", fieldType: "list", options: [5, 10], fieldValue: 5 },
            { nodeId: "2", fieldName: "ratio", source: "aspectRatio", options: ["16:9"], fieldValue: "16:9" },
        ],
    };
    config.runningHub.workflows = [saved];
    expect(creativeToolCapability(config, runningHubCreativeModel(saved)).video?.duration.values).toEqual([5, 10]);
    expect(creativeToolCapability(config, runningHubCreativeModel(saved)).video?.ratios).toEqual(["16:9"]);
});
test("DGX 固定画面规格参与产物核验，不能把错误比例标为就绪", () => {
    const item = { ref: "shot", mode: "video" as const, model: "local-comfy:h3_i2v_turbo4", size: "864x480", seconds: 124 / 24 };
    expect(creativeVideoSpecificationError(item, { width: 480, height: 864, durationMs: 5167 })).toContain("比例不符");
    expect(creativeVideoSpecificationError(item, { width: 864, height: 480, durationMs: 5167 })).toBeUndefined();
});
test("方案接受工具 ID，落地保留工作流路由，未知目录 ID 被拒绝", () => {
    const config = configured(),
        model = runningHubCreativeModel(workflow);
    const raw = { title: "作品", summary: "摘要", markdown: "内容", workflow: { nodes: [{ ref: "shot", kind: "image", title: "首镜", prompt: "真实提示词" }], edges: [] }, generationItems: [{ ref: "shot", mode: "image", model }] };
    const proposal = normalizeCreativeProposal(raw, "proposal", 1, config);
    const ops = creativeProposalOps("run", proposal, { projectId: "canvas", title: "作品", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }, config);
    const op = ops.find((op) => op.type === "add_node")!;
    if (op.type !== "add_node") throw new Error("missing node");
    expect(op.metadata?.model).toBe(model);
    expect(op.metadata?.workflowProvider).toBe("runninghub");
    expect(op.metadata?.runningHubWorkflowId).toBe(workflow.workflowId);
    raw.generationItems[0]!.model = "runninghub:app:directory-only";
    expect(() => normalizeCreativeProposal(raw, "p", 1, config)).toThrow("已不可用");
});

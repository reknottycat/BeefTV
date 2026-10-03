export const modelCatalogSources = ["comfy.recipes", "rh.standard", "rh.llm"] as const;
export type ModelCatalogSource = typeof modelCatalogSources[number];
export type ModelCatalogCapability = "text" | "image" | "video" | "audio" | "3d" | "unknown";

export const modelCatalogSourceLabels: Record<ModelCatalogSource, string> = {
    "comfy.recipes": "本地已登记工作流",
    "rh.standard": "RunningHub 官方能力目录",
    "rh.llm": "RunningHub 公开文本模型目录",
};
export const modelCatalogCapabilityLabels: Record<ModelCatalogCapability, string> = {
    text: "文本", image: "图片", video: "视频", audio: "音频", "3d": "3D", unknown: "能力未知",
};

export type ModelCatalogInput = {
    name: string; kind: string; required: boolean; multiple?: boolean; options?: Array<string | number | boolean>;
    role?: string; mimeTypes?: string[]; sameAspect?: boolean; minimumWidth?: number; minimumHeight?: number;
    min?: number; max?: number; maxCount?: number; maxLength?: number; maxSizeMB?: number;
};
export type ModelCatalogEntry = {
    id: string; modelId: string; name: string; source: ModelCatalogSource; sourceVersion: string; fetchedAt: string;
    capability: ModelCatalogCapability; entryType: "registered_recipe" | "standard_endpoint" | "llm_directory_model";
    task: string; mode?: string; inputs: ModelCatalogInput[]; inputRequirementsKnown: boolean; outputKind: string;
    ready: boolean; generationEnabled: boolean; gpuVerified: boolean; billingAuthorized: boolean;
    cost: { status: "unknown"; amount: null; currency: null };
    availability: { status: string; callable: boolean; accountVerified: boolean };
    officialPricing?: unknown; officialCapabilities?: unknown; workflowSha256?: string; recipeSha256?: string;
    staticChecks?: { recipe: string; objectInfo: string; issues: Array<{ code: string; nodeId?: string; input?: string }>; modelChecks: Array<{ nodeId: string; input: string; status: string }> };
};
export type ModelCatalogPage = {
    source: ModelCatalogSource; sourceVersion: string | null; fetchedAt: string | null;
    cacheStatus: "empty" | "fresh" | "stale"; lastError: "read_failed" | "invalid_snapshot" | null;
    items: ModelCatalogEntry[]; total: number; page: number; pageSize: number; hasMore: boolean;
    readOnly: true; catalogOnly: true; generationEnabled: false; sourceUrl: string | null;
    sourceKind: "registered_workflows" | "official_capability_directory" | "public_llm_directory";
};
export type ModelCatalogQuery = { source: ModelCatalogSource; page: number; page_size: number; search?: string; capability?: ModelCatalogCapability };

export function readModelCatalogLocation(params: URLSearchParams): ModelCatalogQuery {
    const source = params.get("catalogSource");
    const capability = params.get("catalogCapability");
    const page = params.get("catalogPage") || "1";
    const pageSize = Number(params.get("catalogPageSize") || 20);
    return {
        source: modelCatalogSources.includes(source as ModelCatalogSource) ? source as ModelCatalogSource : "comfy.recipes",
        page: /^\d{1,6}$/.test(page) && Number(page) > 0 ? Number(page) : 1,
        page_size: [20, 50, 100].includes(pageSize) ? pageSize : 20,
        search: (params.get("catalogSearch") || "").slice(0, 200),
        ...(capability && Object.hasOwn(modelCatalogCapabilityLabels, capability) ? { capability: capability as ModelCatalogCapability } : {}),
    };
}

export function catalogEntryStatus(entry: Pick<ModelCatalogEntry, "source" | "availability" | "staticChecks">): string {
    if (entry.availability.status === "deprecated") return "目录标记已下架";
    if (entry.source !== "comfy.recipes") return "账户可用性未验证";
    if (entry.staticChecks?.recipe === "failed" || entry.staticChecks?.objectInfo === "failed") return "静态检查未通过";
    if (entry.staticChecks?.objectInfo === "passed") return "静态检查通过 · 真实生成未验证";
    return "节点检查未完成 · 真实生成未验证";
}

export function catalogInputDescription(input: ModelCatalogInput): string {
    const parts = [input.name, input.required ? "必填" : "可选", modelCatalogCapabilityLabels[input.kind as ModelCatalogCapability] || input.kind];
    if (input.multiple) parts.push("支持多个输入");
    if (input.mimeTypes?.length) parts.push(input.mimeTypes.join(" / "));
    if (input.minimumWidth && input.minimumHeight) parts.push(`至少 ${input.minimumWidth}×${input.minimumHeight}`);
    if (input.sameAspect) parts.push("宽高比必须与配方相同");
    if (input.maxCount !== undefined) parts.push(`最多 ${input.maxCount} 项`);
    if (input.maxSizeMB !== undefined) parts.push(`最大 ${input.maxSizeMB} MB`);
    if (input.maxLength !== undefined) parts.push(`最长 ${input.maxLength} 字符`);
    if (input.min !== undefined) parts.push(`最小 ${input.min}`);
    if (input.max !== undefined) parts.push(`最大 ${input.max}`);
    if (input.options?.length) parts.push(`可选：${input.options.join(" / ")}`);
    return parts.join(" · ");
}

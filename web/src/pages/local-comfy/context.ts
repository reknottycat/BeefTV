export type LocalComfyCanvasContext = { projectId: string; nodeId?: string; shotId?: string; prompt?: string; referenceAssetIds?: string[] };

export function localComfyCanvasPath(context: LocalComfyCanvasContext) {
    const query = new URLSearchParams({ projectId: context.projectId });
    if (context.nodeId) query.set("nodeId", context.nodeId);
    if (context.shotId) query.set("shotId", context.shotId);
    return `/local-comfy?${query}`;
}

export const localComfyJobActive = (status: string) => status === "submitting" || status === "submitted" || status === "running";
export const localComfyJobRetryable = (status: string) => status === "failed" || status === "completed";
export const localComfyStatusLabel: Record<string, string> = { submitting: "正在提交", submitted: "已排队", running: "生成中", completed: "已完成", failed: "失败", submission_unknown: "提交结果待核验" };

export function localComfySeed(value: string) {
    if (!/^\d+$/.test(value)) throw new Error("种子需为 0 到 4294967295 的整数");
    const seed = Number(value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4_294_967_295) throw new Error("种子需为 0 到 4294967295 的整数");
    return seed;
}

export function localComfyReferenceProblem(constraints: Array<{ role: string; width: number; height: number; mime_types: string[] }> | undefined, references: Array<{ mime_type: string; width?: number; height?: number } | undefined>) {
    for (const [index, constraint] of (constraints || []).entries()) {
        const reference = references[index];
        const label = constraint.role === "first_frame" ? "场景首帧" : `参考图 ${index + 1}`;
        if (!reference) return `请选择${label}`;
        if (!constraint.mime_types.includes(reference.mime_type)) return `${label}需为 PNG 图片`;
        const { width, height } = reference;
        if (!width || !height) return `${label}尺寸尚未读取，请重新上传 PNG 图片`;
        if (width < constraint.width || height < constraint.height) return `${label}尺寸至少为 ${constraint.width} × ${constraint.height}`;
        if (width * constraint.height !== height * constraint.width) return `${label}需与 ${constraint.width} × ${constraint.height} 使用相同画幅比例，请先生成正确构图的首帧`;
    }
    return "";
}

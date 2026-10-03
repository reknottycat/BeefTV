import type { LocalComfyJob, LocalComfyProject, LocalComfyShot } from "@/services/api/local-comfy";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type LocalComfyCanvasContext = { projectId: string; nodeId?: string; shotId?: string; prompt?: string; referenceAssetIds?: string[] };

type ProjectIdentity = Pick<LocalComfyProject, "upstream_project_id" | "canvas_project_id">;
type CanvasIdentity = Pick<CanvasProject, "id" | "projectId">;

export function localComfyProjectMatchesCanvas(project: ProjectIdentity | undefined, canvas: CanvasIdentity | undefined) {
    if (!project || !canvas) return false;
    if (project.canvas_project_id) {
        return project.canvas_project_id === canvas.id && (!project.upstream_project_id || project.upstream_project_id === canvas.projectId);
    }
    // Older UI registrations used the canvas ID as their upstream ID. Read
    // those records without rewriting the native-project relationship.
    if (project.upstream_project_id === canvas.id) return true;
    return Boolean(canvas.projectId && project.upstream_project_id === canvas.projectId);
}

export function localComfyProjectForCanvas<T extends ProjectIdentity>(projects: T[], canvas: CanvasIdentity | undefined) {
    const matching = projects.filter((project) => localComfyProjectMatchesCanvas(project, canvas));
    return matching.find((project) => project.canvas_project_id === canvas?.id)
        || matching.find((project) => project.upstream_project_id === canvas?.id)
        || matching[0];
}

export function localComfyProjectInput(name: string, canvasId: string, canvas: CanvasIdentity | undefined) {
    if (canvasId && (!canvas || canvas.id !== canvasId)) throw new Error("原画布尚未加载，请先返回画布核对后登记");
    return { name, upstream_project_id: canvas?.projectId || undefined, canvas_project_id: canvas?.id || undefined };
}

export function localComfyShotForContext<T extends Pick<LocalComfyShot, "upstream_shot_id">>(shots: T[], context: LocalComfyCanvasContext) {
    const sourceId = context.shotId || context.nodeId;
    return sourceId ? shots.find((shot) => shot.upstream_shot_id === sourceId) : shots[0];
}

export function localComfySourceForContext(context: LocalComfyCanvasContext, canvas: CanvasProject | undefined) {
    if (!canvas || canvas.id !== context.projectId) return undefined;
    return canvas.nodes.find((node) => node.id === context.nodeId && (!context.shotId || node.metadata?.directorShotId === context.shotId));
}

export function localComfyMatchesCanvas(context: LocalComfyCanvasContext, canvas: CanvasProject | undefined, project: LocalComfyProject | undefined, shot: LocalComfyShot | undefined, job?: Pick<LocalComfyJob, "project_id" | "shot_id">) {
    return Boolean(localComfySourceForContext(context, canvas) && localComfyProjectMatchesCanvas(project, canvas)
        && shot && shot.project_id === project?.id && shot.upstream_shot_id === (context.shotId || context.nodeId)
        && (!job || (job.project_id === project?.id && job.shot_id === shot.id)));
}

export async function loadMissingLocalComfyCanvas<T extends { id: string }>(id: string, dependencies: {
    readCurrent: () => T | undefined;
    load: () => Promise<T>;
    publish: (canvas: T) => void;
    active: () => boolean;
}) {
    const current = dependencies.readCurrent();
    if (current) return current;
    const loaded = await dependencies.load();
    if (loaded.id !== id) throw new Error("读取的画布 ID 与当前入口不一致，已停止加载");
    if (!dependencies.active()) return undefined;
    // A draft may have appeared while the backend read was in flight.
    const draft = dependencies.readCurrent();
    if (draft) return draft;
    dependencies.publish(loaded);
    return loaded;
}

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

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";
import type { TimelineProject, TimelineDirectMedia } from "@/types/timeline";
import { createDefaultTracks, DEFAULT_VIDEO_TRACK_ID } from "@/lib/timeline/timeline-tracks";
import { resourceIdFromStorageKey } from "@/services/api/resources";

export type ProductionAttempt = {
    id: string;
    submissionId?: string;
    taskId?: string;
    retryOf?: string;
    parentTaskId?: string;
    status: "pending" | "submitting" | "queued" | "running" | "unknown" | "retrieve" | "write_failed" | "failed" | "ready";
    error?: string;
    media?: TimelineDirectMedia;
};
export type ProductionShot = {
    nodeId: string;
    title: string;
    mode: "image" | "video";
    prompt: string;
    model: string;
    sourceModel?: string;
    workflow?: { id: string; kind: "workflow" | "app" };
    options: { size?: string; quality?: string; videoSeconds?: string; vquality?: string };
    referenceNodeIds: string[];
    attempts: ProductionAttempt[];
    selectedAttemptId?: string;
    approvedMetadata?: CanvasNodeMetadata;
    approvedLocalComfy?: { recipeId: string; recipeVersion: string; seed?: number };
};
export type ProductionState = {
    kind: "canvas-production";
    version: 1;
    proposalVersion: number;
    shots: ProductionShot[];
    timeline?: TimelineProject;
    assembledSelection?: string;
    reviewedSnapshot?: string;
    render?: { clientOperationId: string; timeline: TimelineProject; selection: string; taskId?: string; result?: TimelineRenderResult; error?: string };
    exports: Array<{ taskId: string; result: TimelineRenderResult }>;
};

export function readProductionState(value: Record<string, unknown>): ProductionState | undefined {
    if (value.kind !== "canvas-production" || value.version !== 1 || !Array.isArray(value.shots) || !Array.isArray(value.exports)) return;
    return value as ProductionState;
}

/** The proposal comes from actual canvas media nodes; scripts must first produce explicit nodes. */
export function productionProposal(project: CanvasProject): { state: ProductionState; excluded: string[] } {
    const excluded: string[] = [];
    const shots: ProductionShot[] = [];
    const candidates = project.nodes.slice().sort((left, right) => (left.metadata?.shotIndex ?? project.nodes.indexOf(left)) - (right.metadata?.shotIndex ?? project.nodes.indexOf(right)));
    const hasVideoShots = candidates.some((node) => node.type === "video" && node.metadata?.prompt?.trim());
    for (const node of candidates) {
        if (node.type !== "image" && node.type !== "video") continue;
        // In a film project image nodes are reference assets, not extra film shots.
        if (hasVideoShots && node.type === "image") continue;
        const prompt = node.metadata?.prompt?.trim();
        const model = node.metadata?.model?.trim();
        if (!prompt || !model) {
            excluded.push(`${node.title || "未命名素材"}：${!prompt ? "缺少生成提示词" : "未选择模型"}`);
            continue;
        }
        const references = project.connections.filter((edge) => edge.toNodeId === node.id).map((edge) => edge.fromNodeId).filter((id) => project.nodes.some((ref) => ref.id === id && ref.type === "image"));
        const media = mediaFromNode(node);
        const existing = media ? { id: `existing:${node.id}`, status: "ready" as const, media } : undefined;
        shots.push({
            nodeId: node.id, title: node.title || `镜头 ${shots.length + 1}`, mode: node.type === "video" ? "video" : "image", prompt, model,
            options: { size: node.metadata?.size, quality: node.metadata?.quality, videoSeconds: node.metadata?.seconds, vquality: node.metadata?.vquality },
            referenceNodeIds: [...new Set(references)], attempts: existing ? [existing] : [], selectedAttemptId: existing?.id,
        });
    }
    return { state: { kind: "canvas-production", version: 1, proposalVersion: 1, shots, exports: [] }, excluded };
}

export function mediaFromNode(node: CanvasNodeData): TimelineDirectMedia | undefined {
    if (!resourceIdFromStorageKey(node.metadata?.storageKey) || node.metadata?.status !== "success" || !["image", "video", "audio"].includes(node.type)) return;
    return { id: node.id, kind: node.type as "image" | "video" | "audio", title: node.title || "素材", storageKey: node.metadata.storageKey, durationMs: node.metadata.durationMs, width: node.metadata.naturalWidth, height: node.metadata.naturalHeight };
}

export function selectedProductionMedia(shot: ProductionShot) {
    return shot.attempts.find((attempt) => attempt.id === shot.selectedAttemptId && attempt.status === "ready")?.media;
}

export function productionSelection(state: ProductionState): string {
    return JSON.stringify(state.shots.map((shot) => [shot.nodeId, shot.selectedAttemptId || "", selectedProductionMedia(shot)?.storageKey || ""]));
}

export function productionReviewSnapshot(state: ProductionState): string {
    return JSON.stringify([productionSelection(state), state.timeline]);
}

export function productionProposalFingerprint(state: ProductionState): string {
    return JSON.stringify([state.proposalVersion, state.shots.map(({ nodeId, mode, prompt, model, workflow, options, referenceNodeIds, approvedLocalComfy }) => ({ nodeId, mode, prompt, model, workflow, options, referenceNodeIds, approvedLocalComfy }))]);
}

export function productionTimelineCurrent(state: ProductionState) {
    return Boolean(state.timeline && state.assembledSelection === productionSelection(state));
}

export function assembleProductionTimeline(state: ProductionState): TimelineProject {
    let cursor = 0;
    const clips = state.shots.map((shot) => {
        const media = selectedProductionMedia(shot);
        if (!media) throw new Error(`请先为“${shot.title}”选择已完成版本`);
        const durationMs = media.durationMs || Math.round(Number(shot.options.videoSeconds || 4) * 1000);
        if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`“${shot.title}”的时长尚未确定`);
        const clip = { id: `production:${shot.nodeId}`, nodeId: shot.nodeId, title: shot.title, kind: shot.mode, trackId: DEFAULT_VIDEO_TRACK_ID, startMs: cursor, durationMs, sourceStartMs: 0, sourceDurationMs: media.durationMs, directMedia: { ...media } };
        cursor += durationMs;
        return clip;
    });
    return { version: 2, tracks: createDefaultTracks(), clips, durationMs: cursor };
}

export function productionTaskStatus(task: GenerationTask): ProductionAttempt["status"] {
    if (task.status === "succeeded") return "retrieve";
    if (task.status === "queued" || task.status === "running") return task.status;
    if (task.stage?.toLowerCase().replaceAll("-", "_").includes("submission_unknown") || task.errorCode?.toLowerCase().includes("submission_unknown") || task.providerCancelStatus === "uncertain") return "unknown";
    if (task.resultState === "PENDING_MATERIALIZATION" || task.resultState === "MATERIALIZING" || task.resultState === "FAILED_RETRYABLE") return "retrieve";
    if (task.officialStatus === "pending" || task.officialStatus === "processing" || task.officialStatus === "completed") return "unknown";
    return "failed";
}

export function productionAttemptAction(attempt: ProductionAttempt): { label: string; action: "observe" | "retrieve" | "save" | "retry" | "version" } {
    switch (attempt.status) {
        case "ready": return { label: "另生成一版", action: "version" };
        case "failed": return { label: "确认失败后重试", action: "retry" };
        case "retrieve": return { label: "取回已有结果", action: "retrieve" };
        case "write_failed": return { label: "恢复保存到作品", action: "save" };
        default: return { label: "核验原任务", action: "observe" };
    }
}

export const productionStatusLabels: Record<ProductionAttempt["status"], string> = {
    pending: "待开始", submitting: "正在提交", queued: "排队中", running: "生成中", unknown: "状态待核验", retrieve: "已生成，待取回", write_failed: "已有结果，待保存", failed: "生成失败", ready: "已完成",
};

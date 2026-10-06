import type { TimelineProject, TimelineDirectMedia } from "@/types/timeline";
import type { CanvasNodeData } from "@/types/canvas";
import type { CreativeAgentState } from "./creative-agent-state";
import { buildTimelineFromNodes } from "@/lib/timeline/timeline-build";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { timelineClipVisible } from "@/lib/timeline/timeline-audio";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";

export type ProductionState = {
    enabled: true;
    timeline?: TimelineProject;
    assembledVersion?: number;
    renderKey?: string;
    renderTaskId?: string;
    renderTimeline?: TimelineProject;
    result?: TimelineRenderResult;
    exports?: Array<{ taskId: string; result: TimelineRenderResult }>;
};

/** Resolve node references once, so the persisted render snapshot survives canvas changes. */
export function productionTimeline(timeline: TimelineProject, nodes: CanvasNodeData[]): TimelineProject {
    return {
        ...timeline,
        clips: timeline.clips.map((clip) => {
            if (clip.directMedia || !["video", "image", "audio"].includes(clip.kind)) return clip;
            const node = nodes.find((node) => node.id === clip.nodeId);
            const directMedia: TimelineDirectMedia = {
                id: clip.nodeId,
                kind: clip.kind as "video" | "image" | "audio",
                title: clip.title || node?.title || "素材",
                storageKey: node?.metadata?.storageKey,
                url: node?.metadata?.content,
                durationMs: node?.metadata?.durationMs,
            };
            return { ...clip, directMedia };
        }),
    };
}

export function assembleProductionTimeline(state: CreativeAgentState, nodes: CanvasNodeData[]) {
    const planned = state.proposal?.generationItems.filter((item) => item.mode === "video").map((item) => state.media.find((media) => media.ref === item.ref)?.nodeId) || [];
    const ordered = planned.length ? planned.map((id) => nodes.find((node) => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node)) : nodes;
    return productionTimeline(buildTimelineFromNodes(ordered), nodes);
}

export function productionChecks(timeline: TimelineProject): string[] {
    const issues: string[] = [];
    const active = timeline.clips.filter((clip) => timelineClipVisible(clip, timeline.tracks));
    const visuals = active.filter((clip) => clip.kind === "video" || clip.kind === "image").sort((a, b) => a.startMs - b.startMs);
    if (!visuals.length) issues.push("至少加入一个画面片段");
    let end = 0;
    for (const clip of active) {
        if (!Number.isFinite(clip.startMs) || clip.startMs < 0 || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0) issues.push(`“${clip.title || clip.id}”的起点或时长无效`);
        if (clip.sourceStartMs !== undefined && (!Number.isFinite(clip.sourceStartMs) || clip.sourceStartMs < 0)) issues.push(`“${clip.title || clip.id}”的源起点无效`);
        if (["video", "image", "audio"].includes(clip.kind) && !resourceIdFromStorageKey(clip.directMedia?.storageKey)) issues.push(`“${clip.title || clip.id}”尚未保存为可读取的资源`);
        if (clip.kind !== "image" && clip.sourceDurationMs && (clip.sourceStartMs || 0) + clip.durationMs > clip.sourceDurationMs + 1) issues.push(`“${clip.title || clip.id}”裁剪超出源素材时长`);
        if (clip.kind === "text") issues.push("文字装饰尚不支持成片合成，请改为字幕或画面素材");
    }
    for (const clip of visuals) {
        if (clip.startMs < end) issues.push("画面片段存在重叠，请先调整剪辑");
        end = Math.max(end, clip.startMs + clip.durationMs);
    }
    const contentEnd = Math.max(end, ...active.map((clip) => clip.startMs + clip.durationMs));
    if (!Number.isFinite(timeline.durationMs) || timeline.durationMs < contentEnd) issues.push("时间线总时长小于片段范围");
    return [...new Set(issues)];
}

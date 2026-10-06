import { createTimelineRenderTask, type TimelineRenderResult } from "./api/timeline-tasks";
import { waitForGenerationTask } from "./api/task-center";
import { getResourceBlob } from "./api/resources";
import { productionChecks, productionTimeline } from "@/lib/creation/production";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

export async function exportNativeTimeline(timeline: TimelineProject, nodes: CanvasNodeData[], clientKey: string, onProgress: (percent: number, detail: string) => void) {
    const snapshot = productionTimeline(timeline, nodes);
    const issues = productionChecks(snapshot);
    if (issues.length) throw new Error(issues.join("；"));
    const task = await createTimelineRenderTask({ projectId: "", timeline: snapshot, clientKey, burnSubtitles: true });
    const completed = await waitForGenerationTask(task.id, { onTaskUpdate: (task) => onProgress(task.progress || 0, task.stage || "正在导出") });
    if (completed.status !== "succeeded") throw new Error(completed.error || "导出尚未成功");
    const result = JSON.parse(completed.resultJson || "{}") as TimelineRenderResult;
    if (!result.resourceId || !result.durationMs) throw new Error("导出回执不完整，请在任务中心核对");
    const blob = await getResourceBlob(`resource:${result.resourceId}`);
    if (!blob?.size) throw new Error("成片已保存，但下载失败，请在任务中心读取结果");
    onProgress(100, "实际成片检查通过");
    return blob;
}

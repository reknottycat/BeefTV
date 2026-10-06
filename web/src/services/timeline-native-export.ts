import { createTimelineRenderTask, type TimelineRenderResult } from "./api/timeline-tasks";
import { waitForGenerationTask, type GenerationTask } from "./api/task-center";
import { getResourceBlob } from "./api/resources";
import { productionChecks, productionTimeline } from "@/lib/creation/production";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

export type NativeTimelineExportIntent = { hash: string; key: string };

class NativeTimelineExportTaskError extends Error {}

export async function runNativeTimelineExportAttempt(
    intentRef: { current: NativeTimelineExportIntent | null },
    hash: string,
    render: (clientKey: string) => Promise<Blob>,
) {
    if (intentRef.current?.hash !== hash) intentRef.current = { hash, key: crypto.randomUUID() };
    const intent = intentRef.current;
    try {
        return await render(intent.key);
    } catch (error) {
        // Only a confirmed failed/cancelled task permits a new render. Lost replies
        // and failed downloads must reuse the existing task on the next attempt.
        if (error instanceof NativeTimelineExportTaskError && intentRef.current === intent) intentRef.current = null;
        throw error;
    }
}

type NativeTimelineExportDependencies = {
    createTask: typeof createTimelineRenderTask;
    waitTask: typeof waitForGenerationTask;
    readBlob: typeof getResourceBlob;
};

const defaultDependencies: NativeTimelineExportDependencies = {
    createTask: createTimelineRenderTask,
    waitTask: waitForGenerationTask,
    readBlob: getResourceBlob,
};

export async function exportNativeTimeline(
    timeline: TimelineProject,
    nodes: CanvasNodeData[],
    clientKey: string,
    onProgress: (percent: number, detail: string) => void,
    dependencies: NativeTimelineExportDependencies = defaultDependencies,
) {
    const snapshot = productionTimeline(timeline, nodes);
    const issues = productionChecks(snapshot);
    if (issues.length) throw new Error(issues.join("；"));
    const task = await dependencies.createTask({ projectId: "", timeline: snapshot, clientKey, burnSubtitles: true });
    let observedStatus: GenerationTask["status"] = task.status;
    try {
        const completed = task.status === "queued" || task.status === "running"
            ? await dependencies.waitTask(task.id, { onTaskUpdate: (update) => {
                observedStatus = update.status;
                onProgress(update.progress || 0, update.stage || "正在导出");
            } })
            : task;
        observedStatus = completed.status;
        if (completed.status !== "succeeded") throw new Error(completed.error || (completed.status === "cancelled" ? "任务已取消" : "导出尚未成功"));
        const result = JSON.parse(completed.resultJson || "{}") as TimelineRenderResult;
        if (!result.resourceId || !result.durationMs) throw new Error("导出回执不完整，请在任务中心核对");
        const blob = await dependencies.readBlob(`resource:${result.resourceId}`);
        if (!blob?.size) throw new Error("成片已保存，但下载失败，请在任务中心读取结果");
        onProgress(100, "实际成片检查通过");
        return blob;
    } catch (error) {
        // waitForGenerationTask publishes terminal status before rejecting.
        if (observedStatus === "failed" || observedStatus === "cancelled") {
            throw new NativeTimelineExportTaskError(error instanceof Error ? error.message : "导出失败");
        }
        throw error;
    }
}

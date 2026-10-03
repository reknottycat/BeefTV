import { expect, test } from "bun:test";
import { canOperateNativeTask, loadNativeTaskCenterHistory, taskResultMediaUrls } from "../src/lib/native-task-center-history";
import type { GenerationTask } from "../src/services/api/task-center";

function task(id: string, status: GenerationTask["status"] = "succeeded"): GenerationTask {
    return { id, status, type: "canvas_image", provider: "local-comfy", model: "local-comfy:qwen_image_2_1", prompt: "TEST", attempts: 1, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
}

test("local workspace histories still read the canonical native task API", async () => {
    let backendReads = 0;
    const snapshot = await loadNativeTaskCenterHistory({
        readNative: async () => { backendReads++; return [task("TEST-native-running", "running")]; },
        readHistory: () => [task("local:TEST-canvas:TEST-old-node")],
    });
    expect(backendReads).toBe(1);
    expect(snapshot.backendAvailable).toBe(true);
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.tasks.find((item) => item.id === "TEST-native-running")).toMatchObject({ status: "running", historyOnly: false });
    expect(snapshot.tasks.find((item) => item.id.startsWith("local:"))).toMatchObject({ historyOnly: true });
});

test("canonical updates win over stale canvas snapshots for the same task ID without duplicate rows", async () => {
    const snapshot = await loadNativeTaskCenterHistory({ readNative: async () => [task("TEST-same-task", "succeeded")], readHistory: () => [task("TEST-same-task", "running"), task("TEST-same-task", "failed")] });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ status: "succeeded", historyOnly: false });
    expect(canOperateNativeTask(snapshot.tasks[0])).toBe(true);
});

test("backend read failure exposes explicit non-live fallback and cannot operate remembered native task IDs", async () => {
    const snapshot = await loadNativeTaskCenterHistory({ readNative: async () => { throw new Error("TEST backend unavailable"); }, readHistory: () => [task("TEST-remembered-native-id", "running")] });
    expect(snapshot.backendAvailable).toBe(false);
    expect(snapshot.tasks[0].historyOnly).toBe(true);
    expect(canOperateNativeTask(snapshot.tasks[0])).toBe(false);
});

test("only native rows can retry, query or receive other native task operations", () => {
    expect(canOperateNativeTask(task("TEST-real-native-id", "failed"))).toBe(true);
    expect(canOperateNativeTask({ ...task("TEST-remembered-id"), historyOnly: true })).toBe(false);
    expect(canOperateNativeTask(task("local:TEST-canvas:TEST-node", "failed"))).toBe(false);
    expect(canOperateNativeTask(undefined)).toBe(false);
});

test("restored backend availability promotes the canonical record without altering historical snapshots", async () => {
    const historical = task("TEST-recovered", "running");
    const readHistory = () => [historical];
    const offline = await loadNativeTaskCenterHistory({ readNative: async () => { throw new Error("TEST offline"); }, readHistory });
    const online = await loadNativeTaskCenterHistory({ readNative: async () => [task("TEST-recovered", "succeeded")], readHistory });
    expect(offline.tasks[0].historyOnly).toBe(true);
    expect(online.tasks[0]).toMatchObject({ status: "succeeded", historyOnly: false });
    expect(online.backendAvailable).toBe(true);
    expect(historical.status).toBe("running");
    expect(historical.historyOnly).toBeUndefined();
});

test("duplicate historical output nodes collapse without creating additional native tasks", async () => {
    const snapshot = await loadNativeTaskCenterHistory({ readNative: async () => [], readHistory: () => [task("TEST-multiple-nodes"), task("TEST-multiple-nodes")] });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].historyOnly).toBe(true);
    expect(snapshot.backendAvailable).toBe(true);
});

test("archived local images and videos render native Resource URLs without requiring a filename extension", () => {
    expect(taskResultMediaUrls(JSON.stringify({ mode: "image", images: [{ resourceId: "TEST-image", storageKey: "resource:TEST-image", url: "/api/resources/TEST-image/file" }] }))).toEqual(["/api/resources/TEST-image/file"]);
    expect(taskResultMediaUrls(JSON.stringify({ mode: "video", video: { url: "/api/resources/TEST-video/file" } }))).toEqual(["/api/resources/TEST-video/file"]);
    expect(taskResultMediaUrls(JSON.stringify({ images: [{ url: "/api/resources/TEST-image/file", dataUrl: "/api/resources/TEST-image/file" }] }))).toHaveLength(1);
    expect(taskResultMediaUrls(JSON.stringify({ localComfy: { jobId: "TEST-job", promptId: "TEST-prompt" }, storageKey: "resource:TEST-image" }))).toEqual([]);
});

test("existing cloud and inline result previews remain readable with a bounded list", () => {
    expect(taskResultMediaUrls(JSON.stringify({ images: [{ url: "https://example.invalid/generated.png" }], video: { dataUrl: "data:video/mp4;base64,TEST" } }))).toEqual(["https://example.invalid/generated.png", "data:video/mp4;base64,TEST"]);
    expect(taskResultMediaUrls(JSON.stringify({ images: Array.from({ length: 30 }, (_, index) => ({ url: `/api/resources/TEST-${index}/file` })) }))).toHaveLength(12);
});

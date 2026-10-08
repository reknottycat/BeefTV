import { beforeEach, expect, mock, test } from "bun:test";
import type { CreationRunDetail, CreationSubmission } from "@/services/api/creation-runs";
import type { GenerationTask } from "@/services/api/task-center";
import type { ProductionState } from "@/lib/creation/production";

const copy = <T>(value: T): T => structuredClone(value);
let detail: CreationRunDetail;
let tasks: Record<string, GenerationTask>;
let document: { id: string; nodes: Array<{ id: string; type: string; metadata: Record<string, unknown> }>; connections: never[] };
let events: string[];
let prepared: number;
let executed: number;
let rendered: string[];
let loseExecuteReply: boolean;
let loseRenderReply: boolean;
let commitFails: boolean;
let configUnavailable: boolean;
let waitStarted: (() => void) | undefined;
let queryGate: Promise<void> | undefined;
let queryStarted: (() => void) | undefined;
let mutateOnGet: (() => void) | undefined;
const task = (id: string, status: GenerationTask["status"] = "succeeded") => ({ id, type: "canvas_video", status, prompt: "镜头提示词", attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ video: { storageKey: `resource:${id}`, url: `/api/resources/${id}/file` } }) }) as GenerationTask;
const runs = {
    get: async () => { mutateOnGet?.(); mutateOnGet = undefined; return copy(detail); },
    claim: async (_id: string, input: { owner: string }) => { detail.run.executionOwner = input.owner; detail.run.executionEpoch++; return copy(detail.run); },
    save: async (_id: string, input: { state: Record<string, unknown>; revision: number; status: string }) => {
        expect(input.revision).toBe(detail.run.revision);
        detail.run = { ...detail.run, state: copy(input.state), status: input.status as typeof detail.run.status, revision: detail.run.revision + 1 };
        events.push(`save:${input.status}`); return copy(detail.run);
    },
    heartbeat: async () => ({ leaseExpiresAt: "" }), release: async () => ({ released: true }),
    canvasSnapshot: async () => ({ document: copy(document), snapshotHash: "snapshot" }),
    approveProposal: async () => { detail.run.approvedProposalHash = "approved"; detail.run.revision++; return copy(detail.run); },
    invalidateProposal: async () => { detail.run.approvedProposalHash = undefined; detail.run.revision++; return copy(detail.run); },
    prepare: async (_id: string, input: { itemKey: string }) => {
        prepared++;
        const item: CreationSubmission = { id: `submission-${prepared}`, runId: detail.run.id, itemKey: input.itemKey, requestHash: "hash", execution: { model: "model", configHash: "hash" } };
        detail.submissions.push(item); return copy(item);
    },
    approve: async (_id: string, input: { submissionIds: string[] }) => { const submissions = detail.submissions.filter((item) => input.submissionIds.includes(item.id)); for (const item of submissions) item.approvedAt = "approved"; return { submissions: copy(submissions) }; },
    execute: async (_id: string, input: { submissionId: string }) => {
        const submission = detail.submissions.find((item) => item.id === input.submissionId)!;
        if (submission.taskId) return copy(tasks[submission.taskId]);
        executed++;
        submission.taskId = `task-${executed}`;
        tasks[submission.taskId] = task(submission.taskId, waitStarted ? "running" : "succeeded");
        events.push("execute");
        if (loseExecuteReply) { loseExecuteReply = false; throw new Error("execute reply lost"); }
        return copy(tasks[submission.taskId]);
    },
    commitCanvas: async (_id: string, input: { document: typeof document }) => { if (commitFails) throw new Error("canvas changed"); document = copy(input.document); events.push("commit"); return { snapshotHash: "new-snapshot" }; },
};
mock.module("@/services/api/creation-runs", () => ({ creationRuns: runs }));
mock.module("@/services/api/generation-task", () => ({
    prepareBackendGenerationTask: async (input: { mode: string; prompt: string; projectId: string; config: Record<string, unknown> }) => { if (configUnavailable) throw new Error("device offline"); return { type: `canvas_${input.mode}`, projectId: input.projectId, prompt: input.prompt, model: input.config.model, input: { mode: input.mode, prompt: input.prompt, config: { size: "16:9", videoSeconds: "4" } } }; },
    parseBackendGenerationResult: (value: GenerationTask) => JSON.parse(value.resultJson || "{}"),
}));
mock.module("@/services/api/task-center", () => ({
    canRetrieveVideoResult: (value: GenerationTask) => value.status === "cancelled" || (value.status === "failed" && Boolean(value.providerRequestId)),
    queryFailedVideoProviderTask: async (id: string) => ({ task: copy(tasks[id]), recovered: true, providerStatus: "succeeded" }),
    queryGenerationTask: async (id: string) => { queryStarted?.(); if (queryGate) await queryGate; return copy(tasks[id]); },
    waitForGenerationTask: async (id: string, options: { signal?: AbortSignal }) => {
        if (!waitStarted) return copy(tasks[id]);
        waitStarted();
        await new Promise<void>((_resolve, reject) => { if (options.signal?.aborted) reject(new DOMException("aborted", "AbortError")); else options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); });
        return copy(tasks[id]);
    },
}));
mock.module("@/services/api/resources", () => ({
    resourceIdFromStorageKey: (key?: string) => key?.startsWith("resource:") ? key.slice(9) : "",
    getResource: async (id: string) => ({ id, status: "ready", durationMs: 4000, width: 1920, height: 1080 }),
}));
mock.module("@/services/api/timeline-tasks", () => ({
    createTimelineRenderTask: async (input: { clientOperationId: string; options: unknown }) => {
        expect(input.options).toEqual({ burnSubtitles: true });
        rendered.push(input.clientOperationId);
        const result = { ...task("render"), resultJson: JSON.stringify({ resourceId: "render-result" }) };
        tasks.render = result;
        if (loseRenderReply) { loseRenderReply = false; throw new Error("render reply lost"); }
        return result;
    },
}));
mock.module("@/lib/user-scope-guard", () => ({ captureUserScope: () => ({ userScope: "test", epoch: 1 }), assertUserScope: () => undefined }));

const { ProductionCoordinator } = await import("@/services/production-coordinator");
const { assembleProductionTimeline, productionReviewSnapshot, productionSelection } = await import("@/lib/creation/production");
const config = () => ({ model: "model", count: "1" }) as never;
const create = () => new ProductionCoordinator(copy(detail), config, () => undefined);

beforeEach(() => {
    events = []; tasks = {}; prepared = 0; executed = 0; rendered = [];
    loseExecuteReply = false; loseRenderReply = false; commitFails = false; configUnavailable = false; waitStarted = undefined; queryStarted = undefined; queryGate = undefined; mutateOnGet = undefined;
    const state: ProductionState = { kind: "canvas-production", version: 1, proposalVersion: 1, exports: [], shots: ["one", "two"].map((id) => ({ nodeId: id, title: id, mode: "video", prompt: "镜头提示词", model: "model", options: {}, referenceNodeIds: [], attempts: [] })) };
    detail = { run: { id: "run", userId: "user", canvasId: "canvas", revision: 1, executionEpoch: 0, executionOwner: "", status: "idle", state, createdAt: "", updatedAt: "" }, submissions: [] };
    document = { id: "canvas", nodes: state.shots.map((shot) => ({ id: shot.nodeId, type: "video", metadata: { prompt: shot.prompt, model: shot.model } })), connections: [] };
});

test("pause stays available while observing and prevents the next shot submission", async () => {
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => { entered = resolve; });
    waitStarted = entered;
    const service = create();
    const running = service.start();
    await observed;
    expect(service.view.busy).toBe(true);
    service.pause();
    await running;
    expect(executed).toBe(1);
    expect(service.view.run.status).toBe("paused");
    expect(service.view.state.shots[0].attempts[0].taskId).toBe("task-1");
    expect(service.view.state.shots[1].attempts).toHaveLength(0);
});

test("lost execute reply retrieves the persisted result even when the tool is offline and canvas edits block writeback", async () => {
    loseExecuteReply = true;
    const service = create();
    await expect(service.start()).rejects.toThrow("reply lost");
    const attempt = service.view.state.shots[0].attempts[0];
    expect(attempt.taskId).toBeUndefined();
    expect(detail.submissions[0].taskId).toBe("task-1");
    configUnavailable = true;
    document.nodes[0].metadata.prompt = "后来修改的提示词";
    commitFails = true;
    await service.recoverShot("one", attempt.id);
    expect(executed).toBe(1);
    expect(prepared).toBe(1);
    expect(service.view.state.shots[0].attempts[0].taskId).toBe("task-1");
    expect(service.view.state.shots[0].attempts[0].status).toBe("write_failed");
    expect(service.view.state.shots[0].attempts[0].media?.storageKey).toBe("resource:task-1");
});

test("a failed canvas save recovers the result without generating again", async () => {
    commitFails = true;
    const service = create();
    await service.start();
    const attempt = service.view.state.shots[0].attempts[0];
    expect(attempt.status).toBe("write_failed");
    expect(attempt.media?.storageKey).toBe("resource:task-1");
    commitFails = false;
    await service.recoverShot("one", attempt.id);
    expect(executed).toBe(1);
    expect(service.view.state.shots[0].attempts[0].status).toBe("ready");
});

test("rejecting an uncertain parent keeps the original attempt and selection", async () => {
    const state = detail.run.state as ProductionState;
    state.shots[0].attempts = [{ id: "original", taskId: "unknown", status: "unknown" }];
    tasks.unknown = { ...task("unknown", "failed"), stage: "submission_unknown" };
    const service = create();
    await expect(service.newVersion("one")).rejects.toThrow("先核验原任务");
    expect(service.view.state.shots[0].attempts).toHaveLength(1);
    expect(executed).toBe(0);
});

test("pause during a read does not start a new observation after the read returns", async () => {
    const state = detail.run.state as ProductionState;
    state.shots[0].attempts = [{ id: "original", taskId: "working", status: "running" }];
    tasks.working = task("working", "running");
    let release!: () => void; let entered!: () => void;
    queryGate = new Promise<void>((resolve) => { release = resolve; });
    const queried = new Promise<void>((resolve) => { entered = resolve; }); queryStarted = entered;
    waitStarted = () => { throw new Error("should not observe after pause"); };
    const service = create();
    const recovering = service.recoverShot("one", "original");
    await queried; service.pause(); release(); await recovering;
    expect(service.view.run.status).toBe("paused");
});

test("another window cannot replace the proposal behind an already confirmed start", async () => {
    const service = create();
    mutateOnGet = () => { (detail.run.state as ProductionState).shots[0].prompt = "未经当前窗口确认的新方案"; };
    await expect(service.start()).rejects.toThrow("重新核对当前方案");
    expect(prepared).toBe(0);
    expect(executed).toBe(0);
});

test("render recovery reuses the frozen snapshot and operation identity after a lost response", async () => {
    const state = detail.run.state as ProductionState;
    for (const shot of state.shots) { shot.attempts = [{ id: shot.nodeId, status: "ready", media: { id: shot.nodeId, kind: "video", title: shot.title, storageKey: `resource:${shot.nodeId}`, durationMs: 4000 } }]; shot.selectedAttemptId = shot.nodeId; }
    state.timeline = assembleProductionTimeline(state); state.assembledSelection = productionSelection(state); state.reviewedSnapshot = productionReviewSnapshot(state);
    const service = create(); loseRenderReply = true;
    await expect(service.export()).rejects.toThrow("render reply lost");
    const frozen = copy(service.view.state.render);
    await expect(service.saveTimeline({ ...state.timeline, durationMs: 20_000 })).rejects.toThrow("先核对正在导出");
    await service.export();
    expect(rendered).toHaveLength(2);
    expect(new Set(rendered).size).toBe(1);
    expect(service.view.state.render?.timeline).toEqual(frozen?.timeline);
    expect(service.view.state.render?.result?.resourceId).toBe("render-result");
});

test("saving an older timeline draft cannot overwrite a newer saved timeline", async () => {
    const state = detail.run.state as ProductionState;
    state.timeline = { version: 2, tracks: [], clips: [], durationMs: 1000 };
    const service = create();
    mutateOnGet = () => { (detail.run.state as ProductionState).timeline!.durationMs = 9000; };
    await expect(service.saveTimeline({ ...state.timeline, durationMs: 2000 })).rejects.toThrow("时间线已在其他窗口变化");
    expect(service.view.state.timeline?.durationMs).toBe(9000);
});

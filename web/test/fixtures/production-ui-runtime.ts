import type { ProductionState } from "../../src/lib/creation/production";
import type { CreationRunDetail } from "../../src/services/api/creation-runs";
import type { GenerationTask } from "../../src/services/api/task-center";

const ready = new URLSearchParams(location.search).get("mode") === "ready";
const imageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#223346"/><circle cx="430" cy="160" r="65" fill="#c89f71"/><path d="M0 250L220 100L400 360H0Z" fill="#3d6172"/></svg>')}`;
const shots: ProductionState["shots"] = ["第一镜", "第二镜"].slice(0, ready ? 1 : 2).map((title, index) => ({
    nodeId: `shot-${index}`, title, mode: ready ? "image" : "video", prompt: "傍晚，人物推开房门，暖光照进室内。", model: "fixture-model", options: { size: "16:9", videoSeconds: "4" }, referenceNodeIds: [],
    attempts: ready ? ["old", "new"].map((id) => ({ id, status: "ready", media: { id, kind: "image", title, storageKey: `resource:${id}`, durationMs: 4000 } })) : [], selectedAttemptId: ready ? "old" : undefined,
}));
const state: ProductionState = { kind: "canvas-production", version: 1, proposalVersion: 1, shots, exports: [] };
if (ready) {
    state.timeline = { version: 2, durationMs: 4000, tracks: [{ id: "video", kind: "video", label: "画面", order: 0 }], clips: [{ id: "clip", kind: "image", nodeId: "shot-0", title: "第一镜", trackId: "video", startMs: 0, durationMs: 4000, directMedia: shots[0].attempts[0].media }] };
    state.assembledSelection = JSON.stringify(shots.map((shot) => [shot.nodeId, shot.selectedAttemptId, shot.attempts[0].media?.storageKey]));
}
let detail: CreationRunDetail = { run: { id: "run", userId: "owner", canvasId: "canvas", revision: 1, executionEpoch: 0, executionOwner: "", status: "waiting_execution", state, approvedProposalHash: ready ? "approved" : undefined, createdAt: "", updatedAt: "" }, submissions: [] };
const document = { id: "canvas", revision: 1, title: "回家的路", nodes: shots.map((shot) => ({ id: shot.nodeId, type: shot.mode, title: shot.title, metadata: { model: shot.model, prompt: shot.prompt } })), connections: [] };
const copy = <T>(value: T): T => structuredClone(value);
export const receipt = { executed: 0, renderCalls: 0, waiting: false, mutateProposal: () => { (detail.run.state as ProductionState).shots[0].prompt = "其他窗口修改后的新方案"; }, current: () => copy(detail) };
Object.assign(window, { productionFixture: receipt });
export const creationRuns = {
    list: async () => ({ runs: [copy(detail.run)] }), get: async () => copy(detail),
    claim: async (_id: string, input: { owner: string }) => { detail.run.executionEpoch++; detail.run.executionOwner = input.owner; return copy(detail.run); },
    save: async (_id: string, input: { state: ProductionState; status: typeof detail.run.status }) => { detail.run.state = copy(input.state); detail.run.status = input.status; detail.run.revision++; return copy(detail.run); },
    release: async () => ({ released: true }), heartbeat: async () => ({ leaseExpiresAt: "" }),
    canvasSnapshot: async () => ({ document: copy(document), snapshotHash: "hash" }),
    approveProposal: async () => { detail.run.approvedProposalHash = "approved"; detail.run.revision++; return copy(detail.run); },
    invalidateProposal: async () => { detail.run.approvedProposalHash = undefined; detail.run.revision++; return copy(detail.run); },
    prepare: async (_id: string, input: { itemKey: string }) => { const item = { id: `submission-${detail.submissions.length}`, runId: "run", itemKey: input.itemKey, requestHash: "hash", execution: { model: "fixture-model", configHash: "hash" } }; detail.submissions.push(item); return copy(item); },
    approve: async (_id: string, input: { submissionIds: string[] }) => { const items = detail.submissions.filter((item) => input.submissionIds.includes(item.id)); items.forEach((item) => { item.approvedAt = "approved"; }); return { submissions: copy(items) }; },
    execute: async (_id: string, input: { submissionId: string }) => { const item = detail.submissions.find((item) => item.id === input.submissionId)!; if (!item.taskId) { receipt.executed++; item.taskId = `task-${receipt.executed}`; } return queryGenerationTask(item.taskId); },
    commitCanvas: async () => ({ snapshotHash: "new" }),
};
export const loadCanvasProjectForEditing = async () => copy(document);
export const prepareBackendGenerationTask = async (input: { prompt: string; config: { model: string } }) => ({ type: "canvas_video", prompt: input.prompt, model: input.config.model, input: { mode: "video", config: { size: "16:9", videoSeconds: "4" } } });
export const queryGenerationTask = async (id: string): Promise<GenerationTask> => ({ id, type: "canvas_video", prompt: "", status: "running", attempts: 1, createdAt: "", updatedAt: "" });
export const waitForGenerationTask = async (_id: string, options: { signal?: AbortSignal }) => { receipt.waiting = true; return new Promise<GenerationTask>((_resolve, reject) => { options.signal?.addEventListener("abort", () => { receipt.waiting = false; reject(new DOMException("paused", "AbortError")); }, { once: true }); }); };
export const canRetrieveVideoResult = () => false;
export const queryFailedVideoProviderTask = async (id: string) => ({ task: await queryGenerationTask(id) });
export const parseBackendGenerationResult = () => ({});
export const createTimelineRenderTask = async () => { receipt.renderCalls++; return { ...await queryGenerationTask("render"), status: "succeeded", resultJson: JSON.stringify({ resourceId: "film" }) }; };
export const resourceIdFromStorageKey = (key?: string) => key?.startsWith("resource:") ? key.slice(9) : "";
export const resourceFileUrl = () => imageUrl;
export const getResource = async () => ({ status: "ready", durationMs: 4000 });
export const resolveMediaUrl = async () => imageUrl;
export const cacheResourceObjectUrl = async () => imageUrl;
export const captureUserScope = () => ({ userScope: "test", epoch: 1 });
export const assertUserScope = () => undefined;
export const useActiveTheme = () => new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
export const useEffectiveConfig = () => ({ model: "fixture-model", runningHub: { workflows: [] }, channels: [], size: "16:9", videoSeconds: "4" });
export const modelDisplayName = () => "工作区视频模型";
export const resolveModelChannel = () => ({ id: "fixture", name: "测试执行设备" });
export const selectableModelsByCapability = () => ["fixture-model"];
export const AssetPickerModal = () => null;

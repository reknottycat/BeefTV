import { creationRuns, type CreationRun, type CreationRunDetail } from "@/services/api/creation-runs";
import { prepareBackendGenerationTask, parseBackendGenerationResult } from "@/services/api/generation-task";
import { canRetrieveVideoResult, queryFailedVideoProviderTask, queryGenerationTask, waitForGenerationTask, type CreateTaskInput, type GenerationTask } from "@/services/api/task-center";
import { createTimelineRenderTask, type TimelineRenderResult } from "@/services/api/timeline-tasks";
import { getResource, resourceIdFromStorageKey } from "@/services/api/resources";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { assembleProductionTimeline, productionProposal, productionProposalFingerprint, productionReviewSnapshot, productionSelection, productionTaskStatus, productionTimelineCurrent, readProductionState, type ProductionAttempt, type ProductionShot, type ProductionState } from "@/lib/creation/production";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasOperation } from "@/lib/canvas/canvas-operation-contract";
import type { TimelineProject } from "@/types/timeline";

export type ProductionView = { run: CreationRun; state: ProductionState; busy: boolean; pausing: boolean; error?: string };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Coordinates approved business operations only. Planning remains in the official canvas assistant. */
export class ProductionCoordinator {
    private detail: CreationRunDetail;
    private busy = false;
    private pausing = false;
    private disposed = false;
    private observer?: AbortController;
    private owner = crypto.randomUUID();
    private scope = captureUserScope();
    private heartbeat?: ReturnType<typeof setInterval>;
    private error?: string;

    constructor(detail: CreationRunDetail, private config: () => AiConfig, private changed: (view: ProductionView) => void) {
        if (!readProductionState(detail.run.state)) throw new Error("制作记录格式不受支持");
        this.detail = detail;
    }

    static async open(project: CanvasProject) {
        if (!project.id || !project.revision) throw new Error("请先在作品中保存画布，再打开自动制作");
        const scope = captureUserScope();
        const { runs } = await creationRuns.list();
        assertUserScope(scope);
        const existing = runs.filter((run) => run.canvasId === project.id && readProductionState(run.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (existing) return creationRuns.get(existing.id);
        const { state } = productionProposal(project);
        return creationRuns.create({ clientKey: `canvas-production:${project.id}:v1`, canvasId: project.id, state });
    }

    get view(): ProductionView { return { run: this.detail.run, state: readProductionState(this.detail.run.state)!, busy: this.busy, pausing: this.pausing, error: this.error }; }
    private emit() { if (!this.disposed) this.changed(this.view); }
    private check() { assertUserScope(this.scope); if (this.disposed) throw new DOMException("已关闭制作页面", "AbortError"); }
    private get guard() { return { owner: this.owner, executionEpoch: this.detail.run.executionEpoch }; }

    private async save(state: ProductionState, status = this.detail.run.status) {
        this.check();
        this.detail.run = await creationRuns.save(this.detail.run.id, { ...this.guard, revision: this.detail.run.revision, state, status });
        this.emit();
    }

    private async changeAttempt(nodeId: string, id: string, patch: Partial<ProductionAttempt>) {
        const state = this.view.state;
        await this.save({ ...state, shots: state.shots.map((shot) => shot.nodeId === nodeId ? { ...shot, attempts: shot.attempts.map((attempt) => attempt.id === id ? { ...attempt, ...patch } : attempt) } : shot) });
    }

    private async action(work: () => Promise<void>) {
        if (this.busy) throw new Error("当前操作尚未结束");
        this.check(); this.busy = true; this.pausing = false; this.error = undefined; this.emit();
        let held = false;
        try {
            this.detail = await creationRuns.get(this.detail.run.id);
            this.check();
            this.detail.run = await creationRuns.claim(this.detail.run.id, { expectedEpoch: this.detail.run.executionEpoch, owner: this.owner });
            held = true;
            this.heartbeat = setInterval(() => {
                if (this.disposed) return;
                try { this.check(); } catch { this.observer?.abort(); return; }
                void creationRuns.heartbeat(this.detail.run.id, this.guard).catch((error) => { this.error = `制作控制权已中断：${messageOf(error)}`; this.pausing = true; this.observer?.abort(); this.emit(); });
            }, 15_000);
            await this.save(this.view.state, "running");
            await work();
        } catch (error) {
            if (!this.pausing && !this.disposed) { this.error = messageOf(error); throw error; }
        } finally {
            if (this.heartbeat) clearInterval(this.heartbeat);
            if (held) {
                if (!this.disposed) {
                    try { await this.save(this.view.state, this.pausing ? "paused" : "waiting_execution"); } catch (error) { this.error = messageOf(error); }
                }
                try { assertUserScope(this.scope); await creationRuns.release(this.detail.run.id, this.guard); } catch { /* A lost lease cannot authorize another write. */ }
            }
            this.busy = false; this.pausing = false; this.emit();
        }
    }

    pause() {
        if (!this.busy) return;
        this.pausing = true;
        // Never abort submit/approve writes. Their receipt is saved before stopping later shots.
        this.observer?.abort();
        this.emit();
    }
    dispose() { this.disposed = true; this.pausing = true; this.observer?.abort(); if (this.heartbeat) clearInterval(this.heartbeat); }

    async refreshProposal() {
        return this.action(async () => {
            if (this.view.state.shots.some((shot) => shot.attempts.some((attempt) => attempt.submissionId || attempt.taskId))) throw new Error("已有生成记录，请在原方案中恢复任务或另生成一版；不要覆盖当前方案");
            const { document } = await creationRuns.canvasSnapshot(this.detail.run.id);
            const { state } = productionProposal(document);
            this.detail.run = await creationRuns.invalidateProposal(this.detail.run.id, { ...this.guard, revision: this.detail.run.revision });
            await this.save({ ...state, proposalVersion: this.view.state.proposalVersion + 1 });
        });
    }

    async configureShot(nodeId: string, model: string) {
        return this.action(async () => {
            const state = this.view.state;
            if (state.shots.some((shot) => shot.attempts.some((attempt) => attempt.submissionId || attempt.taskId))) throw new Error("已存在生成执行项，请先完成当前方案，再回作品调整下一份方案");
            let workflow: ProductionShot["workflow"];
            if (model.startsWith("runninghub:")) {
                const match = /^runninghub:(app|workflow):(.+)$/.exec(model);
                if (!match) throw new Error("工作流标识无效");
                workflow = { kind: match[1] as "app" | "workflow", id: decodeURIComponent(match[2]) };
                if (!this.config().runningHub.workflows.some((item) => (item.kind === "app" ? "app" : "workflow") === workflow!.kind && (item.kind === "app" ? item.webappId || item.workflowId : item.workflowId) === workflow!.id)) throw new Error("所选工作流不在当前已保存目录中");
            }
            this.detail.run = await creationRuns.invalidateProposal(this.detail.run.id, { ...this.guard, revision: this.detail.run.revision });
            await this.save({ ...state, proposalVersion: state.proposalVersion + 1, shots: state.shots.map((shot) => shot.nodeId === nodeId ? { ...shot, sourceModel: shot.sourceModel || shot.model, model, workflow, approvedMetadata: undefined, approvedLocalComfy: undefined } : shot) });
        });
    }

    private async request(shot: ProductionShot, document: CanvasProject, attempt?: ProductionAttempt): Promise<CreateTaskInput> {
        const node = document.nodes.find((item) => item.id === shot.nodeId);
        if (!node) throw new Error(`“${shot.title}”已从作品删除，请先核对作品`);
        if (node.metadata?.prompt?.trim() !== shot.prompt || ![shot.sourceModel || shot.model, shot.approvedMetadata?.model].includes(node.metadata?.model)) throw new Error(`“${shot.title}”的提示词或模型已改变，请回到作品核对原方案`);
        const base = this.config();
        const config: AiConfig = { ...base, taskWorkflowProvider: "model", model: shot.model, count: "1", ...Object.fromEntries(Object.entries(shot.options).filter(([, value]) => value !== undefined)) };
        if (shot.workflow) {
            const selected = base.runningHub.workflows.find((item) => (item.kind === "app" ? "app" : "workflow") === shot.workflow!.kind && (item.kind === "app" ? item.webappId || item.workflowId : item.workflowId) === shot.workflow!.id);
            if (!selected) throw new Error("已选择的 RunningHub 工作流不存在，请检查已保存配置");
            config.taskWorkflowProvider = "runninghub";
            config.runningHub = { ...base.runningHub, selectedKind: shot.workflow.kind, workflowId: selected.workflowId };
        }
        const unsupportedRefs = document.connections.filter((edge) => edge.toNodeId === shot.nodeId).map((edge) => document.nodes.find((item) => item.id === edge.fromNodeId)).filter((item) => item?.type === "video" || item?.type === "audio");
        if (unsupportedRefs.length) throw new Error(`“${shot.title}”包含视频或音频参考，当前制作审批尚不支持；请在作品原入口生成该镜头，避免遗漏参考输入`);
        const referenceImages = shot.referenceNodeIds.map((id) => {
            const reference = document.nodes.find((item) => item.id === id);
            if (reference?.type !== "image" || reference.metadata?.status !== "success" || !resourceIdFromStorageKey(reference.metadata.storageKey)) throw new Error(`“${shot.title}”的参考图尚未保存，请先在作品中完成参考图`);
            return { id, name: reference.title || "参考图", type: reference.metadata.mimeType || "image/png", dataUrl: "", storageKey: reference.metadata.storageKey };
        });
        const request = await prepareBackendGenerationTask({ projectId: document.id, mode: shot.mode, prompt: shot.prompt, config, referenceImages, metadata: { source: "canvas-production", nodeId: shot.nodeId }, clientOperationId: attempt?.id, retryOf: attempt?.retryOf, expectedScope: this.scope });
        request.input = { ...request.input, nodeId: shot.nodeId, ...(shot.approvedLocalComfy ? { localComfy: shot.approvedLocalComfy } : {}) };
        return request;
    }

    async start() {
        const confirmedProposal = productionProposalFingerprint(this.view.state);
        return this.action(async () => {
            const state = this.view.state;
            if (productionProposalFingerprint(state) !== confirmedProposal) throw new Error("方案已在其他窗口更新，请重新核对当前方案后确认生成");
            if (!state.shots.length) throw new Error("请先在作品中准备带提示词和模型的图像或视频节点");
            if (state.shots.length > 100) throw new Error("一次制作最多确认 100 个镜头，请在作品中拆分镜头批次");
            if (!this.detail.run.approvedProposalHash) {
                const { document } = await creationRuns.canvasSnapshot(this.detail.run.id);
                const ops: CanvasOperation[] = [];
                const tools: Array<ProductionShot["approvedLocalComfy"]> = [];
                const options: ProductionShot["options"][] = [];
                for (const shot of state.shots) {
                    const request = await this.request(shot, document);
                    const tool = request.input?.localComfy as ProductionShot["approvedLocalComfy"];
                    tools.push(tool);
                    const requested = (request.input?.config || {}) as Record<string, unknown>;
                    const resolvedOptions = tool ? {} : Object.fromEntries(["size", "quality", "vquality", "videoSeconds"].filter((key) => requested[key] !== undefined).map((key) => [key, String(requested[key])])) as ProductionShot["options"];
                    options.push(resolvedOptions);
                    const metadata = { prompt: shot.prompt, model: request.model, referenceNodeIds: shot.referenceNodeIds, ...(tool ? { localComfyRecipeId: tool.recipeId, localComfyRecipeVersion: tool.recipeVersion } : { size: resolvedOptions.size, quality: resolvedOptions.quality, vquality: resolvedOptions.vquality, seconds: resolvedOptions.videoSeconds }) };
                    ops.push({ type: "update_node", id: shot.nodeId, metadata });
                }
                if (this.pausing) return;
                await this.save({ ...state, shots: state.shots.map((shot, index) => ({ ...shot, options: options[index], approvedMetadata: "metadata" in ops[index] ? ops[index].metadata : undefined, approvedLocalComfy: tools[index] })) });
                this.check();
                this.detail.run = await creationRuns.approveProposal(this.detail.run.id, { ...this.guard, revision: this.detail.run.revision, proposalVersion: state.proposalVersion, proposal: state.shots.map(({ attempts: _attempts, selectedAttemptId: _selected, ...shot }) => shot), ops });
            }
            for (const shot of this.view.state.shots) {
                if (this.pausing) break;
                const latest = shot.attempts.at(-1);
                if (latest?.status === "ready") continue;
                if (latest) {
                    await this.recover(shot.nodeId, latest.id);
                    if (this.view.state.shots.find((item) => item.nodeId === shot.nodeId)?.attempts.at(-1)?.status !== "ready") break;
                } else {
                    const attempt: ProductionAttempt = { id: crypto.randomUUID(), status: "pending" };
                    await this.save({ ...this.view.state, shots: this.view.state.shots.map((item) => item.nodeId === shot.nodeId ? { ...item, attempts: [...item.attempts, attempt] } : item) });
                    await this.submit(shot, attempt);
                    if (this.view.state.shots.find((item) => item.nodeId === shot.nodeId)?.attempts.at(-1)?.status !== "ready") break;
                }
            }
        });
    }

    private async submit(shot: ProductionShot, attempt: ProductionAttempt) {
        let submission = this.detail.submissions.find((item) => item.id === attempt.submissionId || item.itemKey === attempt.id);
        if (submission?.taskId) {
            await this.changeAttempt(shot.nodeId, attempt.id, { submissionId: submission.id, taskId: submission.taskId, status: "unknown" });
            await this.recover(shot.nodeId, attempt.id);
            return;
        }
        if (!submission) {
            if (attempt.submissionId) throw new Error("原执行项不在制作记录中，请重新读取制作记录；不会创建替代任务");
            const { document } = await creationRuns.canvasSnapshot(this.detail.run.id);
            const request = await this.request(shot, document, attempt);
            if (this.pausing) return;
            this.check();
            submission = await creationRuns.prepare(this.detail.run.id, { ...this.guard, itemKey: attempt.id, proposalVersion: this.view.state.proposalVersion, request });
            this.detail.submissions.push(submission);
        }
        await this.changeAttempt(shot.nodeId, attempt.id, { submissionId: submission.id, status: "submitting" });
        if (this.pausing) return;
        this.check();
        if (!submission.approvedAt) {
            const approved = await creationRuns.approve(this.detail.run.id, { ...this.guard, submissionIds: [submission.id] });
            for (const item of approved.submissions) this.detail.submissions = this.detail.submissions.map((existing) => existing.id === item.id ? item : existing);
        }
        if (this.pausing) return;
        try {
            this.check();
            const task = await creationRuns.execute(this.detail.run.id, { ...this.guard, submissionId: submission.id });
            await this.changeAttempt(shot.nodeId, attempt.id, { taskId: task.id, status: productionTaskStatus(task), error: undefined });
            if (!this.pausing) await this.observe(shot.nodeId, attempt.id, task);
        } catch (error) {
            await this.changeAttempt(shot.nodeId, attempt.id, { status: "unknown", error: messageOf(error) });
            throw error;
        }
    }

    async recoverShot(nodeId: string, attemptId: string) { return this.action(() => this.recover(nodeId, attemptId)); }

    private async recover(nodeId: string, attemptId: string) {
        const shot = this.view.state.shots.find((item) => item.nodeId === nodeId)!;
        const attempt = shot.attempts.find((item) => item.id === attemptId)!;
        // A lost execute response resolves by its persisted submission identity, never a new attempt.
        if (!attempt.taskId) { await this.submit(shot, attempt); return; }
        let task = await queryGenerationTask(attempt.taskId, { expectedScope: this.scope });
        if (this.pausing) return;
        if (canRetrieveVideoResult(task)) { this.check(); task = (await queryFailedVideoProviderTask(task.id, { expectedScope: this.scope })).task; }
        await this.changeAttempt(nodeId, attemptId, { status: productionTaskStatus(task), error: task.error });
        await this.observe(nodeId, attemptId, task);
    }

    private async observe(nodeId: string, attemptId: string, task: GenerationTask) {
        if (this.pausing || this.disposed) return;
        if (task.status === "queued" || task.status === "running") {
            this.observer = new AbortController();
            try { task = await waitForGenerationTask(task.id, { signal: this.observer.signal, initialTask: task, expectedScope: this.scope, onTaskUpdate: (updated) => {
                const state = this.view.state;
                this.detail.run = { ...this.detail.run, state: { ...state, shots: state.shots.map((shot) => shot.nodeId === nodeId ? { ...shot, attempts: shot.attempts.map((attempt) => attempt.id === attemptId ? { ...attempt, status: productionTaskStatus(updated), error: updated.error } : attempt) } : shot) } };
                this.emit();
            } }); }
            catch (error) {
                if (this.pausing || this.disposed) return;
                try { task = await queryGenerationTask(task.id, { expectedScope: this.scope }); }
                catch { await this.changeAttempt(nodeId, attemptId, { status: "unknown", error: messageOf(error) }); return; }
            } finally { this.observer = undefined; }
        }
        if (task.status !== "succeeded") { await this.changeAttempt(nodeId, attemptId, { status: productionTaskStatus(task), error: task.error }); return; }
        const shot = this.view.state.shots.find((item) => item.nodeId === nodeId)!;
        const result = parseBackendGenerationResult(task);
        const media = shot.mode === "video" ? result.video : result.images?.[0];
        const resourceId = resourceIdFromStorageKey(media?.storageKey);
        if (!resourceId) { await this.changeAttempt(nodeId, attemptId, { status: "retrieve", error: "任务已完成，资源尚未保存。请稍后取回已有结果。" }); return; }
        const resource = await getResource(resourceId, { expectedScope: this.scope });
        if (resource.status !== "ready") { await this.changeAttempt(nodeId, attemptId, { status: "retrieve", error: "结果资源尚未就绪" }); return; }
        await this.changeAttempt(nodeId, attemptId, { status: "write_failed", media: { id: attemptId, kind: shot.mode, title: shot.title, storageKey: media!.storageKey, durationMs: resource.durationMs, width: resource.width, height: resource.height }, error: undefined });
        try {
            const { document, snapshotHash } = await creationRuns.canvasSnapshot(this.detail.run.id);
            const node = document.nodes.find((item) => item.id === nodeId);
            if (!node) throw new Error("原镜头已删除，请在作品中核对");
            const facts = Object.fromEntries(Object.entries({ naturalWidth: resource.width, naturalHeight: resource.height, durationMs: resource.durationMs, bytes: resource.size, mimeType: resource.mimeType }).filter(([, value]) => value !== undefined));
            const metadata = { ...node.metadata, ...shot.approvedMetadata, ...facts, status: "success" as const, storageKey: media!.storageKey, content: `/api/resources/${resource.id}/file`, taskId: task.id };
            this.check();
            await creationRuns.commitCanvas(this.detail.run.id, { ...this.guard, expectedSnapshotHash: snapshotHash, document: { ...document, nodes: document.nodes.map((item) => item.id === nodeId ? { ...item, metadata } : item) } });
            const state = this.view.state;
            await this.save({ ...state, reviewedSnapshot: undefined, shots: state.shots.map((item) => item.nodeId === nodeId ? { ...item, selectedAttemptId: item.selectedAttemptId || attemptId, attempts: item.attempts.map((existing) => existing.id === attemptId ? { ...existing, status: "ready", error: undefined } : existing) } : item) });
        } catch (error) { await this.changeAttempt(nodeId, attemptId, { status: "write_failed", error: messageOf(error) }); }
    }

    async newVersion(nodeId: string) {
        const confirmedProposal = productionProposalFingerprint(this.view.state);
        return this.action(async () => {
            if (productionProposalFingerprint(this.view.state) !== confirmedProposal) throw new Error("镜头方案已变化，请重新核对生成范围");
            const shot = this.view.state.shots.find((item) => item.nodeId === nodeId)!;
            const prior = shot.attempts.at(-1);
            if (prior?.taskId) {
                const task = await queryGenerationTask(prior.taskId, { expectedScope: this.scope });
                if (task.status !== "succeeded" && productionTaskStatus(task) !== "failed") throw new Error("原任务仍在运行或状态未确定，请先核验原任务");
            } else if (prior && prior.status !== "ready") throw new Error("原提交尚未核验，请先恢复原提交");
            if (prior && !["ready", "failed"].includes(prior.status)) throw new Error("请先取回并保存已有结果");
            const attempt: ProductionAttempt = { id: crypto.randomUUID(), status: "pending", ...(prior?.taskId ? { parentTaskId: prior.taskId, ...(prior.status === "failed" || shot.model.startsWith("local-comfy:") ? { retryOf: prior.taskId } : {}) } : {}) };
            // Persist only after checking the parent; rejected retries keep every prior identity.
            await this.save({ ...this.view.state, shots: this.view.state.shots.map((item) => item.nodeId === nodeId ? { ...item, attempts: [...item.attempts, attempt] } : item) });
            await this.submit(shot, attempt);
        });
    }

    async selectVersion(nodeId: string, attemptId: string) {
        return this.action(async () => {
            this.assertEditable();
            const state = this.view.state;
            const shot = state.shots.find((item) => item.nodeId === nodeId);
            if (!shot?.attempts.some((attempt) => attempt.id === attemptId && attempt.status === "ready" && attempt.media)) throw new Error("该版本尚未保存完成");
            await this.save({ ...state, reviewedSnapshot: undefined, shots: state.shots.map((item) => item.nodeId === nodeId ? { ...item, selectedAttemptId: attemptId } : item) });
        });
    }

    private assertEditable() { if (this.view.state.render && !this.view.state.render.result) throw new Error("请先核对正在导出的任务，完成后再编辑"); }
    async assemble() { return this.action(async () => { this.assertEditable(); const state = this.view.state; await this.save({ ...state, timeline: assembleProductionTimeline(state), assembledSelection: productionSelection(state), reviewedSnapshot: undefined, render: undefined }); }); }
    async saveTimeline(timeline: TimelineProject) {
        const before = JSON.stringify(this.view.state.timeline);
        return this.action(async () => {
            this.assertEditable();
            if (JSON.stringify(this.view.state.timeline) !== before) throw new Error("时间线已在其他窗口变化，当前草稿保留；请核对后再保存");
            await this.save({ ...this.view.state, timeline, reviewedSnapshot: undefined, render: undefined });
        });
    }
    async approvePreview() {
        const confirmed = productionReviewSnapshot(this.view.state);
        return this.action(async () => {
            const state = this.view.state;
            if (productionReviewSnapshot(state) !== confirmed) throw new Error("镜头版本或剪辑已在其他窗口变化，请重新预览");
            if (!productionTimelineCurrent(state)) throw new Error("镜头选版已变化，请先按选中版本重新组装");
            await this.save({ ...state, reviewedSnapshot: confirmed });
        });
    }

    async export() {
        const confirmed = productionReviewSnapshot(this.view.state);
        return this.action(async () => {
            let state = this.view.state;
            if (!state.render) {
                if (!state.timeline || !productionTimelineCurrent(state) || state.reviewedSnapshot !== confirmed || productionReviewSnapshot(state) !== confirmed) throw new Error("请先预览并确认当前镜头版本、剪辑和声音");
                await this.save({ ...state, render: { clientOperationId: crypto.randomUUID(), timeline: structuredClone(state.timeline), selection: productionSelection(state) } });
            }
            state = this.view.state;
            const render = state.render!;
            if (render.result) return;
            if (this.pausing) return;
            this.check();
            let task = render.taskId ? await queryGenerationTask(render.taskId, { expectedScope: this.scope }) : await createTimelineRenderTask({ projectId: this.detail.run.canvasId!, timeline: render.timeline, options: { burnSubtitles: true }, clientOperationId: render.clientOperationId }, { expectedScope: this.scope });
            await this.save({ ...this.view.state, render: { ...render, taskId: task.id } });
            if (this.pausing) return;
            this.observer = new AbortController();
            try {
                if (task.status !== "succeeded") task = await waitForGenerationTask(task.id, { initialTask: task, signal: this.observer.signal, expectedScope: this.scope });
                const result = JSON.parse(task.resultJson || "null") as TimelineRenderResult | null;
                if (!result?.resourceId) throw new Error("导出任务尚未返回可下载成片");
                await this.save({ ...this.view.state, render: { ...render, taskId: task.id, result }, exports: [...this.view.state.exports.filter((item) => item.taskId !== task.id), { taskId: task.id, result }] });
            } finally { this.observer = undefined; }
        });
    }

    async unlockFailedExport() {
        return this.action(async () => {
            const render = this.view.state.render;
            if (!render?.taskId) throw new Error("提交状态尚未确定，请先恢复原导出");
            const task = await queryGenerationTask(render.taskId, { expectedScope: this.scope });
            if (task.status !== "failed" && task.status !== "cancelled") throw new Error("原导出尚未明确失败，请先恢复原导出");
            await this.save({ ...this.view.state, render: undefined, reviewedSnapshot: undefined });
        });
    }
}

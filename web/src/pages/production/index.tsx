import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBeforeUnload, useBlocker, useParams } from "react-router";
import { Alert, App, Button, Checkbox, InputNumber, Select, Spin } from "antd";
import { ArrowLeft, Clapperboard, Pause, RefreshCw } from "lucide-react";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasTimelinePreview } from "@/components/canvas/canvas-timeline-preview";
import { TimelineAudioControls } from "@/components/canvas/timeline-audio-controls";
import { ProductionCoordinator, type ProductionView } from "@/services/production-coordinator";
import { loadCanvasProjectForEditing } from "@/services/local-workspace-sync";
import { productionAttemptAction, productionProposal, productionProposalFingerprint, productionReviewSnapshot, productionStatusLabels, productionTimelineCurrent, selectedProductionMedia } from "@/lib/creation/production";
import { isLocalComfyModel, localComfyGenerationProblem, localComfyModelSummary } from "@/lib/local-comfy-models";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { useEffectiveConfig, modelDisplayName, resolveModelChannel, selectableModelsByCapability } from "@/stores/use-config-store";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { DEFAULT_AUDIO_TRACK_ID } from "@/lib/timeline/timeline-tracks";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { TimelineProject } from "@/types/timeline";

export default function ProductionPage() {
    const { id = "" } = useParams();
    const { message, modal } = App.useApp();
    const config = useEffectiveConfig();
    const configRef = useRef(config); configRef.current = config;
    const coordinator = useRef<ProductionCoordinator | null>(null);
    const [view, setView] = useState<ProductionView>();
    const [project, setProject] = useState<CanvasProject>();
    const [loadError, setLoadError] = useState("");
    const [reload, setReload] = useState(0);
    const [confirmed, setConfirmed] = useState(false);
    const [replacementConfirmed, setReplacementConfirmed] = useState(false);
    const [newVersionNode, setNewVersionNode] = useState("");
    const [timelineDraft, setTimelineDraft] = useState<TimelineProject>();
    const draftRef = useRef(timelineDraft); draftRef.current = timelineDraft;
    const savedTimelineRef = useRef<string | undefined>(undefined);
    const [draftConflict, setDraftConflict] = useState(false);
    const [picker, setPicker] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [playheadMs, setPlayheadMs] = useState(0);
    const theme = canvasThemes[useActiveTheme()];

    useEffect(() => {
        let current = true;
        setLoadError(""); setView(undefined); setConfirmed(false);
        void (async () => {
            const document = await loadCanvasProjectForEditing(id);
            if (!document) throw new Error("作品不存在，或尚未保存到工作区");
            const detail = await ProductionCoordinator.open(document);
            if (!current) return;
            setProject(document);
            const service = new ProductionCoordinator(detail, () => configRef.current, setView);
            coordinator.current = service; setView(service.view);
        })().catch((error) => { if (current) setLoadError(error instanceof Error ? error.message : String(error)); });
        return () => { current = false; coordinator.current?.dispose(); coordinator.current = null; };
    }, [id, reload]);

    const savedTimelineJSON = JSON.stringify(view?.state.timeline);
    useEffect(() => {
        const previous = savedTimelineRef.current;
        savedTimelineRef.current = savedTimelineJSON;
        const draftJSON = JSON.stringify(draftRef.current);
        if (previous !== undefined && draftJSON !== previous && draftJSON !== savedTimelineJSON) {
            setDraftConflict(true);
            return;
        }
        setTimelineDraft(savedTimelineJSON ? JSON.parse(savedTimelineJSON) as TimelineProject : undefined);
        setDraftConflict(false);
        setPlaying(false);
    }, [savedTimelineJSON]);
    const invoke = (work: Promise<unknown>) => { void work.catch((error) => message.error(error instanceof Error ? error.message : String(error))); };
    const state = view?.state;
    const proposalFingerprint = state && productionProposalFingerprint(state);
    useEffect(() => { setConfirmed(false); setNewVersionNode(""); }, [proposalFingerprint]);
    const busy = Boolean(view?.busy);
    const dirty = JSON.stringify(timelineDraft) !== JSON.stringify(state?.timeline);
    useBeforeUnload(useCallback((event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } }, [dirty]));
    const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
    useEffect(() => {
        if (blocker.state !== "blocked") return;
        const dialog = modal.confirm({ title: "声音与剪辑尚未保存", content: "返回后将保留服务器上次保存的时间线。是否放弃当前编辑？", okText: "放弃编辑并离开", cancelText: "继续编辑", onOk: () => blocker.proceed(), onCancel: () => blocker.reset() });
        return () => dialog.destroy();
    }, [blocker, modal]);
    const timelineCurrent = Boolean(state && productionTimelineCurrent(state));
    const reviewed = Boolean(state && state.reviewedSnapshot === productionReviewSnapshot(state));
    const exportLocked = Boolean(state?.render && !state.render.result);
    const editable = !busy && !exportLocked;
    const pending = state?.shots.filter((shot) => !selectedProductionMedia(shot)) || [];
    const excluded = project ? productionProposal(project).excluded : [];

    const insertAudio = async (payloads: InsertAssetPayload[], scope: CapturedUserScope) => {
        assertUserScope(scope);
        if (!timelineDraft) throw new Error("请先组装时间线");
        if (payloads.some((item) => item.kind !== "audio")) throw new Error("此入口用于加入配音和音乐，请选择音频素材");
        const clips = payloads.map((item) => {
            if (item.kind !== "audio" || !resourceIdFromStorageKey(item.storageKey)) throw new Error("请先将声音素材保存到资源库");
            if (!item.durationMs || item.durationMs <= 0) throw new Error(`“${item.title}”缺少已验证时长，请先在素材库完成音频导入`);
            const clipId = crypto.randomUUID();
            return { id: clipId, nodeId: `audio:${clipId}`, kind: "audio" as const, trackId: DEFAULT_AUDIO_TRACK_ID, title: item.title, startMs: 0, durationMs: Math.min(item.durationMs, timelineDraft.durationMs), sourceStartMs: 0, sourceDurationMs: item.durationMs, volume: 1, directMedia: { id: clipId, kind: "audio" as const, title: item.title, storageKey: item.storageKey, durationMs: item.durationMs } };
        });
        setTimelineDraft({ ...timelineDraft, clips: [...timelineDraft.clips, ...clips] }); setPicker(false);
    };

    return <WorkspacePage>
        <PageHeader title={project ? `${project.title} · 自动制作` : "自动制作"} description="确认镜头方案 → 逐镜生成与选版 → 声音剪辑 → 预览确认 → 导出" actions={<Link to={`/canvas/${id}`} className="inline-flex items-center gap-2"><ArrowLeft size={16} />返回作品</Link>} />
        {loadError ? <Alert type="error" title="制作记录读取失败" description={loadError} action={<Button onClick={() => setReload((value) => value + 1)}>重试读取</Button>} /> : !view ? <div role="status" className="p-8"><Spin /> 正在读取作品与制作记录</div> : <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,1fr)]">
            <section className="min-w-0 rounded-xl border border-border bg-card p-4">
                <h2 className="mb-2 text-base font-semibold">1. 确认方案与镜头版本</h2>
                <p className="mb-3 text-sm text-muted-foreground">方案来自本作品已保存的图像和视频节点。需要新脚本或分镜时，请返回作品使用助手或导演面板。</p>
                {view.error && <Alert type="error" title="操作未完成，已有任务与结果会保留" description={view.error} className="mb-3" />}
                {!state!.shots.length && <Alert type="info" title="还没有可制作的镜头" description="请在作品中为图像或视频节点填写提示词并选择模型，保存后刷新方案。" />}
                {excluded.length > 0 && <details className="my-3 text-sm"><summary>未纳入方案的素材（{excluded.length}）</summary><ul className="mt-2 list-disc pl-5">{excluded.map((text) => <li key={text}>{text}</li>)}</ul></details>}
                <div className="space-y-3">
                    {state!.shots.map((shot, index) => {
                        const latest = shot.attempts.at(-1);
                        const action = latest ? productionAttemptAction(latest) : undefined;
                        const selected = selectedProductionMedia(shot);
                        const provider = resolveModelChannel(config, shot.model);
                        const deviceProblem = isLocalComfyModel(shot.model) ? localComfyGenerationProblem(config, shot.model) : "";
                        const modelOptions = selectableModelsByCapability(config, shot.mode).map((value) => ({ value, label: modelDisplayName(config, value) }));
                        const workflowOptions = config.runningHub.workflows.filter((workflow) => workflow.capability === shot.mode).map((workflow) => ({ value: `runninghub:${workflow.kind === "app" ? "app" : "workflow"}:${encodeURIComponent(workflow.kind === "app" ? workflow.webappId || workflow.workflowId : workflow.workflowId)}`, label: `RunningHub · ${workflow.title || workflow.workflowId}` }));
                        return <article key={shot.nodeId} className="rounded-lg border border-border p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-medium">{index + 1}. {shot.title}</h3><span role="status" className="text-xs text-muted-foreground">{latest ? productionStatusLabels[latest.status] : "待开始"}</span></div>
                            <p className="mt-1 text-xs text-muted-foreground">{shot.mode === "video" ? "视频" : "图像"} · {shot.workflow ? "RunningHub 工作流" : provider.name || provider.id || "所选执行设备"}</p>
                            <Select className="my-2 w-full" aria-label={`${shot.title}的生成模型或工作流`} value={shot.model} disabled={busy || state!.shots.some((item) => item.attempts.some((attempt) => attempt.submissionId || attempt.taskId))} options={[...modelOptions, ...workflowOptions]} onChange={(value) => { setConfirmed(false); invoke(coordinator.current!.configureShot(shot.nodeId, value)); }} />
                            {isLocalComfyModel(shot.model) && <p className="text-xs text-muted-foreground">{localComfyModelSummary(shot.model, config)}</p>}
                            {deviceProblem && <p role="status" className="my-2 text-sm">{deviceProblem} <Link className="underline" to="/settings?section=channels">查看设备状态</Link></p>}
                            <details className="my-2 text-sm"><summary>查看生成提示词与规格</summary><p className="mt-2 whitespace-pre-wrap">{shot.prompt}</p><p className="mt-1 text-muted-foreground">{[shot.options.size, shot.options.videoSeconds && `${shot.options.videoSeconds} 秒`, shot.options.vquality, shot.options.quality].filter(Boolean).join(" · ") || "使用当前模型确认的规格"} · {shot.referenceNodeIds.length} 张参考图</p></details>
                            {latest?.error && <p role="alert" className="my-2 text-sm text-destructive">{latest.error}</p>}
                            {latest?.media?.storageKey && latest.status === "write_failed" && <a className="my-2 inline-block text-sm underline" href={resourceFileUrl(resourceIdFromStorageKey(latest.media.storageKey))} target="_blank" rel="noreferrer">查看已取回的原任务结果</a>}
                            {selected && <div className="mb-2"><span className="text-xs text-muted-foreground">成片采用版本</span><Select className="ml-2 min-w-40" size="small" aria-label={`${shot.title}的采用版本`} value={shot.selectedAttemptId} disabled={!editable} options={shot.attempts.filter((attempt) => attempt.status === "ready" && attempt.media).map((attempt) => ({ value: attempt.id, label: `版本 ${shot.attempts.indexOf(attempt) + 1}${attempt.id.startsWith("existing:") ? "（作品已有）" : ""}` }))} onChange={(value) => invoke(coordinator.current!.selectVersion(shot.nodeId, value))} /></div>}
                            {latest && action && <Button size="small" disabled={busy || exportLocked || !view.run.approvedProposalHash} onClick={() => action.action === "retry" || action.action === "version" ? setNewVersionNode(shot.nodeId) : invoke(coordinator.current!.recoverShot(shot.nodeId, latest.id))}>{action.label}</Button>}
                            {newVersionNode === shot.nodeId && <div className="mt-3 rounded-lg border border-border p-3 text-sm"><p>将使用上述模型和提示词再次生成 1 个{shot.mode === "video" ? "视频" : "图像"}，可能产生新的费用。已有版本和采用版本会保留。</p><div className="mt-2 flex gap-2"><Button size="small" type="primary" disabled={busy} onClick={() => { setNewVersionNode(""); invoke(coordinator.current!.newVersion(shot.nodeId)); }}>确认生成新版本</Button><Button size="small" onClick={() => setNewVersionNode("")}>返回</Button></div></div>}
                        </article>;
                    })}
                </div>
                <div className="mt-4 space-y-3 border-t border-border pt-4">
                    <Checkbox checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)}>我已核对以上 {state!.shots.length} 个镜头的提示词、模型和参考图；点击开始将提交其中 {pending.length} 个未完成镜头，可能产生生成费用。</Checkbox>
                    <div className="flex flex-wrap gap-2"><Button type="primary" icon={<Clapperboard size={15} />} disabled={busy || !confirmed || !state!.shots.length || exportLocked} onClick={() => invoke(coordinator.current!.start())}>{view.run.approvedProposalHash ? "继续制作并恢复未完成镜头" : "确认方案并开始生成"}</Button><Button icon={<Pause size={15} />} disabled={!busy || view.pausing} onClick={() => coordinator.current!.pause()}>{view.pausing ? "正在暂停后续操作" : "暂停后续镜头"}</Button><Button icon={<RefreshCw size={15} />} disabled={busy || state!.shots.some((shot) => shot.attempts.some((attempt) => attempt.submissionId || attempt.taskId))} onClick={() => { setConfirmed(false); invoke(coordinator.current!.refreshProposal()); }}>刷新作品方案</Button></div>
                    <p role="status" className="text-xs text-muted-foreground">{view.run.status === "paused" ? "已暂停。" : ""}暂停只停止后续提交，已经提交的镜头会继续生成。关闭页面后可回到这里核验原任务。</p>
                </div>
            </section>
            <section className="min-w-0 rounded-xl border border-border bg-card p-4">
                <h2 className="mb-2 text-base font-semibold">2. 声音剪辑与预览确认</h2>
                <p className="mb-3 text-sm text-muted-foreground">每镜采用版本明确后组装时间线。生成完成会停在这里，等待你检查声音、人物连续性和剪辑。</p>
                {state!.timeline && !timelineCurrent && <Alert className="mb-3" type="warning" title="镜头采用版本已变化" description="当前时间线仍保留上次剪辑。请核对后重新组装，再确认预览。" />}
                {draftConflict && <Alert type="warning" title="已保存的时间线发生变化，当前编辑已保留" description={<><p>下方仍显示你的编辑。已保存版本含 {state!.timeline?.clips.length || 0} 个片段、{((state!.timeline?.durationMs || 0) / 1000).toFixed(1)} 秒。</p><div className="mt-2 flex flex-wrap gap-2"><Button onClick={() => { setTimelineDraft(state!.timeline); setDraftConflict(false); }}>放弃编辑，使用已保存版本</Button><Button onClick={() => modal.confirm({ title: "用当前编辑替换已保存时间线？", content: "另一个窗口已保存的剪辑将被当前编辑替换。", okText: "确认替换", cancelText: "先不替换", onOk: async () => { if (timelineDraft) { await coordinator.current!.saveTimeline(timelineDraft); setDraftConflict(false); } } })}>保留当前编辑并替换</Button></div></>} />}
                {state!.timeline && <Checkbox disabled={!editable || dirty} checked={replacementConfirmed} onChange={(event) => setReplacementConfirmed(event.target.checked)}>重新组装将替换本次时间线的剪辑和声音设置，历史成片保留</Checkbox>}
                <div className="my-3"><Button disabled={!editable || dirty || pending.length > 0 || !state!.shots.length || Boolean(state!.timeline && !replacementConfirmed)} onClick={() => { setReplacementConfirmed(false); invoke(coordinator.current!.assemble()); }}>{state!.timeline ? "按采用版本重新组装" : "按采用版本组装时间线"}</Button></div>
                {timelineDraft && <>
                    <CanvasTimelinePreview clips={timelineDraft.clips} tracks={timelineDraft.tracks} nodes={project?.nodes || []} durationMs={timelineDraft.durationMs} playheadMs={playheadMs} playing={playing} theme={theme} onTogglePlay={() => setPlaying((value) => !value)} onPlayingChange={setPlaying} onPlayheadChange={setPlayheadMs} />
                    <div className="my-3 space-y-2">{timelineDraft.clips.map((clip) => <div key={clip.id} className="rounded-lg border border-border p-2"><p className="mb-2 text-sm">{clip.title || clip.id}</p><div className="flex flex-wrap gap-2"><label className="text-xs">起点（秒） <InputNumber size="small" min={0} value={clip.startMs / 1000} disabled={!editable} onChange={(value) => value !== null && setTimelineDraft({ ...timelineDraft, clips: timelineDraft.clips.map((item) => item.id === clip.id ? { ...item, startMs: Math.round(value * 1000) } : item) })} /></label><label className="text-xs">时长（秒） <InputNumber size="small" min={0.1} value={clip.durationMs / 1000} disabled={!editable} onChange={(value) => value !== null && setTimelineDraft({ ...timelineDraft, clips: timelineDraft.clips.map((item) => item.id === clip.id ? { ...item, durationMs: Math.round(value * 1000) } : item) })} /></label><label className="text-xs">源裁剪起点（秒） <InputNumber size="small" min={0} value={(clip.sourceStartMs || 0) / 1000} disabled={!editable} onChange={(value) => value !== null && setTimelineDraft({ ...timelineDraft, clips: timelineDraft.clips.map((item) => item.id === clip.id ? { ...item, sourceStartMs: Math.round(value * 1000) } : item) })} /></label>{clip.kind === "audio" && <Button size="small" disabled={!editable} onClick={() => setTimelineDraft({ ...timelineDraft, clips: timelineDraft.clips.filter((item) => item.id !== clip.id) })}>移除声音</Button>}</div></div>)}</div>
                    <TimelineAudioControls timeline={timelineDraft} disabled={!editable} onChange={setTimelineDraft} />
                    <div className="my-3 flex flex-wrap gap-2"><Button disabled={!editable} onClick={() => setPicker(true)}>加入配音或音乐</Button><Button disabled={!editable || !dirty || draftConflict} onClick={() => { const next = { ...timelineDraft, durationMs: Math.max(0, ...timelineDraft.clips.map((clip) => clip.startMs + clip.durationMs)) }; setTimelineDraft(next); invoke(coordinator.current!.saveTimeline(next)); }}>保存声音与剪辑</Button>{dirty && <span role="status" className="text-xs text-muted-foreground">编辑尚未保存</span>}</div>
                    <h2 className="mb-2 mt-5 text-base font-semibold">3. 确认并导出</h2>
                    <p className="mb-3 text-sm text-muted-foreground">请实际播放预览，核对镜头版本、声音和字幕。导出使用固定时间线快照，1920×1080 MP4，字幕烧录到画面。</p>
                    <div className="flex flex-wrap gap-2"><Button disabled={busy || dirty || !timelineCurrent || exportLocked} onClick={() => invoke(coordinator.current!.approvePreview())}>{reviewed ? "已确认当前预览" : "已检查预览，确认当前版本"}</Button><Button type="primary" disabled={busy || (!exportLocked && (dirty || !reviewed || !timelineCurrent))} onClick={() => invoke(coordinator.current!.export())}>{state!.render?.result ? "已导出" : exportLocked ? "恢复并核对原导出" : "导出已确认成片"}</Button>{exportLocked && <Button disabled={busy} onClick={() => invoke(coordinator.current!.unlockFailedExport())}>核验失败后解锁编辑</Button>}</div>
                    {state!.render?.result && <div className="mt-4"><video controls className="w-full rounded-lg" src={resourceFileUrl(state!.render.result.resourceId)} /><a className="mt-2 inline-block underline" href={resourceFileUrl(state!.render.result.resourceId)} download={state!.render.result.fileName || "production.mp4"}>下载成片</a></div>}
                </>}
                {!!state!.exports.length && <details className="mt-4 text-sm"><summary>历史成片（{state!.exports.length}）</summary><ul className="mt-2 space-y-2">{state!.exports.map((item, index) => <li key={item.taskId}><a className="underline" href={resourceFileUrl(item.result.resourceId)} download={item.result.fileName || `production-${index + 1}.mp4`}>下载成片 {index + 1}</a></li>)}</ul></details>}
            </section>
        </div>}
        <AssetPickerModal open={picker} onClose={() => setPicker(false)} onInsert={insertAudio} />
    </WorkspacePage>;
}

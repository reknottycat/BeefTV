import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Select, Steps, Tag } from "antd";
import { Clapperboard, Film, Library, RotateCcw } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { WorkspacePage, PageHeader } from "@/components/layout/workspace-page";
import { CreativeProposalCard, CreativeQuestionCard } from "@/components/creation/creative-agent-cards";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasTimelinePreview } from "@/components/canvas/canvas-timeline-preview";
import { CreativeAgentController, type CreativeCanvasAdapter, type CreativeControllerView } from "@/services/creative-agent-controller";
import { creationRuns, type CreationRun } from "@/services/api/creation-runs";
import { initialCreativeState } from "@/lib/creation/creative-agent-state";
import { assembleProductionTimeline, productionChecks } from "@/lib/creation/production";
import { applyCanvasOperations, type CanvasSnapshot } from "@/lib/canvas/canvas-operation-contract";
import { selectableModelsByCapability, modelDisplayName, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { listWorkspaceCanvasProjectsPage, type CanvasLibrarySummary } from "@/services/api/workspace-data";
import type { CreativeAnswers } from "@/lib/creation/creative-agent-contract";
import type { TimelineProject, TimelineClip } from "@/types/timeline";
import { useLocalComfyModelCatalog } from "@/lib/use-local-comfy-model-catalog";
import { creativeProductionTools } from "@/lib/creation/creative-production-tools";
import { usePluginStore } from "@/stores/use-plugin-store";
import "./production.css";

const emptyTimeline = (): TimelineProject => ({
    version: 2,
    tracks: [
        { id: "picture", kind: "video", label: "画面", order: 0 },
        { id: "sound", kind: "audio", label: "配音与音乐", order: 1 },
        { id: "captions", kind: "subtitle", label: "字幕", order: 2 },
    ],
    clips: [],
    durationMs: 0,
});

export default function ProductionPage() {
    const [params, setParams] = useSearchParams();
    const runId = params.get("run") || undefined;
    const savedConfig = useConfigStore((state) => state.config);
    const localCatalog = useLocalComfyModelCatalog();
    const config = { ...savedConfig, ...localCatalog };
    usePluginStore((state) => state.runtimeStatuses);
    const productionTools = creativeProductionTools(config);
    const userId = useUserStore((state) => state.user?.id);
    const theme = useThemeStore((state) => state.theme);
    const [view, setView] = useState<CreativeControllerView>({ state: initialCreativeState(), busy: false, hasControl: false });
    const [runs, setRuns] = useState<CreationRun[]>([]);
    const [projects, setProjects] = useState<CanvasLibrarySummary[]>([]);
    const [projectId, setProjectId] = useState<string>();
    const [prompt, setPrompt] = useState("");
    const [model, setModel] = useState(config.textModel || "");
    const [answers, setAnswers] = useState<CreativeAnswers>({});
    const [error, setError] = useState("");
    const [picker, setPicker] = useState(false);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [resultUrl, setResultUrl] = useState("");
    const controller = useRef<CreativeAgentController | null>(null);
    const adapter = useRef<CreativeCanvasAdapter | undefined>(undefined);
    const configRef = useRef(config);
    configRef.current = config;
    const automaticAttempt = useRef("");
    const invoke = (operation?: Promise<unknown>) => {
        setError("");
        if (operation)
            void operation.catch((cause) => {
                if (cause?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "操作未完成");
            });
    };
    const downloadSavedExport = async (resourceId: string, fileName?: string) => {
        const url = await cacheResourceObjectUrl(`resource:${resourceId}`);
        if (!url) throw new Error("成片资源暂时无法读取");
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName || "production.mp4";
        link.click();
    };

    useEffect(() => {
        let live = true;
        const abort = new AbortController();
        setView({ state: initialCreativeState(), busy: false, hasControl: false });
        setPlaying(false);
        setTime(0);
        setError("");
        setAnswers({});
        adapter.current = undefined;
        automaticAttempt.current = "";
        const ensureCanvas = async (_canvasId: string, id: string) => {
            const { document } = await creationRuns.canvasSnapshot(id, abort.signal);
            if (!live) return;
            let snapshot: CanvasSnapshot = { projectId: document.id, title: document.title, nodes: document.nodes, connections: document.connections, selectedNodeIds: [], viewport: document.viewport || { x: 0, y: 0, k: 1 } };
            adapter.current = {
                canvasId: document.id,
                read: () => snapshot,
                apply: async (ops) => {
                    snapshot = applyCanvasOperations(snapshot, ops);
                    return snapshot;
                },
            };
        };
        const instance = new CreativeAgentController({
            config: () => configRef.current,
            canvas: () => adapter.current,
            ensureCanvas,
            onChange: (next) => {
                if (live) setView(next);
            },
            onOpenCanvas: () => {
                if (live) setError("项目尚未接续，请点击继续制作");
            },
        });
        controller.current = instance;
        invoke(
            (async () => {
                const [history, library] = await Promise.all([creationRuns.list(abort.signal), listWorkspaceCanvasProjectsPage({ page: 1, pageSize: 100, signal: abort.signal })]);
                if (!live) return;
                setRuns(history.runs.filter((run) => run.state.production));
                setProjects(library.projects);
                if (runId) {
                    const detail = await creationRuns.get(runId, abort.signal);
                    if (detail.run.canvasId) await ensureCanvas(detail.run.canvasId, runId);
                    await instance.load(runId);
                }
            })(),
        );
        return () => {
            live = false;
            abort.abort();
            instance.dispose();
            if (controller.current === instance) controller.current = null;
        };
    }, [runId, userId]);

    const start = async () => {
        if (view.run) return;
        const id = await controller.current!.load(undefined, { production: { enabled: true }, scene: "short-film" }, false, projectId);
        setParams({ run: id });
    };
    const timeline = view.state.production?.timeline || emptyTimeline();
    const checks = productionChecks(timeline);
    const disabled = view.busy || !view.hasControl;
    const saveTimeline = (next: TimelineProject) => controller.current!.saveProduction({ timeline: next, assembledVersion: view.state.proposal?.version });
    const assemble = async () => {
        const next = assembleProductionTimeline(view.state, adapter.current?.read().nodes || []);
        if (!next.clips.length) throw new Error("当前项目没有可合成的视频，请加入素材或完成镜头制作");
        await saveTimeline(next);
    };
    useEffect(() => {
        if (view.busy || !view.hasControl || view.run?.status !== "completed" || !view.state.production?.enabled || !view.state.media.length || !view.state.media.every((item) => item.status === "ready")) return;
        const signature = `${view.run.id}:${view.state.proposal?.version}`;
        if (automaticAttempt.current === signature || view.state.production.result || view.state.production.timeline) return;
        automaticAttempt.current = signature;
        invoke(assemble().then(() => controller.current!.renderProduction()));
    }, [view.busy, view.hasControl, view.run?.status, view.state.media]);

    const insertAssets = async (payloads: InsertAssetPayload[]) => {
        let next = { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track })), clips: [...timeline.clips] };
        let cursor = Math.max(0, ...next.clips.filter((clip) => ["video", "image"].includes(clip.kind)).map((clip) => clip.startMs + clip.durationMs));
        for (const payload of payloads) {
            if (!["video", "audio", "image"].includes(payload.kind)) throw new Error("请选用视频、图片、配音或音乐素材");
            const media = payload as Extract<InsertAssetPayload, { kind: "video" | "audio" | "image" }>;
            const id = crypto.randomUUID();
            const duration = "durationMs" in media ? media.durationMs || 4000 : 4000;
            const audio = media.kind === "audio";
            next.clips.push({
                id,
                kind: media.kind,
                nodeId: id,
                trackId: audio ? "sound" : "picture",
                title: media.title,
                startMs: audio ? 0 : cursor,
                durationMs: duration,
                sourceStartMs: 0,
                sourceDurationMs: media.kind === "image" ? undefined : duration,
                volume: audio ? 0.25 : 1,
                fadeInMs: audio ? 300 : 0,
                fadeOutMs: audio ? 500 : 0,
                directMedia: { ...media, id, title: media.title },
            });
            if (!audio) cursor += duration;
        }
        next.durationMs = Math.max(cursor, ...next.clips.map((clip) => clip.startMs + clip.durationMs));
        await saveTimeline(next);
    };
    const updateClip = (id: string, patch: Partial<TimelineClip>) => {
        const clips = timeline.clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip));
        invoke(saveTimeline({ ...timeline, clips, durationMs: Math.max(0, ...clips.map((clip) => clip.startMs + clip.durationMs)) }));
    };
    const result = view.state.production?.result;
    useEffect(() => {
        let live = true;
        setResultUrl("");
        if (result?.resourceId)
            void cacheResourceObjectUrl(`resource:${result.resourceId}`)
                .then((url) => {
                    if (live) {
                        if (url) setResultUrl(url);
                        else setError("成片资源暂时无法读取，请在任务中心核对");
                    }
                })
                .catch(() => {
                    if (live) setError("成片资源读取失败");
                });
        return () => {
            live = false;
        };
    }, [result?.resourceId, userId]);
    const statusText = view.busy
        ? "正在制作"
        : result
          ? "成片可下载"
          : view.run?.status === "waiting_proposal"
            ? "方案待确认"
            : view.run?.status === "waiting_answer"
              ? "待补充需求"
              : view.run?.status === "completed"
                ? "镜头已就绪"
                : view.run
                  ? "已保存"
                  : "开始一个作品";
    const step = result ? 4 : view.state.production?.renderKey ? 3 : timeline.clips.length ? 2 : view.state.canvasApplied ? 1 : 0;
    return (
        <WorkspacePage className="production-page">
            <PageHeader
                title="自动制作"
                description="从一个想法到一段成片。逐镜检查，也可以从已有素材开始。"
                meta={<Tag>{statusText}</Tag>}
                actions={
                    <>
                        <Link to="/tasks">
                            <Button>任务中心</Button>
                        </Link>
                        <Button disabled={view.busy} onClick={() => setParams({})}>
                            新作品
                        </Button>
                    </>
                }
            />
            <div className="production-toolbar">
                <Select
                    aria-label="制作历史"
                    placeholder="接续已有作品"
                    value={runId}
                    onChange={(id) => setParams({ run: id })}
                    disabled={view.busy}
                    options={runs.map((run) => ({ value: run.id, label: String((run.state.proposal as { title?: string })?.title || "素材剪辑") }))}
                />
                <Steps size="small" current={step} items={[{ title: view.state.proposal ? "创意方案" : "已有素材" }, { title: view.state.proposal ? "逐镜制作" : "素材就绪" }, { title: "声音与剪辑" }, { title: "成片检查" }, { title: "导出" }]} />
            </div>
            {(error || view.error) && <Alert type="error" showIcon title={error || view.error} closable onClose={() => setError("")} />}
            <details className="production-tools">
                <summary>
                    制作工具 · {productionTools.filter((tool) => tool.executable).length} 项可执行 / {productionTools.length} 项已登记
                </summary>
                <p className="production-note">导演根据真实参数选择工具；确认方案后按镜头提交，产物回到当前作品。目录中的其他模型需先接入并验证。</p>
                <div className="production-tool-list">
                    {productionTools.map((tool) => (
                        <div key={`${tool.mode}:${tool.model}`} className="production-tool-item">
                            <div>
                                <Tag>{tool.source === "comfyui" ? "DGX / ComfyUI" : tool.source === "runninghub" ? "RunningHub" : "系统模型"}</Tag>
                                <strong>{tool.name}</strong>
                                <Tag color={tool.executable ? "success" : "default"}>{tool.executable ? "可执行" : "待配置"}</Tag>
                            </div>
                            <p>{tool.reason || (tool.mode === "video" ? "视频制作" : "图片制作")}</p>
                        </div>
                    ))}
                    {!productionTools.length && <p>尚无已登记的制作工具，请先设置模型或保存 RunningHub 工作流。</p>}
                </div>
                <div className="production-tool-links">
                    <Link to="/settings?section=channels&catalogSource=rh.standard">工具与模型目录</Link>
                    <Link to="/settings?section=runninghub">RunningHub 连接设置</Link>
                    <Link to="/plugins">RunningHub 工作流插件</Link>
                </div>
                {!config.runningHub.workflows.length && <p className="production-note">RunningHub 尚无已保存工作流。打开连接设置，读取并保存可用的 Workflow / App 后，导演即可按用途选择。</p>}
            </details>
            {!view.run ? (
                <section className="production-start">
                    <Clapperboard size={32} />
                    <h2>制作你的下一个作品</h2>
                    <p>使用现有项目与素材，保留每一镜的制作记录。</p>
                    <Select
                        style={{ width: "min(100%, 360px)" }}
                        aria-label="接续项目"
                        allowClear
                        placeholder="可选：沿用现有项目"
                        value={projectId}
                        disabled={view.busy}
                        options={projects.map((project) => ({ value: project.id, label: project.title }))}
                        onChange={setProjectId}
                    />
                    <Button type="primary" onClick={() => invoke(start())}>
                        新建制作记录
                    </Button>
                </section>
            ) : (
                <div className="production-workbench">
                    <section className="production-brief">
                        <h2>创意与镜头</h2>
                        {(!view.state.proposal || view.state.modificationRequested) && (
                            <>
                                <p className="production-note">新方案会保存到关联画布，镜头使用当前配置的模型。</p>
                                <Select
                                    aria-label="导演模型"
                                    value={model || undefined}
                                    placeholder="选择导演模型"
                                    disabled={disabled}
                                    onChange={setModel}
                                    options={selectableModelsByCapability(config, "text").map((value) => ({ value, label: modelDisplayName(config, value) }))}
                                />
                                <Input.TextArea
                                    aria-label="作品要求"
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    placeholder="描述故事、时长、人物与画面风格，或说明需要沿用的素材"
                                    autoSize={{ minRows: 4, maxRows: 10 }}
                                    disabled={disabled}
                                />
                                <Button
                                    type="primary"
                                    disabled={disabled || !prompt.trim() || !model}
                                    onClick={() => invoke(controller.current!.configure({ scene: "short-film", references: view.state.references, selectedSkillIds: [], textModel: model }).then(() => controller.current!.send(prompt)))}
                                >
                                    规划作品
                                </Button>
                                {!model && <Link to="/settings?section=channels">配置可用模型</Link>}
                            </>
                        )}
                        {view.state.questions?.status === "pending" && (
                            <CreativeQuestionCard
                                request={view.state.questions}
                                answers={answers}
                                onAnswersChange={setAnswers}
                                onSubmit={(value) => controller.current!.answer(value)}
                                assets={view.state.references.map((item) => ({ id: item.id, label: item.title }))}
                                disabled={disabled}
                            />
                        )}
                        {view.state.proposal && (
                            <CreativeProposalCard
                                proposal={view.state.proposal}
                                disabled={disabled || view.run.status !== "waiting_proposal"}
                                archived={view.state.canvasApplied}
                                onApprove={() => invoke(controller.current!.approveProposal())}
                                onModify={() => invoke(controller.current!.requestModification())}
                                onRedirect={() => invoke(controller.current!.requestModification())}
                            />
                        )}
                        <div className="production-shot-list">
                            {view.state.media.map((media, index) => (
                                <article key={media.ref}>
                                    <span className="production-shot-number">{String(index + 1).padStart(2, "0")}</span>
                                    <div>
                                        <strong>{view.state.proposal?.workflow.nodes.find((node) => node.ref === media.ref)?.title || "镜头"}</strong>
                                        <p>{media.status === "ready" ? "产物已保存" : media.status === "running" || media.status === "queued" ? "制作中" : media.error || "等待制作"}</p>
                                    </div>
                                    <Button size="small" disabled={disabled || ["queued", "running"].includes(media.status)} onClick={() => invoke(controller.current!.redo(media.ref))}>
                                        重做此镜
                                    </Button>
                                </article>
                            ))}
                        </div>
                        <div className="production-actions">
                            <Button disabled={view.busy} icon={<RotateCcw size={14} />} onClick={() => invoke(controller.current!.resume())}>
                                继续制作
                            </Button>
                            <Button disabled={view.busy} onClick={() => invoke(controller.current!.pause())}>
                                暂停
                            </Button>
                            {view.run.canvasId && (
                                <Link to={`/canvas/${view.run.canvasId}`}>
                                    <Button>打开导演台</Button>
                                </Link>
                            )}
                        </div>
                    </section>
                    <section className="production-edit">
                        <div className="production-section-heading">
                            <h2>声音与剪辑</h2>
                            <Button disabled={disabled} icon={<Library size={14} />} onClick={() => setPicker(true)}>
                                加入已有素材
                            </Button>
                        </div>
                        <CanvasTimelinePreview
                            clips={timeline.clips}
                            tracks={timeline.tracks}
                            nodes={adapter.current?.read().nodes || []}
                            playheadMs={time}
                            onPlayheadChange={setTime}
                            durationMs={timeline.durationMs}
                            playing={playing}
                            onPlayingChange={setPlaying}
                            onTogglePlay={() => {
                                if (!playing && time >= timeline.durationMs) setTime(0);
                                setPlaying(!playing);
                            }}
                            theme={canvasThemes[theme]}
                        />
                        <input className="production-scrubber" aria-label="预览位置" type="range" min={0} max={timeline.durationMs} value={Math.min(time, timeline.durationMs)} onChange={(event) => setTime(Number(event.target.value))} />
                        <div className="production-actions">
                            <Button disabled={disabled || !view.run.canvasId} icon={<Film size={14} />} onClick={() => invoke(assemble())}>
                                从项目编排镜头
                            </Button>
                            <span className="production-note">
                                {(timeline.durationMs / 1000).toFixed(2)} 秒 · {timeline.clips.length} 个片段
                            </span>
                        </div>
                        {timeline.clips.length ? (
                            <div className="production-clips">
                                {timeline.clips.map((clip) => (
                                    <article key={clip.id}>
                                        <strong>
                                            {clip.title || "片段"}
                                            <small>{clip.kind === "audio" ? "声音" : clip.kind === "subtitle" ? "字幕" : "画面"}</small>
                                        </strong>
                                        <label>
                                            起点（秒）
                                            <InputNumber
                                                aria-label={`${clip.title} 起点`}
                                                min={0}
                                                step={0.1}
                                                value={clip.startMs / 1000}
                                                disabled={disabled}
                                                onChange={(value) => value !== null && updateClip(clip.id, { startMs: Math.round(value * 1000) })}
                                            />
                                        </label>
                                        <label>
                                            时长（秒）
                                            <InputNumber
                                                aria-label={`${clip.title} 时长`}
                                                min={0.1}
                                                step={0.1}
                                                value={clip.durationMs / 1000}
                                                disabled={disabled}
                                                onChange={(value) => value !== null && updateClip(clip.id, { durationMs: Math.round(value * 1000) })}
                                            />
                                        </label>
                                        <label>
                                            源内起点（秒）
                                            <InputNumber
                                                aria-label={`${clip.title} 裁剪`}
                                                min={0}
                                                step={0.1}
                                                value={(clip.sourceStartMs || 0) / 1000}
                                                disabled={disabled || clip.kind === "image" || clip.kind === "subtitle"}
                                                onChange={(value) => value !== null && updateClip(clip.id, { sourceStartMs: Math.round(value * 1000) })}
                                            />
                                        </label>
                                        <label>
                                            音量
                                            <InputNumber
                                                aria-label={`${clip.title} 音量`}
                                                min={0}
                                                max={1}
                                                step={0.05}
                                                value={clip.volume ?? 1}
                                                disabled={disabled || !["audio", "video"].includes(clip.kind)}
                                                onChange={(value) => value !== null && updateClip(clip.id, { volume: value })}
                                            />
                                        </label>
                                        <Button size="small" disabled={disabled} onClick={() => invoke(saveTimeline({ ...timeline, clips: timeline.clips.filter((item) => item.id !== clip.id) }))}>
                                            移除
                                        </Button>
                                    </article>
                                ))}
                            </div>
                        ) : (
                            <p className="production-note production-empty">完成镜头制作，或从素材库加入视频与配音。</p>
                        )}
                        <div className="production-qc">
                            <h3>成片检查</h3>
                            {checks.length ? (
                                <ul>
                                    {checks.map((issue) => (
                                        <li key={issue}>{issue}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p>时间线检查通过。导出后继续核验实际封装、画面、音轨与时长。</p>
                            )}
                            <p className="production-note">导出为 1920×1080 MP4。字幕另附 SRT；人物连续性与混音听感需预览检查。</p>
                            <Button type="primary" disabled={disabled || checks.length > 0} loading={view.busy && Boolean(view.state.production?.renderKey)} onClick={() => invoke(controller.current!.renderProduction())}>
                                {view.state.production?.renderKey && !result ? "恢复并核对导出" : "一键生成成片"}
                            </Button>
                            {view.state.production?.renderTaskId && !result && (
                                <Button disabled={disabled} onClick={() => invoke(controller.current!.resetFailedProductionRender())}>
                                    核对失败后重新编辑
                                </Button>
                            )}
                        </div>
                        {result && (
                            <div className="production-result">
                                <h3>成片已保存</h3>
                                <video controls src={resultUrl || undefined} />
                                {resultUrl && (
                                    <a href={resultUrl} download={result.fileName || "production.mp4"}>
                                        下载 MP4
                                    </a>
                                )}
                                {result.subtitleSrt && (
                                    <Button
                                        onClick={() => {
                                            const url = URL.createObjectURL(new Blob([result.subtitleSrt!], { type: "text/plain;charset=utf-8" }));
                                            const a = document.createElement("a");
                                            a.href = url;
                                            a.download = "production.srt";
                                            a.click();
                                            setTimeout(() => URL.revokeObjectURL(url), 1000);
                                        }}
                                    >
                                        下载字幕
                                    </Button>
                                )}
                                <p>{(result.durationMs! / 1000).toFixed(2)} 秒 · 已通过实际媒体检查</p>
                            </div>
                        )}
                        {!!view.state.production?.exports?.length && (
                            <details>
                                <summary>历史成片（{view.state.production.exports.length}）</summary>
                                {view.state.production.exports.map((item, index) => (
                                    <p key={item.taskId}>
                                        <Button type="link" onClick={() => invoke(downloadSavedExport(item.result.resourceId, item.result.fileName))}>
                                            下载成片 {index + 1}
                                        </Button>
                                    </p>
                                ))}
                            </details>
                        )}
                    </section>
                </div>
            )}
            <AssetPickerModal backendLibrary open={picker} onClose={() => setPicker(false)} onInsert={insertAssets} />
        </WorkspacePage>
    );
}

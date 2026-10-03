import { Alert, Button, Input, Select as AppSelect, Tag } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { requiresBackendLocalResourceStore } from "@/services/workspace-resource-storage";
import { archiveLocalComfyJob, createLocalComfyJob, createLocalComfyProject, createLocalComfyShot, getLocalComfyConfig, listLocalComfyAssets, listLocalComfyJobs, listLocalComfyProjects, listLocalComfyRecipes, listLocalComfyShots, localComfyAssetContentUrl, pollLocalComfyJob, retryLocalComfyJob, saveLocalComfyScript, uploadLocalComfyReference, type LocalComfyAsset, type LocalComfyConfig, type LocalComfyJob, type LocalComfyProject, type LocalComfyRecipe, type LocalComfyShot } from "@/services/api/local-comfy";
import { bindLocalComfyResult } from "./bind-result";
import { localComfyJobActive, localComfyJobRetryable, localComfyReferenceProblem, localComfySeed, localComfyStatusLabel, type LocalComfyCanvasContext } from "./context";

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求未完成，请刷新记录后重试";
const requestKey = () => crypto.randomUUID();

async function fileBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("参考图读取失败，请重新选择"));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
        reader.readAsDataURL(file);
    });
}

export default function LocalComfyPage() {
    const [params] = useSearchParams();
    const location = useLocation();
    const entry = (location.state || {}) as Partial<LocalComfyCanvasContext>;
    const canvasProjects = useCanvasStore((state) => state.projects);
    const context: LocalComfyCanvasContext = { projectId: params.get("projectId") || "", nodeId: params.get("nodeId") || undefined, shotId: params.get("shotId") || undefined, referenceAssetIds: entry.referenceAssetIds || [] };
    const canvasProject = canvasProjects.find((project) => project.id === context.projectId);
    const sourceNode = canvasProject?.nodes.find((node) => node.id === context.nodeId);
    const [config, setConfig] = useState<LocalComfyConfig | null>(null);
    const [recipes, setRecipes] = useState<LocalComfyRecipe[]>([]);
    const [projects, setProjects] = useState<LocalComfyProject[]>([]);
    const [projectId, setProjectId] = useState("");
    const [shots, setShots] = useState<LocalComfyShot[]>([]);
    const [shotId, setShotId] = useState("");
    const [assets, setAssets] = useState<LocalComfyAsset[]>([]);
    const [jobs, setJobs] = useState<LocalComfyJob[]>([]);
    const [recipeId, setRecipeId] = useState("");
    const [prompt, setPrompt] = useState(entry.prompt || sourceNode?.metadata?.composerContent || sourceNode?.metadata?.prompt || "");
    const [seed, setSeed] = useState("0");
    const [references, setReferences] = useState<string[]>([]);
    const [script, setScript] = useState("");
    const [projectName, setProjectName] = useState(canvasProject?.title || "");
    const [shotName, setShotName] = useState(sourceNode?.title || "");
    const [referenceKind, setReferenceKind] = useState<"character" | "scene" | "prop" | "reference">("reference");
    const [upstreamAssetId, setUpstreamAssetId] = useState(context.referenceAssetIds?.[0] || "");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [loading, setLoading] = useState(true);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [visibleJobs, setVisibleJobs] = useState(20);
    const [boundAssets, setBoundAssets] = useState<Record<string, string>>({});
    const actionController = useRef<AbortController | null>(null);
    const submitIdentity = useRef<{ fingerprint: string; key: string } | null>(null);
    const retryIdentities = useRef(new Map<string, { fingerprint: string; key: string }>());
    const selectedProject = projects.find((project) => project.id === projectId);
    const selectedShot = shots.find((shot) => shot.id === shotId);
    const recipe = recipes.find((item) => item.id === recipeId);
    const resultAssets = assets.filter((asset) => asset.kind === "result");
    const referenceAssets = assets.filter((asset) => asset.kind !== "result");
    const referenceProblem = localComfyReferenceProblem(recipe?.reference_constraints, references.map((id) => assets.find((asset) => asset.id === id)));
    const jobHistory = useMemo(() => [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at)), [jobs]);
    const matchesCanvas = Boolean(canvasProject && sourceNode && selectedProject?.upstream_project_id === context.projectId && selectedShot?.upstream_shot_id === (context.shotId || context.nodeId));

    const upsertJob = (job: LocalComfyJob) => setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    async function runAction(label: string, operation: (signal: AbortSignal) => Promise<void>) {
        if (actionController.current) return;
        const controller = new AbortController();
        actionController.current = controller;
        setBusy(label); setError(""); setNotice("");
        try { await operation(controller.signal); }
        catch (failure) { if (isAbort(failure)) setNotice("已停止等待当前请求。已提交的任务继续运行，请刷新记录核验结果。"); else setError(errorText(failure)); }
        finally { if (actionController.current === controller) { actionController.current = null; setBusy(""); } }
    }

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        document.title = "本地生成 · BeefTV";
        Promise.all([getLocalComfyConfig(controller.signal), listLocalComfyRecipes(controller.signal), listLocalComfyProjects(controller.signal)])
            .then(([nextConfig, nextRecipes, nextProjects]) => {
                setConfig(nextConfig); setRecipes(nextRecipes); setProjects(nextProjects);
                setRecipeId(nextRecipes.find((item) => item.ready)?.id || "");
                setProjectId(nextProjects.find((project) => context.projectId && project.upstream_project_id === context.projectId)?.id || nextProjects[0]?.id || "");
            }).catch((failure) => { if (!isAbort(failure)) setError(errorText(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => { controller.abort(); actionController.current?.abort(); };
    }, [context.projectId]);

    useEffect(() => {
        setShots([]); setAssets([]); setJobs([]); setShotId(""); setReferences([]); setVisibleJobs(20);
        setScript(selectedProject?.script || "");
        if (!projectId) return;
        const controller = new AbortController();
        Promise.all([listLocalComfyShots(projectId, controller.signal), listLocalComfyAssets(projectId, controller.signal)])
            .then(([nextShots, nextAssets]) => {
                setShots(nextShots); setAssets(nextAssets);
                const match = nextShots.find((shot) => shot.upstream_shot_id === (context.shotId || context.nodeId)) || nextShots[0];
                setShotId(match?.id || ""); setReferences(match?.reference_asset_ids || []);
            }).catch((failure) => { if (!isAbort(failure)) setError(errorText(failure)); });
        return () => controller.abort();
    }, [projectId]);

    useEffect(() => {
        if (!projectId) return;
        const controller = new AbortController();
        listLocalComfyJobs(projectId, shotId || undefined, controller.signal).then(setJobs).catch((failure) => { if (!isAbort(failure)) setError(errorText(failure)); });
        return () => controller.abort();
    }, [projectId, shotId]);

    useEffect(() => {
        const active = jobs.filter((job) => localComfyJobActive(job.status));
        if (!autoRefresh || busy || !active.length) return;
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            Promise.all(active.map((job) => pollLocalComfyJob(job.id, controller.signal)))
                .then((updated) => setJobs((current) => current.map((job) => updated.find((item) => item.id === job.id) || job)))
                .catch((failure) => { if (!isAbort(failure)) { setAutoRefresh(false); setError(`${errorText(failure)}；已暂停自动刷新，可手动刷新记录。`); } });
        }, 5_000);
        return () => { window.clearTimeout(timer); controller.abort(); };
    }, [jobs, autoRefresh, busy]);

    const selectShot = (id: string) => { setShotId(id); setReferences(shots.find((shot) => shot.id === id)?.reference_asset_ids || []); };
    const refresh = () => runAction("读取记录", async (signal) => {
        const [nextConfig, nextRecipes, nextProjects, nextJobs, nextAssets] = await Promise.all([getLocalComfyConfig(signal), listLocalComfyRecipes(signal), listLocalComfyProjects(signal), projectId ? listLocalComfyJobs(projectId, shotId || undefined, signal) : Promise.resolve([]), projectId ? listLocalComfyAssets(projectId, signal) : Promise.resolve([])]);
        setConfig(nextConfig); setRecipes(nextRecipes); setProjects(nextProjects); setJobs(nextJobs); setAssets(nextAssets); setNotice("记录已刷新");
        if (!recipeId) setRecipeId(nextRecipes.find((item) => item.ready)?.id || "");
        if (!projectId) setProjectId(nextProjects.find((project) => context.projectId && project.upstream_project_id === context.projectId)?.id || nextProjects[0]?.id || "");
    });
    const submit = () => runAction("提交任务", async (signal) => {
        if (!config?.generation_enabled) throw new Error("当前真实生成未启用，无法提交 GPU 任务");
        if (!projectId || !shotId || !recipe?.ready || !prompt.trim()) throw new Error("请选择项目、镜头和可用配方，并填写提示词");
        if (references.length !== recipe.reference_slots) throw new Error(`这个配方需要 ${recipe.reference_slots} 张参考图，请按顺序选择`);
        if (referenceProblem) throw new Error(referenceProblem);
        const parsedSeed = localComfySeed(seed);
        const input = { project_id: projectId, shot_id: shotId, recipe_id: recipeId, prompt: prompt.trim(), seed: parsedSeed, reference_asset_ids: references };
        const fingerprint = JSON.stringify(input);
        if (submitIdentity.current?.fingerprint !== fingerprint) submitIdentity.current = { fingerprint, key: requestKey() };
        const job = await createLocalComfyJob({ ...input, request_key: submitIdentity.current!.key }, signal);
        upsertJob(job); setNotice(job.deduplicated ? "已返回同一请求的任务记录，没有重复提交" : "任务已登记，按任务状态核验生成结果");
    });
    const redo = (job: LocalComfyJob) => runAction("重做镜头", async (signal) => {
        if (!config?.generation_enabled || !localComfyJobRetryable(job.status)) throw new Error("当前状态不能重做；提交结果待核验时请先核验原任务");
        const parsedSeed = localComfySeed(seed);
        const fingerprint = JSON.stringify({ prompt: prompt.trim() || job.prompt, seed: parsedSeed });
        if (retryIdentities.current.get(job.id)?.fingerprint !== fingerprint) retryIdentities.current.set(job.id, { fingerprint, key: requestKey() });
        const next = await retryLocalComfyJob(job.id, { request_key: retryIdentities.current.get(job.id)!.key, prompt: prompt.trim() || job.prompt, seed: parsedSeed }, signal);
        upsertJob(next); setNotice("已登记单镜重做，原版本与记录保留");
    });
    const archive = (job: LocalComfyJob) => runAction("归档结果", async (signal) => {
        const next = await archiveLocalComfyJob(job.id, signal);
        upsertJob(next); setAssets(await listLocalComfyAssets(projectId, signal)); setNotice("结果已写入本地生成归档；尚未自动关联原画布");
    });
    const upload = (file?: File) => {
        if (!file) return;
        void runAction("上传参考图", async (signal) => {
            if (!projectId || !config) throw new Error("请先登记或选择本地生成项目");
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("参考图需为 PNG、JPEG 或 WebP");
            if (file.size > config.max_reference_bytes) throw new Error(`参考图需小于 ${Math.floor(config.max_reference_bytes / 1024 / 1024)} MB`);
            const asset = await uploadLocalComfyReference({ project_id: projectId, name: file.name, kind: referenceKind, mime_type: file.type, data_base64: await fileBase64(file), upstream_asset_id: upstreamAssetId || undefined }, signal);
            setAssets((current) => [asset, ...current]); setReferences((current) => [...current, asset.id]); setNotice("参考图已保存到本地生成项目，原素材保持原位置");
        });
    };

    return <WorkspacePage><PageHeader title="本地生成" description="在本机工作区编排镜头，用已配置的 ComfyUI 配方生成并保留结果记录。" meta={<Tag>独立本地项目</Tag>} actions={<><Link to={context.projectId ? `/canvas/${encodeURIComponent(context.projectId)}` : "/canvas"}>返回画布</Link><Button onClick={() => void refresh()} disabled={Boolean(busy)} loading={busy === "读取记录"}>刷新记录</Button></>} />
        <div className="mt-3 space-y-3" aria-live="polite">
            {loading ? <Alert type="info" title="正在读取本地生成配置" /> : null}
            {!loading && config && !config.generation_enabled ? <Alert type="warning" title="真实生成尚未启用" description="可登记镜头和参考图、查看归档；生成与重做暂不可用。不会提交 GPU 任务。" /> : null}
            {error ? <Alert type="error" title={error} showIcon /> : null}
            {notice ? <Alert type="info" title={notice} showIcon /> : null}
            {busy ? <div className="flex items-center gap-3 text-sm"><span>{busy}…</span><Button size="small" onClick={() => actionController.current?.abort()}>停止等待</Button></div> : null}
        </div>
        <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]">
            <section className="min-w-0 space-y-4 rounded-lg bg-surface p-4" aria-label="镜头生成设置">
                <h2 className="text-base font-semibold">项目与镜头</h2>
                <p className="text-xs leading-5 text-foreground/65">这里的项目、剧本与参考图存于独立本地生成库。原 BeefTV 剧本和角色、场景、道具库仍在原工作区；归档后可显式关联画布。</p>
                <p className="text-xs leading-5 text-foreground/65">画布素材保存位置：{requiresBackendLocalResourceStore() ? "部署后端资源库；关联成功后，镜头快照也保存到后端。" : "当前浏览器的本地素材库（桌面版由本机资源服务保存）。"}</p>
                <label className="block space-y-1.5" htmlFor="local-comfy-project"><span className="text-sm">本地生成项目</span><AppSelect id="local-comfy-project" className="w-full" value={projectId || undefined} placeholder="选择项目" options={projects.map((project) => ({ value: project.id, label: project.name }))} onChange={setProjectId} disabled={Boolean(busy)} /></label>
                <div className="flex flex-wrap items-end gap-2"><label className="min-w-40 flex-1 space-y-1.5" htmlFor="local-comfy-project-name"><span className="text-sm">项目名称</span><Input id="local-comfy-project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><Button disabled={!projectName.trim() || Boolean(busy)} onClick={() => void runAction("登记项目", async (signal) => { const project = await createLocalComfyProject({ name: projectName.trim(), upstream_project_id: context.projectId || undefined }, signal); setProjects((current) => [project, ...current]); setProjectId(project.id); setNotice(context.projectId ? "已登记项目，并记录原画布 ID" : "已登记独立本地生成项目"); })}>登记项目</Button></div>
                {selectedProject ? <p className="break-all text-xs text-foreground/65">原画布关联：{selectedProject.upstream_project_id || "未关联"}；存储：独立本地生成库</p> : null}
                <label className="block space-y-1.5" htmlFor="local-comfy-shot"><span className="text-sm">镜头</span><AppSelect id="local-comfy-shot" className="w-full" value={shotId || undefined} placeholder="选择镜头" options={shots.map((shot) => ({ value: shot.id, label: shot.name }))} onChange={selectShot} disabled={Boolean(busy)} /></label>
                <div className="flex flex-wrap items-end gap-2"><label className="min-w-40 flex-1 space-y-1.5" htmlFor="local-comfy-shot-name"><span className="text-sm">镜头名称</span><Input id="local-comfy-shot-name" value={shotName} onChange={(event) => setShotName(event.target.value)} /></label><Button disabled={!projectId || !shotName.trim() || Boolean(busy)} onClick={() => void runAction("登记镜头", async (signal) => { const shot = await createLocalComfyShot({ project_id: projectId, name: shotName.trim(), upstream_shot_id: context.shotId || context.nodeId, reference_asset_ids: references }, signal); setShots((current) => [shot, ...current]); setShotId(shot.id); setNotice("镜头已登记，原导演台编排未改动"); })}>登记镜头</Button></div>
                <label className="block space-y-1.5" htmlFor="local-comfy-recipe"><span className="text-sm">生成配方</span><AppSelect id="local-comfy-recipe" className="w-full" value={recipeId || undefined} options={recipes.map((item) => ({ value: item.id, label: `${item.name}${item.ready ? "" : "（未配置）"}`, disabled: !item.ready }))} onChange={setRecipeId} disabled={Boolean(busy)} /></label>
                {recipe ? <p className="text-xs text-foreground/65">需要 {recipe.reference_slots} 张有序参考图；配方已配置不代表模型或 GPU 已验收。</p> : null}
                {recipe?.reference_constraints?.map((constraint, index) => <p key={`${constraint.role}-${index}`} className="text-xs leading-5 text-foreground/65">{constraint.role === "first_frame" ? "场景首帧" : `参考图 ${index + 1}`}需 PNG，画幅比例与 {constraint.width} × {constraint.height} 相同，尺寸不小于此值。人物身份图应先用于生成场景首帧，不能直接拉伸成横版。</p>)}
                <label className="block space-y-1.5" htmlFor="local-comfy-prompt"><span className="text-sm">镜头提示词</span><Input.TextArea id="local-comfy-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 5, maxRows: 14 }} style={{ resize: "none" }} /></label>
                <label className="block space-y-1.5" htmlFor="local-comfy-seed"><span className="text-sm">种子（0–4294967295）</span><Input id="local-comfy-seed" value={seed} inputMode="numeric" onChange={(event) => setSeed(event.target.value)} /></label>
                <label className="block space-y-1.5" htmlFor="local-comfy-references"><span className="text-sm">参考图（选择顺序即配方输入顺序）</span><AppSelect id="local-comfy-references" mode="multiple" className="w-full" value={references} options={referenceAssets.map((asset) => ({ value: asset.id, label: `${asset.name}${asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""} · ${asset.kind}` }))} onChange={setReferences} disabled={Boolean(busy)} aria-invalid={Boolean(referenceProblem)} aria-describedby={referenceProblem ? "local-comfy-reference-error" : undefined} /></label>
                {referenceProblem ? <p id="local-comfy-reference-error" className="text-xs text-foreground/65" role="status">{referenceProblem}</p> : null}
                <div className="grid gap-2 sm:grid-cols-2"><label className="block space-y-1.5" htmlFor="local-comfy-reference-kind"><span className="text-sm">参考图类型</span><AppSelect id="local-comfy-reference-kind" className="w-full" value={referenceKind} options={[{ value: "reference", label: "参考图" }, { value: "character", label: "角色" }, { value: "scene", label: "场景" }, { value: "prop", label: "道具" }]} onChange={setReferenceKind} /></label><label className="block space-y-1.5" htmlFor="local-comfy-reference-asset"><span className="text-sm">原素材 ID（可选）</span><Input id="local-comfy-reference-asset" value={upstreamAssetId} onChange={(event) => setUpstreamAssetId(event.target.value)} /></label></div>
                <label className="block space-y-1.5" htmlFor="local-comfy-file"><span className="text-sm">从本机选取参考图</span><input id="local-comfy-file" type="file" accept={recipe?.reference_constraints?.length ? "image/png" : "image/png,image/jpeg,image/webp"} disabled={Boolean(busy) || !projectId} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; upload(file); }} className="block w-full text-sm" /></label>
                <Button type="primary" className="min-w-32" disabled={!config?.generation_enabled || !recipe?.ready || !projectId || !shotId || !prompt.trim() || Boolean(busy) || references.length !== recipe?.reference_slots || Boolean(referenceProblem)} loading={busy === "提交任务"} onClick={() => void submit()}>生成当前镜头</Button>
                <details><summary className="cursor-pointer text-sm">项目剧本副本</summary><label htmlFor="local-comfy-script" className="mt-3 block space-y-1.5"><span className="text-xs text-foreground/65">保存到本地生成项目，原剧本编辑器内容不会被覆盖。</span><Input.TextArea id="local-comfy-script" value={script} onChange={(event) => setScript(event.target.value)} autoSize={{ minRows: 5, maxRows: 16 }} style={{ resize: "none" }} /></label><Button className="mt-2" disabled={!projectId || Boolean(busy)} onClick={() => void runAction("保存剧本副本", async (signal) => { const next = await saveLocalComfyScript(projectId, script, signal); setProjects((current) => current.map((project) => project.id === next.id ? next : project)); setNotice("剧本副本已保存到本地生成项目"); })}>保存剧本副本</Button></details>
            </section>
            <section className="min-w-0 space-y-3" aria-label="生成任务与结果"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">镜头记录</h2><Button size="small" onClick={() => setAutoRefresh((current) => !current)}>{autoRefresh ? "暂停自动刷新" : "恢复自动刷新"}</Button></div><p className="text-xs leading-5 text-foreground/65">停止刷新不会取消 GPU 任务。提交结果待核验时，请核验原记录；界面不会重新提交。</p>
                {!jobHistory.length ? <div className="rounded-lg bg-surface p-6 text-sm text-foreground/65">{projectId ? "当前镜头还没有生成记录。登记镜头并选择配方后可准备生成。" : "先选择本地生成项目查看记录。"}</div> : null}
                {jobHistory.slice(0, visibleJobs).map((job) => <article key={job.id} className="space-y-3 rounded-lg bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">第 {job.attempt} 次生成</span><Tag color={job.status === "failed" ? "error" : job.status === "completed" ? "success" : "default"}>{localComfyStatusLabel[job.status] || job.status}</Tag></div><p className="break-all font-mono text-xs text-foreground/65">任务 {job.id} · 种子 {job.seed}</p><p className="text-xs text-foreground/65">{new Date(job.created_at).toLocaleString("zh-CN", { timeZone: "UTC" })} UTC · {job.archived_asset_ids.length ? "已归档" : "未归档"}</p>{job.error ? <Alert type="error" title={job.error} /> : null}{job.status === "submission_unknown" ? <Alert type="warning" title="提交结果待核验" description="网络中断可能发生在服务接收后。请先核验该任务，避免重复生成。" /> : null}<div className="flex flex-wrap gap-2"><Button size="small" disabled={Boolean(busy) || !localComfyJobActive(job.status)} onClick={() => void runAction("核验任务", async (signal) => upsertJob(await pollLocalComfyJob(job.id, signal)))}>核验状态</Button><Button size="small" disabled={Boolean(busy) || job.status !== "completed"} onClick={() => void archive(job)}>归档结果</Button><Button size="small" disabled={Boolean(busy) || !config?.generation_enabled || !localComfyJobRetryable(job.status)} onClick={() => void redo(job)}>重做这一镜</Button></div>
                    {job.archived_asset_ids.map((id) => { const asset = resultAssets.find((item) => item.id === id); return asset ? <div key={id} className="space-y-2 border-t border-foreground/10 pt-3">{asset.mime_type.startsWith("video/") ? <video src={localComfyAssetContentUrl(id)} controls preload="metadata" className="aspect-video w-full rounded-md object-contain" aria-label={asset.name} /> : <img src={localComfyAssetContentUrl(id)} alt={asset.name} loading="lazy" className="aspect-video w-full rounded-md object-contain" />}<div className="flex flex-wrap items-center gap-3"><a className="text-sm underline" href={localComfyAssetContentUrl(id)} download={asset.name}>下载结果</a><Button size="small" disabled={Boolean(busy) || !matchesCanvas || Boolean(boundAssets[id])} onClick={() => void runAction("关联原画布", async (signal) => { const linkedId = await bindLocalComfyResult(context, job, asset, signal); setBoundAssets((current) => ({ ...current, [id]: linkedId })); setNotice("结果已关联到原画布素材与镜头，原镜头编排保留"); })}>{boundAssets[id] ? "已关联原画布" : "关联原画布镜头"}</Button></div>{!matchesCanvas ? <p className="text-xs text-foreground/65">从原画布镜头打开，并选择与它关联的本地项目和镜头后，可关联结果。</p> : null}</div> : <p key={id} className="text-xs text-foreground/65">归档资产 {id}；刷新记录后可预览。</p>; })}
                </article>)}
                {jobHistory.length > visibleJobs ? <Button onClick={() => setVisibleJobs((count) => count + 20)}>再显示 20 条</Button> : null}
            </section>
        </div>
    </WorkspacePage>;
}

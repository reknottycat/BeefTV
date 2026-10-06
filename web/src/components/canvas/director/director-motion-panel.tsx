import { App, Button, Input, InputNumber, Select } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DirectorScene, DirectorShot } from "@/types/director";
import { MOTION_PATTERN_IDS, type DirectorDirection, type MotionPatternId } from "@/types/director-motion";
import { createDirectorDirection, directorMotionTiming, MOTION_PATTERN_LABELS, retimeDirectorDirection, validateDirectorDirection } from "@/lib/canvas/director/director-motion";
import { canonicalDirectorJson, createDirectorProductionPackage } from "@/lib/canvas/director/director-timeline";
import { createDirectorFrameReview } from "@/lib/canvas/director/director-frame-critic";
import { searchMotionReferences } from "@/lib/canvas/director/motion-reference";

const jsonDownloadUrl = (value: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`;

export function DirectorMotionPanel({ scene, shot, onChange, onPreview }: { scene: DirectorScene; shot: DirectorShot; onChange: (direction: DirectorDirection | undefined) => void; onPreview: (direction: DirectorDirection | null) => void }) {
    const { message } = App.useApp();
    const [pattern, setPattern] = useState<MotionPatternId>(shot.direction?.patternId || "object-relay");
    const [query, setQuery] = useState("知识讲解 克制");
    const [proposal, setProposal] = useState<{ direction: DirectorDirection; snapshot: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [qa, setQa] = useState<{ result: Awaited<ReturnType<typeof createDirectorFrameReview>>; snapshot: string } | null>(null);
    const [productionDownload, setProductionDownload] = useState<{ href: string; filename: string; snapshot: string } | null>(null);
    const [editorErrors, setEditorErrors] = useState<Record<string, string>>({});
    const [writeError, setWriteError] = useState("");
    const references = useMemo(() => searchMotionReferences(query, 5), [query]);
    const snapshot = canonicalDirectorJson({ scene, fps: shot.fps, shotId: shot.id });
    const snapshotRef = useRef(snapshot);
    snapshotRef.current = snapshot;
    const requestRef = useRef(0);
    const mountedRef = useRef(true);
    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; requestRef.current += 1; onPreview(null); }; }, [onPreview]);
    useEffect(() => { setPattern(shot.direction?.patternId || "object-relay"); setEditorErrors({}); setWriteError(""); }, [shot.id, shot.direction?.patternId]);
    useEffect(() => { requestRef.current += 1; setProposal(null); setQa(null); setProductionDownload(null); onPreview(null); }, [snapshot, onPreview]);
    const sourceErrors = shot.direction ? validateDirectorDirection(shot.direction) : [];
    const d = useMemo(() => {
        if (!shot.direction || validateDirectorDirection(shot.direction).length) return undefined;
        const next = retimeDirectorDirection(shot.direction, shot.fps);
        const { impact } = directorMotionTiming(next, Math.max(1, Math.round(shot.duration * shot.fps)), shot.fps);
        next.audioCues = next.audioCues.map((cue) => cue.anchor === "primary-impact" ? { ...cue, frame: impact } : cue);
        return next;
    }, [shot.direction, shot.fps, shot.duration]);
    const invalidate = () => { requestRef.current += 1; setQa(null); setProposal(null); setProductionDownload(null); onPreview(null); };
    const setFieldError = useCallback((field: string, error: string) => { setEditorErrors((current) => current[field] === error ? current : { ...current, [field]: error }); }, []);
    const update = (patch: Partial<DirectorDirection>) => {
        invalidate();
        if (!d) return;
        const next = { ...d, ...patch };
        const invalid = validateDirectorDirection(next);
        setWriteError(invalid.join("；"));
        if (!invalid.length) onChange(next);
    };
    const propose = () => {
        invalidate();
        const next = createDirectorDirection(pattern, d ? { ...d, patternId: pattern, patternVersion: "1.0.0" } : { frameRate: shot.fps });
        setProposal({ direction: next, snapshot });
        onPreview(next);
    };
    const currentProposal = proposal?.snapshot === snapshot ? proposal.direction : null;
    const apply = () => { if (currentProposal) { invalidate(); onChange(currentProposal); } };
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try { await action(); } catch (error) { if (mountedRef.current) message.error(error instanceof Error ? error.message : "导演制作包处理失败"); }
        finally { if (mountedRef.current) setBusy(false); }
    };
    const errors = [...sourceErrors, ...Object.values(editorErrors).filter(Boolean), ...(writeError ? [writeError] : [])];
    const currentQa = qa?.snapshot === snapshot && !errors.length ? qa.result : null;
    const currentProductionDownload = productionDownload?.snapshot === snapshot && !errors.length && !currentProposal ? productionDownload : null;
    return <section aria-label="动效导演编排" className="space-y-3 p-3 text-xs">
        <h2 className="text-sm font-semibold">动效导演</h2>
        <p className="opacity-65">先决定观众看懂什么，再安排主体、镜头和节拍。</p>
        <label className="block space-y-1"><span>动效模式</span><Select aria-label="动效模式" value={pattern} onChange={(next) => { invalidate(); setPattern(next); }} className="w-full" options={MOTION_PATTERN_IDS.map((id) => ({ value: id, label: MOTION_PATTERN_LABELS[id] }))} /></label>
        <Button size="small" block disabled={errors.length > 0} onClick={propose}>预览模式变更</Button>
        {currentProposal ? <div className="space-y-2 rounded-lg border border-[var(--border)] p-2" role="status"><p>正在预览候选，尚未写入镜头。应用后可撤销；已有文案、绑定和手动参数保留。编辑场景或参数后请重新预览。</p><Button size="small" type="primary" block onClick={apply}>应用候选到本镜</Button><Button size="small" block onClick={invalidate}>取消候选</Button></div> : null}
        {d ? <>
            <label className="block space-y-1"><span>本镜观看意图</span><Input.TextArea aria-label="本镜观看意图" value={d.intent} rows={2} onChange={(e) => update({ intent: e.target.value })} /></label>
            <label className="block space-y-1"><span>口播原句</span><Input.TextArea aria-label="口播原句" value={d.sourceAnchor} rows={2} onChange={(e) => update({ sourceAnchor: e.target.value })} /></label>
            <label className="block space-y-1"><span>观看焦点</span><Input aria-label="观看焦点" value={d.focus} onChange={(e) => update({ focus: e.target.value })} /></label>
            <label className="block space-y-1"><span>情绪</span><Input aria-label="情绪" value={d.emotion} onChange={(e) => update({ emotion: e.target.value })} /></label>
            <label className="block space-y-1"><span>动作初态</span><Input aria-label="动作初态" value={d.action.initial} onChange={(e) => update({ action: { ...d.action, initial: e.target.value } })} /></label>
            <label className="block space-y-1"><span>主体行动</span><Input aria-label="主体行动" value={d.action.verb} onChange={(e) => update({ action: { ...d.action, verb: e.target.value } })} /></label>
            <label className="block space-y-1"><span>动作终态</span><Input aria-label="动作终态" value={d.action.final} onChange={(e) => update({ action: { ...d.action, final: e.target.value } })} /></label>
            <label className="block space-y-1"><span>可见变化</span><Input.TextArea aria-label="可见变化" value={d.action.observableChange} rows={2} onChange={(e) => update({ action: { ...d.action, observableChange: e.target.value } })} /></label>
            <label className="block space-y-1"><span>准确标题</span><Input aria-label="准确标题" value={d.content.title} onChange={(e) => update({ content: { ...d.content, title: e.target.value } })} /></label>
            <label className="block space-y-1"><span>内容标签，每行一项</span><Input.TextArea aria-label="内容标签" value={d.content.labels.join("\n")} rows={3} onChange={(e) => update({ content: { ...d.content, labels: e.target.value.split("\n").slice(0, 6) } })} /></label>
            {d.patternId === "diagram-morph" ? <StructuredTextField label="明确关系，每行如 1>2" value={d.content.relations ?? []} format={(relations) => relations.map((relation) => `${relation.from + 1}>${relation.to + 1}`).join("\n")} parse={(raw) => parseRelations(raw, d.content.labels.length)} placeholder="1>2\n2>3" onEdit={invalidate} onValidity={(error) => setFieldError("relations", error)} onChange={(relations) => update({ content: { ...d.content, relations } })} /> : null}
            {d.patternId === "diagram-morph" ? <p className="opacity-60">编号对应标签顺序。只绘制明确关系；留空不添加连线。</p> : null}
            <label className="block space-y-1"><span>主体绑定</span><Select aria-label="主体绑定" allowClear className="w-full" value={d.subjectBindings.find((b) => b.role === "primary")?.objectId} options={scene.objects.map((o) => ({ value: o.id, label: o.name }))} onChange={(id: string | undefined) => { const object = scene.objects.find((o) => o.id === id); const previous = d.subjectBindings.find((binding) => binding.role === "primary" && binding.objectId === id && binding.assetId === object?.assetId); update({ subjectBindings: [...d.subjectBindings.filter((binding) => binding.role !== "primary"), ...(object ? [{ objectId: object.id, assetId: object.assetId, sha256: previous?.sha256, role: "primary" as const }] : [])] }); }} /></label>
            <p className="opacity-60">绑定引用现有场景资产；身份图片与哈希可通过制作包保留，不以人偶颜色证明身份。</p>
            <NumberField label="运动幅度" value={d.motion.amplitude} min={0} max={2} step={0.1} onChange={(value) => update({ motion: { ...d.motion, amplitude: value } })} />
            <NumberField label="次主体间隔（帧）" value={d.motion.staggerFrames} min={0} max={shot.fps * 5} onChange={(value) => update({ motion: { ...d.motion, staggerFrames: value } })} />
            <NumberField label="回稳时间（帧）" value={d.motion.settleFrames} min={1} max={shot.fps * 5} onChange={(value) => update({ motion: { ...d.motion, settleFrames: value } })} />
            <NumberField label="相机推进" value={d.camera.push} min={0} max={0.5} step={0.01} onChange={(value) => update({ camera: { ...d.camera, push: value } })} />
            <NumberField label="相机延迟（帧）" value={d.camera.delayFrames} min={0} max={shot.fps * 5} onChange={(value) => update({ camera: { ...d.camera, delayFrames: value } })} />
            <label className="flex items-center justify-between gap-2"><span>主体光色</span><Input type="color" aria-label="主体光色" className="!w-20" value={d.light.keyColor} onChange={(e) => update({ light: { ...d.light, keyColor: e.target.value } })} /></label>
            <label className="flex items-center justify-between gap-2"><span>背景色</span><Input type="color" aria-label="背景色" className="!w-20" value={d.light.background} onChange={(e) => update({ light: { ...d.light, background: e.target.value } })} /></label>
            <NumberField label="阅读停留（帧）" value={d.readableHoldFrames} min={0} max={10000} onChange={(value) => update({ readableHoldFrames: value })} />
            <label className="block space-y-1"><span>时码状态</span><Select aria-label="时码状态" className="w-full" value={d.timingStatus} options={[{ value: "estimated", label: "估时" }, { value: "voice_locked", label: "真实声音锁时" }]} onChange={(timingStatus) => update({ timingStatus })} /></label>
            <label className="block space-y-1"><span>过镜原因</span><Input aria-label="过镜原因" value={d.continuity.reason} onChange={(e) => update({ continuity: { ...d.continuity, reason: e.target.value } })} /></label>
            <StructuredTextField label="连续性初态，每行 key=value" value={d.continuity.statesIn} format={formatStates} parse={parseStates} placeholder="paper.holder=teacher.right_hand" onEdit={invalidate} onValidity={(error) => setFieldError("statesIn", error)} onChange={(statesIn) => update({ continuity: { ...d.continuity, statesIn } })} />
            <StructuredTextField label="连续性终态，每行 key=value" value={d.continuity.statesOut} format={formatStates} parse={parseStates} placeholder="paper.holder=student.left_hand" onEdit={invalidate} onValidity={(error) => setFieldError("statesOut", error)} onChange={(statesOut) => update({ continuity: { ...d.continuity, statesOut } })} />
            {d.patternId === "continuous-shape-transition" ? <>
                <p className="opacity-60">入口与出口坐标以画面宽高比例表示。相邻连续形状镜的编译入口会接住上镜出口，原场景决定仍保留。</p>
                <label className="block space-y-1"><span>共享元素 ID</span><Input aria-label="共享元素 ID" value={d.transition.sharedElementId} onChange={(e) => update({ transition: { ...d.transition, sharedElementId: e.target.value } })} /></label>
                {(["sharedAnchor", "exitAnchor"] as const).map((key) => <div key={key} className="space-y-2 rounded-lg border border-[var(--border)] p-2"><p>{key === "sharedAnchor" ? "入口锚点" : "出口锚点"}</p>{(["x", "y", "width", "height", "rotation"] as const).map((field) => <NumberField key={field} label={`${key === "sharedAnchor" ? "入口" : "出口"}${({ x: "横向位置", y: "纵向位置", width: "宽度", height: "高度", rotation: "旋转角" })[field]}`} value={d.transition[key][field]} min={field === "rotation" ? -360 : field === "width" || field === "height" ? 0.01 : 0} max={field === "rotation" ? 360 : 1} step={field === "rotation" ? 1 : 0.01} onChange={(value) => update({ transition: { ...d.transition, [key]: { ...d.transition[key], [field]: value } } })} />)}</div>)}
            </> : null}
            <Button size="small" block onClick={() => update({ audioCues: d.audioCues.length ? [] : [{ id: `${shot.id}-impact`, kind: "impact", anchor: "primary-impact", frame: directorMotionTiming(d, Math.max(1, Math.round(shot.duration * shot.fps)), shot.fps).impact, gain: 0.12 }] })}>{d.audioCues.length ? "移除事件音效" : "为主事件添加音效 cue"}</Button>
            {d.audioCues.map((cue, index) => <div key={cue.id} className="space-y-1"><span>{cue.kind} · {cue.id}</span>{cue.anchor === "primary-impact" ? <p className="opacity-60">跟随主事件；编辑位置改为固定帧。</p> : <p className="opacity-60">固定帧位置。</p>}<NumberField label="音效位置（帧）" value={cue.frame} min={0} max={Math.max(0, Math.round(shot.duration * shot.fps) - 1)} onChange={(frame) => update({ audioCues: d.audioCues.map((c, i) => { if (i !== index) return c; const fixedCue = { ...c, frame }; delete fixedCue.anchor; return fixedCue; }) })} /><NumberField label="音效增益" value={cue.gain} min={0} max={1} step={0.01} onChange={(gain) => update({ audioCues: d.audioCues.map((c, i) => i === index ? { ...c, gain } : c) })} /></div>)}
        </> : <p>选一个模式预览并应用，开始填写本镜导演决定。</p>}
        {errors.length ? <p role="alert" className="text-[var(--status-error)]">{errors.join("；")}。输入完整后才会写入场景。</p> : null}
        <hr className="border-[var(--border)]" />
        <label className="block space-y-1"><span>查找参考</span><Input aria-label="查找动效参考" value={query} placeholder="科技感 不要 glow" onChange={(e) => setQuery(e.target.value)} /></label>
        <p className="opacity-60">结果来自本地索引；来源资料与实际动态审看分别标记。</p>
        <div className="space-y-2">{references.map((result) => <article key={result.reference.id} className="rounded-lg border border-[var(--border)] p-2">
            <a className="block break-words underline" href={result.reference.source.url} target="_blank" rel="noreferrer">{result.reference.title}</a>
            <p className="mt-1 opacity-60">{result.reasons.join("；")} · {result.reviewState}</p>
            <Button size="small" disabled={!d} className="mt-1" onClick={() => d && update({ references: [...d.references.filter((r) => r.caseId !== result.reference.id), { caseId: result.reference.id, url: result.reference.source.url, review: "metadata" }] })}>引用该参考</Button>
        </article>)}</div>
        {d?.references.length ? <p>{d.references.length} 个参考已绑定本镜。新增引用标为元数据，完整审看片段后再更新核验状态。</p> : null}
        <Button size="small" block disabled={!d || errors.length > 0 || Boolean(currentProposal)} loading={busy} onClick={() => { const request = ++requestRef.current; const captured = structuredClone(scene); setQa(null); void run(async () => { const result = await createDirectorFrameReview(captured, shot.fps); if (mountedRef.current && requestRef.current === request && snapshotRef.current === snapshot) setQa({ result, snapshot }); }); }}>检查整条导演时间线</Button>
        {currentQa ? <div role="status" className="space-y-1"><p>几何检查：{currentQa.coverage.geometricFrames} 帧，{currentQa.technicalStatus === "passed" ? "无阻断问题" : "发现问题"}。内容看听未执行。场景或帧率修改后需重新检查。</p>{currentQa.issues.map((issue, index) => <p key={`${issue.shotId}-${issue.code}-${index}`} className="break-words">{issue.shotId} · 帧 {issue.globalFrame} · {issue.message}</p>)}</div> : null}
        <Button size="small" block disabled={errors.length > 0 || Boolean(currentProposal)} loading={busy} onClick={() => { const request = ++requestRef.current; const captured = structuredClone(scene); setProductionDownload(null); void run(async () => { const pack = await createDirectorProductionPackage(captured, shot.fps); if (mountedRef.current && requestRef.current === request && snapshotRef.current === snapshot) setProductionDownload({ href: jsonDownloadUrl(pack), filename: `director-${captured.id}-production-v1.0.0.json`, snapshot }); }); }}>导出整条制作包</Button>
        {currentProductionDownload ? <div role="status" className="space-y-1"><p>制作包已生成。点击下载保存当前版本；修改场景后需重新生成。</p><a className="block break-words underline" href={currentProductionDownload.href} download={currentProductionDownload.filename}>下载制作包JSON</a></div> : null}
        {currentQa ? <a className="block break-words underline" aria-label="导出本次检查证据" href={jsonDownloadUrl(currentQa)} download={`director-${scene.id}-qa-v1.0.0.json`}>下载检查证据JSON</a> : null}
        {shot.direction ? <Button size="small" block danger onClick={() => { invalidate(); setEditorErrors({}); setWriteError(""); onChange(undefined); }}>移除本镜动效编排</Button> : null}
    </section>;
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
    return <label className="flex items-center justify-between gap-2"><span>{label}</span><InputNumber aria-label={label} className="w-20 shrink-0" value={value} min={min} max={max} step={step} precision={step === 1 ? 0 : undefined} onChange={(v) => { if (typeof v === "number") onChange(v); }} /></label>;
}

const formatStates = (value: Record<string, string>) => Object.entries(value).map(([key, state]) => `${key}=${state}`).join("\n");

function parseStates(raw: string): Record<string, string> {
    const entries: [string, string][] = [];
    const keys = new Set<string>();
    raw.split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (separator < 1 || !key || !value) throw new Error(`第 ${index + 1} 行需填写完整的 key=value`);
        if (keys.has(key)) throw new Error(`第 ${index + 1} 行重复状态 ${key}`);
        if (key.length > 10000 || value.length > 10000) throw new Error(`第 ${index + 1} 行状态内容过长`);
        keys.add(key);
        entries.push([key, value]);
    });
    return Object.fromEntries(entries);
}

function parseRelations(raw: string, labelCount: number): { from: number; to: number }[] {
    const relations: { from: number; to: number }[] = [];
    const seen = new Set<string>();
    raw.split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        const match = line.match(/^\s*(\d+)\s*>\s*(\d+)\s*$/);
        if (!match) throw new Error(`第 ${index + 1} 行关系需写成 1>2`);
        const from = Number(match[1]) - 1;
        const to = Number(match[2]) - 1;
        if (from < 0 || to < 0 || from >= labelCount || to >= labelCount || from === to) throw new Error(`第 ${index + 1} 行需引用不同的现有标签，编号范围 1～${labelCount}`);
        const key = `${from}>${to}`;
        if (seen.has(key)) throw new Error(`第 ${index + 1} 行重复关系`);
        seen.add(key);
        relations.push({ from, to });
    });
    return relations;
}

/** Incomplete input stays local; canonical values remain valid for rendering and export. */
function StructuredTextField<T>({ label, value, format, parse, placeholder, onChange, onEdit, onValidity }: { label: string; value: T; format: (value: T) => string; parse: (raw: string) => T; placeholder: string; onChange: (value: T) => void; onEdit: () => void; onValidity: (error: string) => void }) {
    const [raw, setRaw] = useState(() => format(value));
    const [error, setError] = useState("");
    const serialized = canonicalDirectorJson(value);
    const emittedRef = useRef(serialized);
    const callbacksRef = useRef({ format, onValidity });
    callbacksRef.current = { format, onValidity };
    useEffect(() => {
        // Keep the user's spacing/newline while reflecting undo, load or other external changes.
        if (serialized !== emittedRef.current) {
            emittedRef.current = serialized;
            setRaw(callbacksRef.current.format(value));
            setError("");
            callbacksRef.current.onValidity("");
        }
    }, [serialized, value]);
    return <label className="block space-y-1"><span>{label}</span><Input.TextArea aria-label={label} value={raw} rows={3} placeholder={placeholder} status={error ? "error" : undefined} onChange={(event) => {
        const nextRaw = event.target.value;
        setRaw(nextRaw);
        onEdit();
        try {
            const next = parse(nextRaw);
            emittedRef.current = canonicalDirectorJson(next);
            setError("");
            onValidity("");
            onChange(next);
        } catch (cause) {
            const nextError = cause instanceof Error ? cause.message : "输入格式无效";
            setError(nextError);
            onValidity(`${label}：${nextError}`);
        }
    }} />{error ? <span role="alert" className="block text-[var(--status-error)]">{error}。当前草稿尚未写入场景。</span> : null}</label>;
}

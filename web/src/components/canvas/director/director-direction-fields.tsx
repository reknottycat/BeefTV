import { Button, Input, InputNumber } from "antd";
import { createDirectorDirection, validateDirectorDirection } from "@/lib/canvas/director/director-direction";
import type { DirectorDirection } from "@/types/director-motion";

export function DirectorDirectionFields({ value, duration, onChange }: { value?: DirectorDirection; duration: number; onChange: (value: DirectorDirection) => void }) {
    if (!value) return <Button block onClick={() => onChange(createDirectorDirection())}>补充动作与连续性</Button>;
    const issues = validateDirectorDirection(value, duration * 1000);
    const textField = (label: string, text: string, update: (value: string) => void) => <label className="block space-y-1 text-xs"><span>{label}</span><Input.TextArea aria-label={label} value={text} maxLength={2000} autoSize={{ minRows: 1, maxRows: 5 }} style={{ resize: "none" }} onChange={(event) => update(event.target.value)} /></label>;
    return <details open className="space-y-3 rounded-lg border border-[var(--border)] p-3">
        <summary className="cursor-pointer text-sm font-medium">动作与连续性</summary>
        <p className="text-xs leading-5 opacity-65">这些说明随镜头送入生成提示词。实际动作与节奏需检查生成结果；场景运动仍由关键帧控制。</p>
        {textField("剧本原句", value.sourceAnchor, (sourceAnchor) => onChange({ ...value, sourceAnchor }))}
        {textField("视觉焦点", value.focus, (focus) => onChange({ ...value, focus }))}
        {textField("情绪", value.emotion, (emotion) => onChange({ ...value, emotion }))}
        {([['initial', '主体初态'], ['verb', '主体动作'], ['final', '主体终态'], ['observableChange', '可见变化']] as const).map(([key, label]) => <div key={key}>{textField(label, value.action[key], (text) => onChange({ ...value, action: { ...value.action, [key]: text } }))}</div>)}
        <label className="block space-y-1 text-xs"><span>动作幅度建议</span><InputNumber className="w-full" aria-label="动作幅度建议" min={0} max={2} step={0.1} value={value.motion.amplitude} addonAfter="倍" onChange={(amplitude) => { if (amplitude !== null) onChange({ ...value, motion: { ...value.motion, amplitude } }); }} /></label>
        {([['staggerMs', '次主体间隔'], ['settleMs', '回稳时间']] as const).map(([key, label]) => <label key={key} className="block space-y-1 text-xs"><span>{label}</span><InputNumber className="w-full" aria-label={label} min={0} max={duration} step={0.1} value={value.motion[key] / 1000} addonAfter="秒" onChange={(seconds) => { if (seconds !== null) onChange({ ...value, motion: { ...value.motion, [key]: Math.round(seconds * 1000) } }); }} /></label>)}
        {([['statesIn', '入镜状态'], ['statesOut', '出镜状态'], ['reason', '与上一镜承接理由']] as const).map(([key, label]) => <div key={key}>{textField(label, value.continuity[key], (text) => onChange({ ...value, continuity: { ...value.continuity, [key]: text } }))}</div>)}
        {issues.length ? <p role="alert" className="text-xs text-[var(--status-error)]">{issues.join("；")}</p> : null}
    </details>;
}

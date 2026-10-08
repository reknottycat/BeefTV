import { Button, InputNumber } from "antd";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

/** Controlled audio editing; the owning work/run saves this same timeline snapshot. */
export function TimelineAudioControls({ timeline, onChange, disabled = false }: {
    timeline: TimelineProject;
    onChange: (timeline: TimelineProject) => void;
    disabled?: boolean;
}) {
    const clips = timeline.clips.filter((clip) => clip.kind === "audio" || clip.kind === "video");
    const updateClip = (id: string, patch: Partial<TimelineClip>) => onChange({
        ...timeline,
        clips: timeline.clips.map((clip) => clip.id === id ? { ...clip, ...patch } : clip),
    });
    return <div className="space-y-3" aria-label="声音设置">
        {clips.length === 0 ? <p className="text-xs text-[var(--workspace-text-muted)]">选用镜头或添加声音素材后，可调整音量与淡入淡出。</p> : null}
        {timeline.tracks.filter((track) => clips.some((clip) => clip.trackId === track.id)).map((track) => <section key={track.id} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-sm font-medium">{track.label}{track.visible === false ? <span className="ml-2 text-xs font-normal opacity-60">已隐藏，不参与预览与导出</span> : null}</span>
                <Button size="small" disabled={disabled || track.locked} aria-pressed={Boolean(track.muted)} aria-label={`${track.muted ? "取消静音" : "静音"}${track.label}`} onClick={() => onChange({ ...timeline, tracks: timeline.tracks.map((item) => item.id === track.id ? { ...item, muted: !item.muted } : item) })}>{track.muted ? "取消静音" : "静音"}</Button>
            </div>
            {clips.filter((clip) => clip.trackId === track.id).map((clip) => <fieldset key={clip.id} disabled={disabled || track.locked} className="space-y-2 rounded-lg border border-[var(--border)] p-3">
                <legend className="max-w-full truncate px-1 text-xs">{clip.title || clip.directMedia?.title || "未命名片段"}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <label className="space-y-1 text-xs"><span className="block">音量</span><InputNumber className="w-full" aria-label={`${clip.title || "片段"}音量百分比`} disabled={disabled || track.locked} min={0} max={100} value={Math.round((clip.volume ?? 1) * 100)} addonAfter="%" onChange={(value) => { if (value !== null) updateClip(clip.id, { volume: value / 100 }); }} /></label>
                    <label className="space-y-1 text-xs"><span className="block">淡入</span><InputNumber className="w-full" aria-label={`${clip.title || "片段"}淡入秒数`} disabled={disabled || track.locked} min={0} max={clip.durationMs / 1000} step={0.1} value={(clip.fadeInMs ?? 0) / 1000} addonAfter="秒" onChange={(value) => { if (value !== null) updateClip(clip.id, { fadeInMs: Math.round(value * 1000) }); }} /></label>
                    <label className="space-y-1 text-xs"><span className="block">淡出</span><InputNumber className="w-full" aria-label={`${clip.title || "片段"}淡出秒数`} disabled={disabled || track.locked} min={0} max={clip.durationMs / 1000} step={0.1} value={(clip.fadeOutMs ?? 0) / 1000} addonAfter="秒" onChange={(value) => { if (value !== null) updateClip(clip.id, { fadeOutMs: Math.round(value * 1000) }); }} /></label>
                </div>
            </fieldset>)}
        </section>)}
    </div>;
}

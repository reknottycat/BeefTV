import type { DirectorDirection } from "@/types/director-motion";
import { renderDirectorMotionSvg, validateDirectorDirection } from "@/lib/canvas/director/director-motion";

export function DirectorMotionPreview({ direction, time, duration, fps, pending = false }: { direction: DirectorDirection; time: number; duration: number; fps: number; pending?: boolean }) {
    const errors = validateDirectorDirection(direction);
    if (errors.length) return <p role="alert" className="p-5 text-sm text-white">{errors.join("；")}</p>;
    const svg = renderDirectorMotionSvg(direction, Math.round(time * fps), Math.max(1, Math.round(duration * fps)), fps);
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-4" data-motion-preview="true">
        <img className="max-h-[calc(100%-48px)] w-full object-contain" alt={direction.content.title || "动效导演预演"} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
        <p className="text-xs text-white/70">{pending ? "候选预演，尚未应用" : "当前镜头编排"} · 帧 {Math.round(time * fps)} · {fps} fps · 2D 合成预演</p>
    </div>;
}

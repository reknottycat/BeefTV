import { useEffect, useRef, useState } from "react";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveClipMediaTimeSeconds } from "@/lib/timeline/timeline-playback";
import { timelineClipVolume } from "@/lib/timeline/timeline-audio";
import { timelineClipSource } from "@/lib/timeline/timeline-source";

export function CanvasTimelineAudio({ clip, node, timeMs, playing, tracks, onError, onReady }: { clip: TimelineClip; node?: CanvasNodeData; timeMs: number; playing: boolean; tracks: TimelineTrack[]; onError: (message: string) => void; onReady: (id: string, ready: boolean) => void }) {
    const ref = useRef<HTMLAudioElement>(null);
    const [url, setUrl] = useState("");
    const callbacks = useRef({ onError, onReady });
    callbacks.current = { onError, onReady };
    const active = timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs;
    useEffect(() => {
        let live = true;
        setUrl("");
        callbacks.current.onReady(clip.id, false);
        const source = timelineClipSource(clip, node);
        void resolveMediaUrl(source.storageKey, source.url)
            .then((value) => {
                if (live) {
                    if (!value) throw new Error("找不到音频素材");
                    setUrl(value);
                }
            })
            .catch(() => {
                if (live) callbacks.current.onError(`无法读取音频「${clip.title || "未命名片段"}」，请检查素材后重试`);
            });
        return () => {
            live = false;
        };
    }, [clip.id, clip.directMedia, node?.metadata?.storageKey, node?.metadata?.content]);
    useEffect(() => {
        const audio = ref.current;
        if (!audio) return;
        audio.volume = timelineClipVolume(clip, timeMs, tracks);
        const seek = () => {
            const target = resolveClipMediaTimeSeconds(clip, timeMs);
            if (active && audio.readyState >= 1 && Math.abs(audio.currentTime - target) > (playing ? 0.2 : 0.01)) audio.currentTime = target;
        };
        seek();
        audio.addEventListener("loadedmetadata", seek);
        let live = true;
        if (playing && active) {
            if (audio.paused)
                void audio.play().catch((cause) => {
                    if (live && ref.current === audio && !(cause instanceof DOMException && cause.name === "AbortError")) callbacks.current.onError("音频播放失败，请重新点击播放或检查素材");
                });
        } else audio.pause();
        return () => { live = false; audio.removeEventListener("loadedmetadata", seek); };
    }, [clip, timeMs, playing, tracks, active, url]);
    return url ? <audio ref={ref} src={url} preload="auto" onCanPlay={() => onReady(clip.id, true)} onWaiting={() => onReady(clip.id, false)} onError={() => onError(`音频「${clip.title || "未命名片段"}」无法播放，请检查格式或重新导入`)} aria-label={clip.title || "时间线音频"} /> : null;
}

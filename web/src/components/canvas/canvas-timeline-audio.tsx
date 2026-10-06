import { useEffect, useRef, useState } from "react";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveClipMediaTimeSeconds } from "@/lib/timeline/timeline-playback";
import { timelineClipVolume } from "@/lib/timeline/timeline-audio";

export function CanvasTimelineAudio({ clip, node, timeMs, playing, tracks, onError }: { clip: TimelineClip; node?: CanvasNodeData; timeMs: number; playing: boolean; tracks: TimelineTrack[]; onError: () => void }) {
    const ref = useRef<HTMLAudioElement>(null);
    const [url, setUrl] = useState("");
    const active = timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs;
    useEffect(() => {
        let live = true;
        setUrl("");
        const media = clip.directMedia;
        void resolveMediaUrl(media?.storageKey || node?.metadata?.storageKey || "", media?.url || media?.dataUrl || node?.metadata?.content || "")
            .then((value) => {
                if (live) setUrl(value);
            })
            .catch(() => {
                if (live) onError();
            });
        return () => {
            live = false;
        };
    }, [clip.directMedia, node?.metadata?.storageKey, node?.metadata?.content]);
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
        if (playing && active && audio.volume > 0) {
            if (audio.paused)
                void audio.play().catch((cause) => {
                    if (ref.current === audio && cause.name !== "AbortError") onError();
                });
        } else audio.pause();
        return () => audio.removeEventListener("loadedmetadata", seek);
    }, [clip, timeMs, playing, tracks, active, url, onError]);
    return url ? <audio ref={ref} src={url} preload="metadata" onError={onError} aria-label={clip.title || "时间线音频"} /> : null;
}

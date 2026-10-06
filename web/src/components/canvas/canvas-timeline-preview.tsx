import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";
import { advancePreviewTime, findClipByKind, resolveClipMediaTimeSeconds } from "@/lib/timeline/timeline-playback";
import { createDefaultSubtitleStyle } from "@/types/timeline";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";
import { timelineClipVisible, timelineClipVolume } from "@/lib/timeline/timeline-audio";
import { CanvasTimelineAudio } from "./canvas-timeline-audio";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasSubtitleOverlay } from "./canvas-subtitle-overlay";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasTimelinePreviewProps = {
    clips: TimelineClip[];
	tracks?: TimelineTrack[];
    nodes: CanvasNodeData[];
    playheadMs: number;
    playing: boolean;
    theme: CanvasTheme;
    onTogglePlay: () => void;
    onPlayingChange: (playing: boolean) => void;
    durationMs: number;
    onPlayheadChange: (ms: number) => void;
};

const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 168;

/**
 * 时间线弹窗的所见即所得预览：显示播放头所在视频片段，并叠加当前字幕。
 * 时间线时钟推进播放头；播放、暂停和标尺跳转都用同一素材定位规则。
 */
export function CanvasTimelinePreview({ clips, tracks = [], nodes, playheadMs, playing, theme, onTogglePlay, onPlayingChange, durationMs, onPlayheadChange }: CanvasTimelinePreviewProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [videoUrl, setVideoUrl] = useState("");
    const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
    // 源内定位目标（秒）；视频换源后 metadata 尚未加载时先记录，loadedmetadata 后再应用。
    const targetSeekSecRef = useRef<number | null>(null);

    const visibleClips = useMemo(() => clips.filter((clip) => timelineClipVisible(clip, tracks)), [clips, tracks]);
    const activeVideoClip = useMemo(() => {
        const active = visibleClips.filter((clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs);
        return findClipByKind(active, "video") || findClipByKind(active, "image");
    }, [playheadMs, visibleClips]);
    const activeSubtitleClip = useMemo(() => visibleClips.find((clip) => clip.kind === "subtitle" && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs && Boolean(clip.text?.trim())) || null, [visibleClips, playheadMs]);
    const activeNode = useMemo(() => (activeVideoClip ? nodes.find((node) => node.id === activeVideoClip.nodeId) || null : null), [activeVideoClip, nodes]);
    const subtitleStyle = activeNode?.metadata?.subtitleStyle || createDefaultSubtitleStyle();
    const activeHighlight = useMemo(() => {
        if (!activeSubtitleClip || activeSubtitleClip.subtitleEntryIndex === undefined || activeSubtitleClip.subtitleEntryIndex < 0 || !activeNode) return undefined;
        // subtitleEntryIndex 与字幕条目 index 同为 1 基，直接匹配，不再 +1（此前高亮永远匹配不上）。
        return (activeNode.metadata?.subtitleHighlights || []).find((item) => item.entryIndex === activeSubtitleClip.subtitleEntryIndex);
    }, [activeNode, activeSubtitleClip]);

    const playbackRef = useRef({ playheadMs, onPlayheadChange, onPlayingChange });
    playbackRef.current = { playheadMs, onPlayheadChange, onPlayingChange };
    useEffect(() => {
        if (!playing) return;
        let previousTime = performance.now();
        let frameId = 0;
        const tick = (now: number) => {
            const next = advancePreviewTime(playbackRef.current.playheadMs, now - previousTime, durationMs);
            previousTime = now;
            playbackRef.current.playheadMs = next;
            playbackRef.current.onPlayheadChange(next);
            if (next >= durationMs) { playbackRef.current.onPlayingChange(false); return; }
            frameId = requestAnimationFrame(tick);
        };
        frameId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frameId);
    }, [playing, durationMs]);

    // 解析当前片段视频地址（与字幕弹窗同一套缓存/回退策略）。
    useEffect(() => {
        const node = activeNode;
        const media = activeVideoClip?.directMedia;
        setVideoUrl("");
        setVideoSize(null);
        if (!node && !media) return;
        let cancelled = false;
        // 直连媒体片段（directMedia，不落画布）与画布节点走同一套缓存/回退解析策略
        const storageKey = media?.storageKey || node?.metadata?.storageKey || "";
        const fallback = media?.url || media?.dataUrl || node?.metadata?.content || "";
        const applyUrl = (url: string) => {
            if (!cancelled) setVideoUrl(url);
        };
        if (resourceIdFromStorageKey(storageKey)) {
            void cacheResourceObjectUrl(storageKey)
                .then((cached) => {
                    if (cancelled) return;
                    if (cached) {
                        setVideoUrl(cached);
                    } else {
                        void resolveMediaUrl(storageKey, fallback).then(applyUrl);
                    }
                })
                .catch(() => {
                    if (!cancelled) void resolveMediaUrl(storageKey, fallback).then(applyUrl);
                });
        } else {
            void resolveMediaUrl(storageKey, fallback).then(applyUrl);
        }
        return () => {
            cancelled = true;
        };
    }, [activeNode, activeVideoClip]);

    // Timeline time is authoritative even in gaps; media only corrects drift.
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !activeVideoClip || !videoUrl) return;
        const clampedTargetSec = resolveClipMediaTimeSeconds(activeVideoClip, playheadMs);
        video.volume = timelineClipVolume(activeVideoClip, playheadMs, tracks);
        targetSeekSecRef.current = clampedTargetSec;
        if (video.readyState >= 1 && Math.abs(video.currentTime - clampedTargetSec) > (playing ? 0.2 : 0.01)) {
            video.currentTime = clampedTargetSec;
        }
        if (playing) {
            if (video.paused) void video.play().catch((error) => {
                // A replaced or interrupted source must not stop the next shot.
                if (videoRef.current === video && !(error instanceof DOMException && error.name === "AbortError")) onPlayingChange(false);
            });
        } else {
            video.pause();
        }
    }, [activeVideoClip, playheadMs, playing, videoUrl, onPlayingChange, tracks]);

    // 视频换源后元数据加载完成，应用之前记录的源内定位目标。
    const handleVideoLoadedMetadata = (video: HTMLVideoElement) => {
        if (video.videoWidth > 0 && video.videoHeight > 0) setVideoSize({ width: video.videoWidth, height: video.videoHeight });
        if (targetSeekSecRef.current != null && video.readyState >= 1) {
            const target = Math.min(targetSeekSecRef.current, Math.max(0, (video.duration || 0) - 0.05));
            if (Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
        }
    };

    const previewDisplay = useMemo(() => {
        if (!videoSize || videoSize.height <= 0) return null;
        const ratio = videoSize.width / videoSize.height;
        let width = PREVIEW_WIDTH;
        let height = width / ratio;
        if (height > PREVIEW_HEIGHT) {
            height = PREVIEW_HEIGHT;
            width = Math.round(height * ratio);
        }
        return { width: Math.round(width), height: Math.round(height) };
    }, [videoSize]);

    return (
        <div className="canvas-timeline-preview flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            {visibleClips.filter((clip) => clip.kind === "audio").map((clip) => <CanvasTimelineAudio key={clip.id} clip={clip} node={nodes.find((node) => node.id === clip.nodeId)} timeMs={playheadMs} playing={playing} tracks={tracks} onError={() => onPlayingChange(false)} />)}
            <div className="relative grid shrink-0 place-items-center overflow-hidden rounded-lg bg-black" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} data-canvas-no-zoom>
                {videoUrl && activeVideoClip ? (
                    <>
                        <div className="relative" style={previewDisplay ? { width: previewDisplay.width, height: previewDisplay.height } : { width: "100%", height: "100%" }}>
                            {activeVideoClip.kind === "image" ? <img className="h-full w-full object-contain" src={videoUrl} alt={activeVideoClip.title || "镜头图片"} /> : <video ref={videoRef} className="block h-full w-full" src={videoUrl} playsInline preload="metadata" onError={() => onPlayingChange(false)} onLoadedMetadata={(event) => handleVideoLoadedMetadata(event.currentTarget)} />}
                            {activeSubtitleClip ? <CanvasSubtitleOverlay text={activeSubtitleClip.text || ""} highlight={activeHighlight} style={subtitleStyle} /> : null}
                        </div>
                        <button
                            type="button"
                            className="absolute inset-0 z-10 grid place-items-center"
                            aria-label={playing ? "暂停预览" : "播放预览"}
                            onClick={(event) => {
                                event.stopPropagation();
                                onTogglePlay();
                            }}
                        >
                            <span className="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:scale-105 hover:bg-black/60">
                                {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
                            </span>
                        </button>
                    </>
                ) : (
                    <button type="button" className="px-4 text-center text-xs opacity-55" aria-label={playing ? "暂停预览" : "播放预览"} onClick={onTogglePlay} disabled={durationMs <= 0}>
                        该位置无视频片段 · {playing ? "暂停" : "播放"}
                    </button>
                )}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                    <span className="truncate font-semibold" style={{ color: theme.accent.primary }}>
                        {activeVideoClip?.title || "无视频片段"}
                    </span>
                    <span className="opacity-45 tabular-nums">{activeVideoClip ? `${formatTimelineTime(activeVideoClip.startMs)} ~ ${formatTimelineTime(activeVideoClip.startMs + activeVideoClip.durationMs)}` : ""}</span>
                </div>
                <div className="mt-1.5 max-h-16 min-h-10 overflow-y-auto rounded-lg border px-2.5 py-1.5 text-xs leading-5" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    {activeSubtitleClip ? activeSubtitleClip.text : <span className="opacity-40">此处无字幕，点选字幕片段后在下方编辑</span>}
                </div>
            </div>
        </div>
    );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { timelineClipSource } from "@/lib/timeline/timeline-source";
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
    const [videoReady, setVideoReady] = useState(false);
    const [audioReady, setAudioReady] = useState<Record<string, boolean>>({});
    const [playbackError, setPlaybackError] = useState("");
    const [reload, setReload] = useState(0);
    const onPlayingChangeRef = useRef(onPlayingChange);
    onPlayingChangeRef.current = onPlayingChange;
    const reportAudioReady = useCallback((id: string, ready: boolean) => setAudioReady((state) => state[id] === ready ? state : { ...state, [id]: ready }), []);
    const reportError = useCallback((message: string) => { setPlaybackError(message); onPlayingChangeRef.current(false); }, []);
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

    const waiting = Boolean(activeVideoClip && (!videoUrl || !videoReady)) || visibleClips.some((clip) => clip.kind === "audio" && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs && !audioReady[clip.id]);
    const playbackRef = useRef({ playheadMs, onPlayheadChange, onPlayingChange, waiting });
    playbackRef.current = { playheadMs, onPlayheadChange, onPlayingChange, waiting };
    useEffect(() => {
        if (!playing) return;
        setPlaybackError("");
        let previousTime = performance.now();
        let frameId = 0;
        const tick = (now: number) => {
            const next = advancePreviewTime(playbackRef.current.playheadMs, playbackRef.current.waiting ? 0 : now - previousTime, durationMs);
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
        setVideoReady(false);
        setPlaybackError("");
        if (!activeVideoClip || (!node && !media)) {
            if (activeVideoClip) reportError("找不到片段选用的素材，请重新选择版本");
            return;
        }
        let cancelled = false;
        // 直连媒体片段（directMedia，不落画布）与画布节点走同一套缓存/回退解析策略
        const { storageKey, url: fallback } = timelineClipSource(activeVideoClip, node);
        void (async () => {
            const cached = resourceIdFromStorageKey(storageKey) ? await cacheResourceObjectUrl(storageKey).catch(() => null) : null;
            const url = cached || await resolveMediaUrl(storageKey, fallback);
            if (!url) throw new Error("找不到素材");
            if (!cancelled) setVideoUrl(url);
        })().catch(() => { if (!cancelled) reportError("无法读取预览素材，请检查片段选用的版本或重新导入"); });
        return () => {
            cancelled = true;
        };
    }, [activeNode, activeVideoClip, reportError, reload]);

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
        let live = true;
        if (playing && !waiting) {
            if (video.paused) void video.play().catch((error) => {
                // A replaced or interrupted source must not stop the next shot.
                if (live && videoRef.current === video && !(error instanceof DOMException && error.name === "AbortError")) reportError("视频播放失败，请重新点击播放或检查素材");
            });
        } else {
            video.pause();
        }
        return () => { live = false; };
    }, [activeVideoClip, playheadMs, playing, waiting, videoUrl, reportError, tracks]);

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
        <div className="canvas-timeline-preview flex flex-wrap items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            {visibleClips.filter((clip) => clip.kind === "audio").map((clip) => <CanvasTimelineAudio key={`${clip.id}:${reload}`} clip={clip} node={nodes.find((node) => node.id === clip.nodeId)} timeMs={playheadMs} playing={playing && !waiting} tracks={tracks} onReady={reportAudioReady} onError={reportError} />)}
            <div className="relative grid shrink-0 place-items-center overflow-hidden rounded-lg bg-black" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} data-canvas-no-zoom>
                {videoUrl && activeVideoClip ? (
                    <>
                        <div className="relative" style={previewDisplay ? { width: previewDisplay.width, height: previewDisplay.height } : { width: "100%", height: "100%" }}>
                            {activeVideoClip.kind === "image" ? <img className="h-full w-full object-contain" src={videoUrl} alt={activeVideoClip.title || "镜头图片"} onLoad={() => setVideoReady(true)} onError={() => reportError("图片加载失败，请检查素材")} /> : <video ref={videoRef} className="block h-full w-full" src={videoUrl} playsInline preload="auto" onCanPlay={() => setVideoReady(true)} onWaiting={() => setVideoReady(false)} onError={() => reportError("视频格式无法预览，请检查素材")} onLoadedMetadata={(event) => handleVideoLoadedMetadata(event.currentTarget)} />}
                            {activeSubtitleClip ? <CanvasSubtitleOverlay text={activeSubtitleClip.text || ""} highlight={activeHighlight} style={subtitleStyle} /> : null}
                        </div>
                        <button
                            type="button"
                            className="absolute inset-0 z-10 grid place-items-center"
                            aria-label={playing ? "暂停预览" : "播放预览"}
                            disabled={Boolean(playbackError)}
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
                    <button type="button" className="px-4 text-center text-xs opacity-55" aria-label={playing ? "暂停预览" : "播放预览"} onClick={onTogglePlay} disabled={durationMs <= 0 || Boolean(playbackError)}>
                        该位置无视频片段 · {playing ? "暂停" : "播放"}
                    </button>
                )}
            </div>
            <div className="min-w-0 flex-1">
                {playbackError ? <div role="alert" className="mb-2 text-xs text-[var(--status-error)]"><p>{playbackError}</p><button type="button" className="mt-1 underline focus-visible:outline" onClick={() => { setPlaybackError(""); setAudioReady({}); setReload((value) => value + 1); }}>重试预览</button></div> : waiting ? <p role="status" className="mb-2 text-xs opacity-60">正在加载预览素材…</p> : null}
                <div className="flex items-center gap-2 text-xs">
                    <span className="truncate font-semibold" style={{ color: theme.accent.primary }}>
                        {activeVideoClip?.title || "无视频片段"}
                    </span>
                    <span className="opacity-45 tabular-nums">{activeVideoClip ? `${formatTimelineTime(activeVideoClip.startMs)} ~ ${formatTimelineTime(activeVideoClip.startMs + activeVideoClip.durationMs)}` : ""}</span>
                </div>
                <div className="mt-1.5 max-h-16 min-h-10 overflow-y-auto rounded-lg border px-2.5 py-1.5 text-xs leading-5" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    {activeSubtitleClip ? activeSubtitleClip.text : <span className="opacity-40">当前时刻没有字幕</span>}
                </div>
            </div>
        </div>
    );
}

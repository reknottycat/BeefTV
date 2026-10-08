import type { TimelineClip, TimelineTrack } from "@/types/timeline";

export function timelineClipVisible(clip: TimelineClip, tracks: TimelineTrack[] = []) {
    return tracks.find((track) => track.id === clip.trackId)?.visible !== false;
}

export function timelineClipVolume(clip: TimelineClip, timeMs: number, tracks: TimelineTrack[] = []) {
    if (!Number.isFinite(timeMs) || timeMs < clip.startMs || timeMs >= clip.startMs + clip.durationMs || !timelineClipVisible(clip, tracks) || tracks.find((track) => track.id === clip.trackId)?.muted) return 0;
    const elapsed = Math.max(0, timeMs - clip.startMs);
    const remaining = Math.max(0, clip.durationMs - elapsed);
    const fadeIn = clip.fadeInMs && clip.fadeInMs > 0 ? Math.min(1, elapsed / Math.min(clip.durationMs, clip.fadeInMs)) : 1;
    const fadeOut = clip.fadeOutMs && clip.fadeOutMs > 0 ? Math.min(1, remaining / Math.min(clip.durationMs, clip.fadeOutMs)) : 1;
    const volume = Number.isFinite(clip.volume) ? clip.volume! : 1;
    return Math.max(0, Math.min(1, volume)) * fadeIn * fadeOut;
}

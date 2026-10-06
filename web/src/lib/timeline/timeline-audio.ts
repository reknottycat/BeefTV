import type { TimelineClip, TimelineTrack } from "@/types/timeline";

export function timelineClipVisible(clip: TimelineClip, tracks: TimelineTrack[] = []) {
    return tracks.find((track) => track.id === clip.trackId)?.visible !== false;
}

export function timelineClipVolume(clip: TimelineClip, timeMs: number, tracks: TimelineTrack[] = []) {
    if (!timelineClipVisible(clip, tracks) || tracks.find((track) => track.id === clip.trackId)?.muted) return 0;
    const elapsed = Math.max(0, timeMs - clip.startMs);
    const remaining = Math.max(0, clip.durationMs - elapsed);
    const fadeIn = clip.fadeInMs ? Math.min(1, elapsed / Math.min(clip.durationMs, clip.fadeInMs)) : 1;
    const fadeOut = clip.fadeOutMs ? Math.min(1, remaining / Math.min(clip.durationMs, clip.fadeOutMs)) : 1;
    return Math.max(0, Math.min(1, clip.volume ?? 1)) * fadeIn * fadeOut;
}

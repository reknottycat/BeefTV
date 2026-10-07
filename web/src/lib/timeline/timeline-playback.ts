// Adapted from Nomi src/workbench/player/timelinePlayback.ts at
// 92719b5e9914eef144298d29c6388ffa22c248b9 (Apache-2.0).
// Copyright 2025 Beq. Changes: BeefTV clip types, millisecond timebase,
// source bounds, and an independent preview clock. See THIRD_PARTY_NOTICES.md.
import type { TimelineClip } from "@/types/timeline";

export function findClipByKind(activeClips: TimelineClip[], kind: TimelineClip["kind"]): TimelineClip | null {
    return activeClips.find((clip) => clip.kind === kind) || null;
}

export function resolveClipMediaTimeSeconds(clip: TimelineClip, playheadMs: number): number {
    const sourceStartMs = Math.max(0, clip.sourceStartMs || 0);
    const relativeMs = Math.max(0, Math.min(clip.durationMs, playheadMs - clip.startMs));
    const targetMs = sourceStartMs + relativeMs;
    // sourceDurationMs is the entire source, rather than the visible window.
    const sourceEndMs = clip.sourceDurationMs || sourceStartMs + clip.durationMs;
    return Math.max(0, Math.min(targetMs, sourceEndMs - 1)) / 1000;
}

/** A timeline clock crosses gaps without depending on a mounted media element. */
export function advancePreviewTime(playheadMs: number, elapsedMs: number, durationMs: number): number {
    return Math.min(Math.max(0, durationMs), Math.max(0, playheadMs) + Math.max(0, elapsedMs));
}

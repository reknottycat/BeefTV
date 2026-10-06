import { describe, expect, test } from "bun:test";
import { advancePreviewTime, findClipByKind, resolveClipMediaTimeSeconds } from "@/lib/timeline/timeline-playback";
import type { TimelineClip } from "@/types/timeline";

const clip: TimelineClip = { id: "shot", nodeId: "node", trackId: "video", kind: "video", startMs: 3000, durationMs: 2000, sourceStartMs: 7000, sourceDurationMs: 10000 };

describe("timeline playback across source trims and gaps", () => {
    test("source time includes trim and stops at the source boundary", () => {
        expect(resolveClipMediaTimeSeconds(clip, 3500)).toBe(7.5);
        expect(resolveClipMediaTimeSeconds({ ...clip, sourceDurationMs: 8000 }, 4500)).toBe(7.999);
        expect(resolveClipMediaTimeSeconds(clip, 2500)).toBe(7);
    });
    test("clock crosses empty intervals and stops exactly at the project end", () => {
        expect(advancePreviewTime(2000, 500, 6000)).toBe(2500);
        expect(advancePreviewTime(5900, 500, 6000)).toBe(6000);
        expect(advancePreviewTime(1000, -500, 6000)).toBe(1000);
        expect(advancePreviewTime(0, 100, 0)).toBe(0);
    });
    test("an empty playback layer does not select a future clip", () => {
        expect(findClipByKind([], "video")).toBeNull();
        expect(findClipByKind([{ ...clip, kind: "audio" }, clip], "video")).toBe(clip);
    });
});

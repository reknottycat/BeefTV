import { describe, expect, test } from "bun:test";
import { timelineClipVolume, timelineClipVisible } from "@/lib/timeline/timeline-audio";
import { advancePreviewTime, resolveClipMediaTimeSeconds } from "@/lib/timeline/timeline-playback";
import { timelineClipSource } from "@/lib/timeline/timeline-source";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip } from "@/types/timeline";

const clip: TimelineClip = { id: "voice", kind: "audio", nodeId: "voice", trackId: "sound", startMs: 1000, durationMs: 4000, sourceStartMs: 8500, sourceDurationMs: 13000 };

describe("声音预览与剪辑语义", () => {
    test("选用版本缺素材时不偷换成画布上的新版本，预览和导出共享同一解析", () => {
        const node = { metadata: { storageKey: "resource:new", content: "https://example.test/new.mp4" } } as CanvasNodeData;
        expect(timelineClipSource({ ...clip, directMedia: { id: "selected", kind: "audio", title: "已选版本", content: "data:audio/wav;base64,old" } }, node)).toEqual({ storageKey: "", url: "data:audio/wav;base64,old" });
        expect(timelineClipSource({ ...clip, directMedia: { id: "selected", kind: "audio", title: "缺失素材" } }, node)).toEqual({ storageKey: "", url: "" });
        expect(timelineClipSource(clip, node).storageKey).toBe("resource:new");
    });
    test("保留零音量、轨道静音与隐藏，不播放片段区间以外声音", () => {
        expect(timelineClipVolume({ ...clip, volume: 0 }, 2000)).toBe(0);
        expect(timelineClipVolume(clip, 2000, [{ id: "sound", label: "声音", order: 0, kind: "audio", muted: true }])).toBe(0);
        const hidden = [{ id: "sound", label: "声音", order: 0, kind: "audio" as const, visible: false }];
        expect(timelineClipVisible(clip, hidden)).toBe(false);
        expect(timelineClipVolume(clip, 2000, hidden)).toBe(0);
        expect(timelineClipVolume(clip, 999)).toBe(0);
        expect(timelineClipVolume(clip, 5000)).toBe(0);
    });

    test("叠加片段音量与淡入淡出，零值不回退默认音量", () => {
        const faded = { ...clip, volume: 0.8, fadeInMs: 1000, fadeOutMs: 1000 };
        expect(timelineClipVolume(faded, 1000)).toBe(0);
        expect(timelineClipVolume(faded, 1500)).toBeCloseTo(0.4);
        expect(timelineClipVolume(faded, 3000)).toBeCloseTo(0.8);
        expect(timelineClipVolume(faded, 4500)).toBeCloseTo(0.4);
    });

    test("裁剪定位不越过源素材结尾，拖回片段开头保留 sourceStart", () => {
        expect(resolveClipMediaTimeSeconds(clip, 0)).toBe(8.5);
        expect(resolveClipMediaTimeSeconds(clip, 2000)).toBe(9.5);
        expect(resolveClipMediaTimeSeconds({ ...clip, sourceDurationMs: 10000 }, 5000)).toBe(9.999);
    });

    test("独立播放时钟跨越无视频的间隙并停在时间线末尾", () => {
        expect(advancePreviewTime(1000, 500, 5000)).toBe(1500);
        expect(advancePreviewTime(4900, 200, 5000)).toBe(5000);
        expect(advancePreviewTime(1000, -20, 5000)).toBe(1000);
    });
});

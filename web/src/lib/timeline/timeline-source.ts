import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip } from "@/types/timeline";

/** A selected version owns its source, even if missing; another canvas version is never a fallback. */
export function timelineClipSource(clip: TimelineClip, node?: CanvasNodeData | null) {
    const media = clip.directMedia;
    return media ? { storageKey: media.storageKey || "", url: media.url || media.dataUrl || media.content || "" }
        : { storageKey: node?.metadata?.storageKey || "", url: node?.metadata?.content || "" };
}

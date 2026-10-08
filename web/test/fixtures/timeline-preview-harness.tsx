import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { CanvasTimelinePreview } from "@/components/canvas/canvas-timeline-preview";
import { TimelineAudioControls } from "@/components/canvas/timeline-audio-controls";
import { DirectorDirectionFields } from "@/components/canvas/director/director-direction-fields";
import { compileDirectionPrompt } from "@/lib/canvas/director/director-direction";
import { canvasThemes } from "@/lib/canvas-theme";
import type { TimelineProject } from "@/types/timeline";
import type { DirectorDirection } from "@/types/director-motion";
import type { CanvasNodeData } from "@/types/canvas";
import { receipt } from "./timeline-preview-runtime";

function silentWave() {
    const buffer = new ArrayBuffer(44 + 16000 * 2);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    write(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); write(8, "WAVE"); write(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, "data"); view.setUint32(40, buffer.byteLength - 44, true);
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#546e7a"/><text x="90" y="95" fill="white">Selected shot</text></svg>');
const initial: TimelineProject = {
    version: 2, durationMs: 900,
    tracks: [{ id: "picture", kind: "image", label: "画面", order: 0 }, { id: "sound", kind: "audio", label: "配音", order: 1 }],
    clips: [
        { id: "picture", nodeId: "picture", kind: "image", trackId: "picture", startMs: 300, durationMs: 300, title: "选用镜头", directMedia: { id: "selected", kind: "image", title: "选用镜头", url: image } },
        { id: "voice", nodeId: "voice", kind: "audio", trackId: "sound", startMs: 0, durationMs: 900, title: "旁白", directMedia: { id: "voice-v1", kind: "audio", title: "旁白", url: silentWave() } },
    ],
};
const nodes = [{ id: "picture", metadata: { storageKey: "resource:unselected", content: "/unselected" } }, { id: "voice", metadata: { storageKey: "resource:unselected", content: "/unselected" } }] as CanvasNodeData[];
function Harness() {
    const [timeline, setTimeline] = useState(initial);
    const [playhead, setPlayhead] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [direction, setDirection] = useState<DirectorDirection>();
    const theme = canvasThemes.light;
    Object.assign(window, { previewFixture: { receipt, timeline, direction, prompt: direction ? compileDirectionPrompt(direction, 5000) : "" } });
    return <App><main style={{ maxWidth: 840, margin: "24px auto", padding: 16, fontFamily: "sans-serif" }}>
        <h1>镜头与声音预览验收</h1>
        <CanvasTimelinePreview clips={timeline.clips} tracks={timeline.tracks} nodes={nodes} playheadMs={playhead} durationMs={timeline.durationMs} playing={playing} onPlayingChange={setPlaying} onPlayheadChange={setPlayhead} theme={theme} onTogglePlay={() => { if (playhead >= timeline.durationMs) setPlayhead(0); setPlaying((value) => !value); }} />
        <output aria-label="播放状态">{playing ? "播放中" : "已暂停"}</output><output aria-label="播放头">{Math.round(playhead)}</output>
        <button onClick={() => { setPlaying(false); setPlayhead(450); }}>定位图片</button>
        <button onClick={() => { receipt.unavailable = true; setTimeline({ ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, directMedia: { ...clip.directMedia! } })) }); }}>模拟素材离线</button>
        <button onClick={() => { receipt.unavailable = false; }}>恢复素材服务</button>
        <h2>声音</h2><TimelineAudioControls timeline={timeline} onChange={setTimeline} />
        <h2>动作与连续性</h2><DirectorDirectionFields value={direction} duration={5} onChange={setDirection} />
    </main></App>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

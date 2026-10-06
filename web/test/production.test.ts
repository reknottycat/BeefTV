import { expect, test } from "bun:test";
import { productionChecks, productionTimeline } from "../src/lib/creation/production";
import { timelineClipVolume } from "../src/lib/timeline/timeline-audio";
import { CreativeAgentController, type CreativeControllerView } from "../src/services/creative-agent-controller";
import { initialCreativeState } from "../src/lib/creation/creative-agent-state";
import { creationRuns, type CreationRun } from "../src/services/api/creation-runs";
import { defaultConfig } from "../src/stores/use-config-store";
import type { TimelineProject } from "../src/types/timeline";
import type { GenerationTask } from "../src/services/api/task-center";

const timeline: TimelineProject = { version: 2, tracks: [{ id: "v", kind: "video", label: "画面", order: 0 }], clips: [{ id: "shot", nodeId: "node", trackId: "v", kind: "video", startMs: 0, durationMs: 1000, sourceDurationMs: 2000, directMedia: { id: "source", kind: "video", title: "镜头", storageKey: "resource:source" } }], durationMs: 1000 };
test("成片检查拒绝重叠、裁剪越界和未保存素材，隐藏轨道不参与检查", () => {
    expect(productionChecks(timeline)).toEqual([]);
    const invalid = { ...timeline, clips: [...timeline.clips, { ...timeline.clips[0], id: "overlap", sourceStartMs: 1500, directMedia: undefined }] };
    expect(productionChecks(invalid).length).toBe(3);
    expect(productionChecks({ ...invalid, tracks: [{ ...timeline.tracks[0], visible: false }] })).toEqual(["至少加入一个画面片段"]);
    expect(productionChecks({ ...timeline, clips: [{ ...timeline.clips[0], sourceStartMs: -1 }] })).toContain("“shot”的源起点无效");
    expect(productionChecks({ ...timeline, clips: [...timeline.clips, { ...timeline.clips[0], id: "voice", kind: "audio", startMs: 1000 }] })).toContain("时间线总时长小于片段范围");
});
test("时间线直连素材优先于已改变的画布，声音尊重静音和两端淡化", () => {
    expect(productionTimeline(timeline, []).clips[0].directMedia?.storageKey).toBe("resource:source");
    const audio = { ...timeline.clips[0], volume: 0.5, fadeInMs: 200, fadeOutMs: 200 };
    expect(timelineClipVolume(audio, 100)).toBeCloseTo(.25);
    expect(timelineClipVolume(audio, 900)).toBeCloseTo(.25);
    expect(timelineClipVolume({ ...audio, volume: 0 }, 500)).toBe(0);
    expect(timelineClipVolume(audio, 500, [{ ...timeline.tracks[0], muted: true }])).toBe(0);
});
test("断线恢复复用持久化的导出标识，保留其他镜头及历史成片", async () => {
    let run: CreationRun = { id: "run", userId: "user", revision: 1, executionEpoch: 0, executionOwner: "", status: "completed", state: { ...initialCreativeState(), media: [{ ref: "untouched", nodeId: "node", attempt: 1, status: "ready", storageKey: "resource:source" }], production: { enabled: true, timeline } }, createdAt: "", updatedAt: "" };
    const api = { ...creationRuns, get: async () => ({ run: structuredClone(run), submissions: [] }), claim: async (_id: string, input: { owner: string }) => run = { ...run, executionEpoch: run.executionEpoch + 1, executionOwner: input.owner, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }, save: async (_id: string, input: { revision: number; state: Record<string, unknown>; status: CreationRun["status"] }) => { if (input.revision !== run.revision) throw new Error("stale"); return run = { ...run, ...input, revision: run.revision + 1 }; }, release: async () => ({ released: true }) };
    const keys: string[] = [];
    let offline = true;
    let view: CreativeControllerView;
    const make = () => new CreativeAgentController({ config: () => defaultConfig, canvas: () => undefined, api, onOpenCanvas: () => undefined, onChange: (next) => view = next, renderTask: async (request) => { keys.push(request.clientKey!); if (offline) throw new Error("reply lost"); return { id: "render-task" } as GenerationTask; }, waitTask: async () => ({ id: "render-task", status: "succeeded", resultJson: JSON.stringify({ resourceId: "output", durationMs: 1000, size: 500 }) }) as GenerationTask });
    const first = make();
    await first.load("run");
    await expect(first.renderProduction()).rejects.toThrow("reply lost");
    expect((run.state.production as { renderKey: string }).renderKey).toBeTruthy();
    first.dispose();
    offline = false;
    const recovered = make();
    try {
        await recovered.load("run");
        await recovered.renderProduction();
        expect(keys[0]).toBe(keys[1]);
        expect(view!.state.media[0].attempt).toBe(1);
        expect(view!.state.production?.exports?.length).toBe(1);
        await recovered.saveProduction({ timeline: { ...timeline, durationMs: 1200 } });
        expect(view!.state.production?.result).toBeUndefined();
        expect(view!.state.production?.exports?.length).toBe(1);
    } finally { recovered.dispose(); }
});

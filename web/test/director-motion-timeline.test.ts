import { describe, expect, test } from "bun:test";
import type { DirectorScene } from "../src/types/director";
import { createDirectorDirection, evaluateDirectorMotion, retimeDirectorDirection, validateDirectorDirection } from "../src/lib/canvas/director/director-motion";
import { canonicalDirectorJson, compileDirectorTimeline, createDirectorProductionPackage, directorFrameToAudioSample, hashDirectorValue, resolveDirectorTimelineFrame } from "../src/lib/canvas/director/director-timeline";
import { createDirectorFrameReview, inspectDirectorFrames } from "../src/lib/canvas/director/director-frame-critic";

export function motionTestScene(): DirectorScene {
    return { id: "test-scene", version: 1, title: "Test", background: "#101820", environmentIntensity: 1, gridVisible: true, objects: [], cameras: [], lights: [], activeShotId: "S1", createdAt: "fixed", updatedAt: "fixed", shots: ["S1", "S2"].map((id) => ({ id, name: id, cameraId: "cam", duration: 5, fps: 30, shotSize: "medium", cameraMove: "static", prompt: "", direction: createDirectorDirection("object-relay", { intent: "解释交接", sourceAnchor: "把信息交给下一个对象。", audioCues: [{ id: `${id}-cue`, kind: "impact", frame: 81, gain: 0.1 }] }) })) };
}

describe("one frame timeline for visual, audio and QA", () => {
    test("anchored main event moves after editing its own shot while explicit cues remain fixed", () => {
        const scene = motionTestScene();
        scene.shots[0].direction!.audioCues.push({ id: "follow-contact", kind: "impact", frame: 81, gain: 0.1, anchor: "primary-impact" });
        scene.shots[0].duration = 6;
        const timeline = compileDirectorTimeline(scene);
        expect(timeline.audioCues.find((cue) => cue.id === "follow-contact")!.localFrame).toBe(97);
        expect(timeline.audioCues.find((cue) => cue.id === "S1-cue")!.localFrame).toBe(81);
        expect(scene.shots[0].direction!.audioCues[1].frame).toBe(81);
    });
    test("late stagger cannot silently omit necessary content and repair clears the blocker", () => {
        const scene = motionTestScene();
        const d = createDirectorDirection("kinetic-type", { intent: "依次解释", sourceAnchor: "六个必要概念", content: { title: "", labels: ["一", "二", "三", "四", "五", "六"] }, motion: { amplitude: 1, staggerFrames: 120, settleFrames: 14 } });
        scene.shots[0].direction = d;
        expect(evaluateDirectorMotion(d, 149, 150, 30).nodes[5].opacity).toBe(0);
        expect(inspectDirectorFrames(compileDirectorTimeline(scene)).some((i) => i.code === "CONTENT_INCOMPLETE" && i.severity === "error")).toBe(true);
        d.motion.staggerFrames = 8;
        expect(inspectDirectorFrames(compileDirectorTimeline(scene)).some((i) => i.code === "CONTENT_INCOMPLETE")).toBe(false);
    });
    test("adjacent shared shape uses the previous exit in every compiled preview without mutating authored data", () => {
        const scene = motionTestScene();
        scene.shots.forEach((s) => { s.direction = createDirectorDirection("continuous-shape-transition", { intent: "连续承接", sourceAnchor: "同一实体" }); });
        const authored = structuredClone(scene);
        const timeline = compileDirectorTimeline(scene);
        const exit = evaluateDirectorMotion(timeline.shots[0].direction!, 149, 150, 30).nodes[0];
        const entry = evaluateDirectorMotion(timeline.shots[1].direction!, 0, 150, 30).nodes[0];
        expect([entry.x, entry.y, entry.width, entry.height, entry.rotation]).toEqual([exit.x, exit.y, exit.width, exit.height, exit.rotation]);
        expect(scene).toEqual(authored);
        expect(inspectDirectorFrames(timeline).filter((i) => i.code === "CONTINUITY")).toEqual([]);
        timeline.shots[1].direction!.transition.sharedAnchor.x = 0.1;
        expect(inspectDirectorFrames(timeline).some((i) => i.code === "CONTINUITY")).toBe(true);
    });
    test("maximum authored delay stays valid through 24 to 30 fps conversion", () => {
        const d = createDirectorDirection("kinetic-type", { frameRate: 24, motion: { amplitude: 1, staggerFrames: 120, settleFrames: 120 } });
        expect(validateDirectorDirection(retimeDirectorDirection(d, 30))).toEqual([]);
    });
    test("24 fps authored cues and durations convert once into a 30 fps delivery", () => {
        const scene = motionTestScene();
        scene.shots[0].fps = 24;
        scene.shots[0].direction = createDirectorDirection("kinetic-type", { frameRate: 24, motion: { amplitude: 1, staggerFrames: 8, settleFrames: 12 }, audioCues: [{ id: "one-second", kind: "impact", frame: 24, gain: 0.1 }] });
        const timeline = compileDirectorTimeline(scene, 30);
        expect(timeline.audioCues[0].globalFrame).toBe(30);
        expect(timeline.shots[0].direction!.motion.settleFrames).toBe(15);
        expect(timeline.shots[0].direction!.frameRate).toBe(30);
        expect(scene.shots[0].direction.audioCues[0].frame).toBe(24);
    });
    test("half-open cut selects exactly one shot and cue shifts after editing duration", () => {
        const scene = motionTestScene();
        const before = compileDirectorTimeline(scene);
        expect(before.totalFrames).toBe(300);
        expect(resolveDirectorTimelineFrame(before, 149).shot.shotId).toBe("S1");
        expect(resolveDirectorTimelineFrame(before, 150).localFrame).toBe(0);
        scene.shots[0].duration = 6;
        const after = compileDirectorTimeline(scene);
        expect(after.shots[1].startFrame).toBe(180);
        expect(after.audioCues[1].globalFrame).toBe(before.audioCues[1].globalFrame + 30);
        expect(directorFrameToAudioSample(after.audioCues[1].globalFrame, 30, 48000)).toBe(417600);
        expect(() => resolveDirectorTimelineFrame(after, 330)).toThrow("区间");
    });
    test("subframe duration, duplicate IDs and beyond-end cues fail before export", () => {
        const scene = motionTestScene();
        scene.shots[0].duration = 0.001;
        expect(() => compileDirectorTimeline(scene)).toThrow("一帧");
        scene.shots[0].duration = 1;
        expect(() => compileDirectorTimeline(scene)).toThrow("末帧");
        scene.shots[0].duration = 5;
        scene.shots[1].id = "S1";
        expect(() => compileDirectorTimeline(scene)).toThrow("重复");
    });
    test("structured clone and JSON round trip preserve direction, reference, bindings and cue", async () => {
        const scene = motionTestScene();
        scene.shots[0].direction!.references = [{ caseId: "source", url: "https://example.com/source", review: "metadata" }];
        const copy = JSON.parse(JSON.stringify(structuredClone(scene))) as DirectorScene;
        expect(copy.shots[0].direction).toEqual(scene.shots[0].direction);
        copy.shots[0].direction!.content.labels[0] = "new";
        expect(scene.shots[0].direction!.content.labels[0]).toBe("输入");
        const pack = await createDirectorProductionPackage(scene);
        expect(pack.timeline.shots[0].prompt).toContain("解释交接");
        expect(pack.capabilities.comfyui.exactTrajectoryControl).toBe(false);
        expect(pack.provenance.sceneSha256).toHaveLength(64);
        expect(await hashDirectorValue({ b: 2, a: 1 })).toBe(await hashDirectorValue({ a: 1, b: 2 }));
        expect(canonicalDirectorJson({ b: undefined, a: 1 })).toBe('{"a":1}');
    });
    test("frame critic catches actual safe-area failure and proves only changed scene hash", async () => {
        const scene = motionTestScene();
        scene.shots[0].direction = createDirectorDirection("camera-push", { intent: "聚焦", sourceAnchor: "例句" });
        // A strong push crops the secondary context object; fix only this camera field.
        scene.shots[0].direction.camera.push = 0.5;
        const before = await createDirectorFrameReview(scene);
        const beforeIssue = before.issues.find((i) => i.code === "SAFE_AREA");
        expect(beforeIssue).toBeDefined();
        expect(beforeIssue!.globalFrame).toBeGreaterThanOrEqual(0);
        scene.shots[0].direction.camera.push = 0.12;
        const after = await createDirectorFrameReview(scene);
        expect(after.issues.filter((i) => i.code === "SAFE_AREA")).toEqual([]);
        expect(after.sceneSha256).not.toBe(before.sceneSha256);
        expect(after.coverage.humanListening).toBe("not-performed");
    });
    test("prop holder mismatch blocks continuity unless an explicit transition explains it", () => {
        const scene = motionTestScene();
        scene.shots[0].direction!.continuity.statesOut = { propHolder: "sender" };
        scene.shots[1].direction!.continuity.statesIn = { propHolder: "receiver" };
        expect(inspectDirectorFrames(compileDirectorTimeline(scene)).some((i) => i.code === "CONTINUITY")).toBe(true);
        scene.shots[1].direction!.continuity.reason = "镜头之间经过接收动作";
        expect(inspectDirectorFrames(compileDirectorTimeline(scene)).some((i) => i.code === "CONTINUITY")).toBe(false);
    });
});

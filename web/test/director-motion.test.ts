import { describe, expect, test } from "bun:test";
import { MOTION_PATTERN_IDS } from "../src/types/director-motion";
import { createDirectorDirection, evaluateDirectorMotion, motionSpring, renderDirectorMotionSvg, validateDirectorDirection } from "../src/lib/canvas/director/director-motion";

describe("motion grammar independent frame evaluation", () => {
    test.each(MOTION_PATTERN_IDS)("%s has actual motion, deterministic arbitrary seeks and finite geometry", (patternId) => {
        const direction = createDirectorDirection(patternId);
        const frames = Array.from({ length: 150 }, (_, f) => evaluateDirectorMotion(direction, f, 150, 30));
        for (const frame of [149, 1, 70, 0, 70, 48, 125, 9]) expect(evaluateDirectorMotion(direction, frame, 150, 30)).toEqual(frames[frame]);
        expect(frames[0].nodes).not.toEqual(frames[70].nodes);
        for (const state of frames) for (const node of state.nodes) expect([node.x, node.y, node.scaleX, node.scaleY, node.opacity].every(Number.isFinite)).toBe(true);
    });
    test("relay transfers a stable token and delays receiver response until contact", () => {
        const d = createDirectorDirection("object-relay");
        const a = evaluateDirectorMotion(d, 6, 150, 30);
        const b = evaluateDirectorMotion(d, 81, 150, 30);
        expect(a.nodes.find((n) => n.id === "token")!.x).toBeLessThan(0.39);
        expect(b.nodes.find((n) => n.id === "token")!.x).toBeCloseTo(0.62);
        expect(a.nodes.find((n) => n.id === "receiver")!.scaleX).toBe(1);
        expect(b.stage).toBe("impact");
    });
    test("camera delay changes focus independently from object animation", () => {
        const d = createDirectorDirection("camera-push", { camera: { push: 0.4, delayFrames: 20 } });
        expect(evaluateDirectorMotion(d, 10, 150, 30).camera.scale).toBe(1);
        expect(evaluateDirectorMotion(d, 120, 150, 30).camera.scale).toBeCloseTo(1.4);
    });
    test("type stagger establishes primary/secondary order", () => {
        const d = createDirectorDirection("kinetic-type", { motion: { amplitude: 1, staggerFrames: 20, settleFrames: 14 } });
        const frame = evaluateDirectorMotion(d, 18, 150, 30);
        expect(frame.nodes[0].opacity).toBeGreaterThan(0.5);
        expect(frame.nodes[1].opacity).toBe(0);
    });
    test("spring settles and cue only activates at its absolute frame", () => {
        const d = createDirectorDirection("impact-reveal", { audioCues: [{ id: "contact", kind: "impact", frame: 81, gain: 0.1 }] });
        expect(motionSpring(42, 14)).toBe(1);
        expect(evaluateDirectorMotion(d, 81, 150, 30).activeCueIds).toEqual(["contact"]);
        expect(evaluateDirectorMotion(d, 80, 150, 30).activeCueIds).toEqual([]);
    });
    test("external text cannot introduce SVG elements or attributes", () => {
        const d = createDirectorDirection("kinetic-type", { content: { title: '<script>alert("x")</script>', labels: ['<image onload="bad">'] } });
        const svg = renderDirectorMotionSvg(d, 40, 150, 30);
        expect(svg).not.toContain("<script");
        expect(svg).not.toContain("<image");
        expect(svg).toContain("&lt;script&gt;");
    });
    test("invalid imported physics, identity and color are rejected by field path", () => {
        const d = createDirectorDirection("object-relay");
        expect(validateDirectorDirection({ ...d, motion: { ...d.motion, amplitude: NaN } })).toContain("motion: 值无效");
        expect(validateDirectorDirection({ ...d, light: { ...d.light, keyColor: 'red"/>' } })).toContain("light: 值无效");
        expect(validateDirectorDirection({ ...d, subjectBindings: [{ objectId: "lead", role: "primary", sha256: "made-up" }] })).toContain("subjectBindings: 值无效");
        expect(() => evaluateDirectorMotion(d, NaN, 150, 30)).toThrow("timing");
        expect(validateDirectorDirection({ ...d, frameRate: "30" })).toContain("frameRate: 值无效");
    });
    test("diagram only draws declared relations and rotating shapes keep labels upright", () => {
        const d = createDirectorDirection("diagram-morph");
        expect(evaluateDirectorMotion(d, 149, 150, 30).edges).toEqual([]);
        d.content.relations = [{ from: 0, to: 2 }];
        expect(evaluateDirectorMotion(d, 149, 150, 30).edges.map((e) => [e.from, e.to])).toEqual([["entity-0", "entity-2"]]);
        const svg = renderDirectorMotionSvg(createDirectorDirection("continuous-shape-transition"), 149, 150, 30);
        expect(svg).toContain('transform="rotate(180)"');
        expect(svg).not.toContain('scale(1 1) rotate(180)');
    });
});

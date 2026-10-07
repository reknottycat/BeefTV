import { describe, expect, test } from "bun:test";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";
import { createDirectorDirection, validateDirectorDirection } from "@/lib/canvas/director/director-direction";
import { compileDirectorPrompt } from "@/lib/canvas/director/director-prompt-compiler";
import { compileDirectorTimeline, createDirectorProductionPackage, hashDirectorValue } from "@/lib/canvas/director/director-timeline";

describe("导演镜头方案交付", () => {
    test("动作与连续性进入真实生成提示词，保留主线机位关键帧", () => {
        const scene = createDirectorScene("两人交接");
        const camera = scene.cameras[0];
        camera.keyframes = [0, 2].map((time) => ({ id: String(time), time, transform: { ...camera.transform, position: [time, 1, 3] } }));
        const direction = createDirectorDirection();
        direction.action.verb = "甲把信交给乙";
        direction.continuity.statesOut = "乙右手持信";
        scene.shots[0].direction = direction;
        const prompt = compileDirectorPrompt(scene, scene.shots[0]);
        expect(prompt).toContain("甲把信交给乙");
        expect(prompt).toContain("乙右手持信");
        expect(prompt).toContain("2 个关键帧");
        expect(prompt).not.toContain("固定机位");
        expect(prompt).not.toContain("未填写");
    });

    test("失效机位、重复镜头与超过时长的节奏不能交付", () => {
        const scene = createDirectorScene("校验");
        const shot = scene.shots[0];
        expect(() => compileDirectorTimeline({ ...scene, shots: [shot, shot] })).toThrow("重复");
        expect(() => compileDirectorTimeline({ ...scene, cameras: [] })).toThrow("摄影机不存在");
        shot.direction = createDirectorDirection();
        shot.direction.motion.settleMs = 10000;
        expect(() => compileDirectorTimeline(scene)).toThrow("不得超过镜头时长");
        expect(validateDirectorDirection({ schemaVersion: 1, action: null })).not.toHaveLength(0);
    });

    test("交付按镜头顺序使用同一时钟，包含素材引用与完整提示词", async () => {
        const scene = createDirectorScene("双镜头");
        scene.shots = [{ ...scene.shots[0], id: "s2", duration: 1.5, prompt: "先看门口" }, { ...scene.shots[0], id: "s1", duration: 2, prompt: "再看信封" }];
        const bundle = await createDirectorProductionPackage(scene, 24);
        expect(bundle.shotOrder).toEqual(["s2", "s1"]);
        expect(bundle.timeline.shots.map((shot) => [shot.startFrame, shot.endFrame])).toEqual([[0, 36], [36, 84]]);
        expect(bundle.timeline.shots[1].prompt).toContain("再看信封");
        expect(bundle.cameras).toEqual(scene.cameras);
        expect(bundle.capability.exactTrajectoryControl).toBe(false);
        expect(bundle.provenance.sceneSha256).toBe(await hashDirectorValue(bundle.scene));
        expect(bundle.provenance.timelineSha256).toBe(await hashDirectorValue(bundle.timeline));
    });

    test("哈希与交付快照不受异步期间的编辑或对象键顺序影响", async () => {
        expect(await hashDirectorValue({ b: 2, a: 1 })).toBe(await hashDirectorValue({ a: 1, b: 2 }));
        const scene = createDirectorScene("冻结");
        scene.shots[0].prompt = "批准的镜头";
        const pending = createDirectorProductionPackage(scene);
        scene.shots[0].prompt = "后来修改的镜头";
        const bundle = await pending;
        expect(bundle.scene.shots[0].prompt).toBe("批准的镜头");
        expect(bundle.timeline.shots[0].prompt).toContain("批准的镜头");
    });
});

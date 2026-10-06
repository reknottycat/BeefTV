import { describe, expect, test } from "bun:test";

import { FIRST_MOTION_PATTERN_IDS, lookupMotionPattern, MOTION_PATTERNS, motionPatternStatusCounts } from "@/lib/canvas/director/motion-pattern-catalog";
import { lookupMotionReference, MOTION_REFERENCE_SOURCE } from "@/lib/canvas/director/motion-reference";
import { createDirectorDirection, validateDirectorDirection } from "@/lib/canvas/director/director-motion";

describe("动效模式编目", () => {
    test("36 条六模式族，每条有真实固定来源及完整导演字段", () => {
        expect(MOTION_PATTERNS).toHaveLength(36);
        expect(new Set(MOTION_PATTERNS.map((pattern) => pattern.id)).size).toBe(36);
        expect(new Set(MOTION_PATTERNS.map((pattern) => pattern.family)).size).toBe(6);
        for (const pattern of MOTION_PATTERNS) {
            expect(pattern.references.length).toBeGreaterThan(0);
            expect(pattern.purpose.length).toBeGreaterThan(0);
            expect(pattern.slots.length).toBeGreaterThan(0);
            expect(pattern.composition.length).toBeGreaterThan(0);
            expect(pattern.qa.length).toBeGreaterThan(0);
            expect(pattern.transition.conflicts.length).toBeGreaterThan(0);
            expect(pattern.parameters.every((parameter) => parameter.defaultValue >= parameter.min && parameter.defaultValue <= parameter.max)).toBe(true);
            for (const reference of pattern.references) {
                expect(lookupMotionReference(reference.caseId)?.source.url).toBe(reference.url);
                expect(reference.sourceCommit).toBe(MOTION_REFERENCE_SOURCE.commit);
                expect(reference.relationship).toBe("candidate_reference");
                expect(["metadata_only", "static_frame_reviewed"]).toContain(reference.reviewState);
                if (reference.reviewState === "metadata_only") expect(reference.segment).toBeNull();
                else expect(reference.segment!.toSeconds).toBeGreaterThan(reference.segment!.fromSeconds);
            }
        }
    });

    test("首批六执行器 ID 与合同一致，其他模式保留未实现状态", () => {
        expect(FIRST_MOTION_PATTERN_IDS).toEqual(["object-relay", "camera-push", "kinetic-type", "diagram-morph", "impact-reveal", "continuous-shape-transition"]);
        for (const pattern of MOTION_PATTERNS) {
            if (FIRST_MOTION_PATTERN_IDS.some((id) => id === pattern.id)) {
                expect(pattern.executor.id).toBe(pattern.id);
                expect(pattern.status).toBe("runtime_verified");
                expect(pattern.evidence.implementation).toContain("evaluateDirectorMotion");
                expect(pattern.evidence.runtime).toBe("docs/motion-director-validation.md#rendered-patterns");
                expect(pattern.preview.state).toBe("local-delivery");
                expect(pattern.preview.artifactRelativePath).toBe(`disposable/motion-director-demo/output/${pattern.id}-v1.0.1.mp4`);
            }
            else {
                expect(pattern.status).toBe("catalogued");
                expect(pattern.executor.id).toBeNull();
                expect(pattern.evidence.implementation).toBeNull();
                expect(pattern.evidence.runtime).toBeNull();
                expect(pattern.preview.state).toBe("pending");
            }
            expect(pattern.evidence.humanReview).toBeNull();
            expect(pattern.evidence.userApproval).toBeNull();
        }
        const counts = motionPatternStatusCounts();
        expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(36);
        expect(counts).toEqual({ catalogued: 30, implemented: 0, runtime_verified: 6, user_approved: 0 });
        expect(counts.user_approved).toBe(0);
        expect(lookupMotionPattern("invalid-pattern")).toBeUndefined();
    });

    test("编目帧参数以30fps为参考，5秒边界换算后与核心校验一致", () => {
        const pattern = lookupMotionPattern("camera-push")!;
        for (const frameRate of [24, 25, 30] as const) {
            const direction = createDirectorDirection("camera-push", { frameRate });
            const framesAtRate = (id: string) => Math.round(pattern.parameters.find((parameter) => parameter.id === id)!.max * frameRate / pattern.parameterTimebase.referenceFps);
            direction.motion.staggerFrames = framesAtRate("motion.staggerFrames");
            direction.motion.settleFrames = framesAtRate("motion.settleFrames");
            direction.camera.delayFrames = framesAtRate("camera.delayFrames");
            direction.readableHoldFrames = framesAtRate("readableHoldFrames");
            expect(validateDirectorDirection(direction)).toEqual([]);
            direction.motion.staggerFrames++;
            expect(validateDirectorDirection(direction)).toContain("motion: 值无效");
        }
    });
});

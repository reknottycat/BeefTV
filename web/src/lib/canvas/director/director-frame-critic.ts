import type { DirectorScene } from "../../../types/director";
import type { DirectorDirection, MotionNode } from "../../../types/director-motion";
import { directorMotionTiming, evaluateDirectorMotion } from "./director-motion";
import { compileDirectorTimeline, hashDirectorValue, type DirectorTimeline } from "./director-timeline";

export type DirectorFrameIssue = {
    code: "SAFE_AREA" | "TEXT_CAPACITY" | "READING_HOLD" | "CONTENT_INCOMPLETE" | "CONTINUITY" | "SUBJECT_BINDING" | "MISSING_INTENT";
    severity: "error" | "warning";
    shotId: string;
    localFrame: number;
    globalFrame: number;
    field: string;
    message: string;
};

/** Geometric check covers the rendered camera transform; text capacity is only a heuristic. */
function nodeBounds(node: MotionNode, camera: { scale: number; x: number; y: number }) {
    const angle = (node.rotation * Math.PI) / 180;
    const width = node.width * Math.abs(node.scaleX);
    const height = node.height * Math.abs(node.scaleY);
    const aspect = 1280 / 720;
    const halfX = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height / aspect) * camera.scale / 2;
    const halfY = (Math.abs(Math.sin(angle)) * width * aspect + Math.abs(Math.cos(angle)) * height) * camera.scale / 2;
    const x = (node.x - 0.5) * camera.scale + 0.5 + camera.x;
    const y = (node.y - 0.5) * camera.scale + 0.5 + camera.y;
    return { left: x - halfX, right: x + halfX, top: y - halfY, bottom: y + halfY };
}

export function inspectDirectorFrames(timeline: DirectorTimeline, scene?: DirectorScene): DirectorFrameIssue[] {
    const issues: DirectorFrameIssue[] = [];
    const seen = new Set<string>();
    const report = (issue: DirectorFrameIssue) => {
        const key = `${issue.shotId}:${issue.code}:${issue.field}`;
        if (!seen.has(key)) { seen.add(key); issues.push(issue); }
    };
    let previous: { direction: DirectorDirection; shotId: string } | undefined;
    for (const shot of timeline.shots) {
        const d = shot.direction;
        if (!d) { previous = undefined; continue; }
        const base = { shotId: shot.shotId, localFrame: 0, globalFrame: shot.startFrame };
        if (!d.intent.trim() || !d.sourceAnchor.trim()) report({ ...base, code: "MISSING_INTENT", severity: "warning", field: "direction.intent", message: "未填写观看意图或原句，内容审看仍需补齐" });
        const lastMotionFrame = directorMotionTiming(d, shot.durationFrames, timeline.fps).complete;
        if (lastMotionFrame >= shot.durationFrames) report({ ...base, localFrame: shot.durationFrames - 1, globalFrame: shot.endFrame - 1, code: "CONTENT_INCOMPLETE", severity: "error", field: "direction.motion", message: "镜头结束时仍有必要内容未完成出现或运动；缩短逐项延迟、回稳时间，或延长镜头" });
        if (shot.durationFrames - lastMotionFrame < d.readableHoldFrames) report({ ...base, code: "READING_HOLD", severity: "warning", field: "direction.readableHoldFrames", message: "运动结束后的阅读停留不足；按实际语音与可读性调整镜长或回稳时间" });
        if (previous && !d.continuity.reason.trim()) {
            for (const [key, state] of Object.entries(d.continuity.statesIn)) {
                const last = previous.direction.continuity.statesOut[key];
                if (last !== undefined && last !== state) report({ ...base, code: "CONTINUITY", severity: "error", field: `direction.continuity.statesIn.${key}`, message: `上镜 ${previous.shotId} 的终态“${last}”与本镜初态“${state}”不同，缺少承接原因` });
            }
        }
        if (previous?.direction.patternId === "continuous-shape-transition" && d.patternId === previous.direction.patternId && previous.direction.transition.sharedElementId === d.transition.sharedElementId) {
            const exit = previous.direction.transition.exitAnchor;
            const entry = d.transition.sharedAnchor;
            if (Object.keys(exit).some((key) => Math.abs(exit[key as keyof typeof exit] - entry[key as keyof typeof entry]) > 0.000001)) report({ ...base, code: "CONTINUITY", severity: "error", field: "direction.transition.sharedAnchor", message: "连续转场的共享主体入口与前镜出口不一致" });
        }
        if (scene) for (const binding of d.subjectBindings) {
            const subject = scene.objects.find((o) => o.id === binding.objectId);
            if (!subject || (binding.assetId && subject.assetId !== binding.assetId)) report({ ...base, code: "SUBJECT_BINDING", severity: "error", field: "direction.subjectBindings", message: `主体 ${binding.objectId} 缺失或资产绑定与场景不一致` });
        }
        for (let frame = 0; frame < shot.durationFrames; frame += 1) {
            const state = evaluateDirectorMotion(d, frame, shot.durationFrames, timeline.fps);
            for (const node of state.nodes) {
                if (node.opacity < 0.2) continue;
                const bounds = nodeBounds(node, state.camera);
                if (bounds.left < 0.03 || bounds.right > 0.97 || bounds.top < 0.2 || bounds.bottom > 0.88) report({ ...base, localFrame: frame, globalFrame: shot.startFrame + frame, code: "SAFE_AREA", severity: "error", field: `direction.content.${node.id}`, message: `对象 ${node.id} 进入标题或字幕安全区；检查幅度、标签数量和相机推进` });
                if (Array.from(node.label).length > (node.kind === "text" ? 26 : 12)) report({ ...base, localFrame: frame, globalFrame: shot.startFrame + frame, code: "TEXT_CAPACITY", severity: "warning", field: `direction.content.${node.id}`, message: `对象 ${node.id} 文字密度偏高；需检查真实字体排版，不能用此估算替代阅读审看` });
            }
        }
        previous = { direction: d, shotId: shot.shotId };
    }
    return issues;
}

export async function createDirectorFrameReview(scene: DirectorScene, fps = 30) {
    const timeline = compileDirectorTimeline(scene, fps);
    const issues = inspectDirectorFrames(timeline, scene);
    return {
        schema: "beeftv-motion-review-v1", sceneSha256: await hashDirectorValue(scene), timelineSha256: await hashDirectorValue(timeline),
        coverage: { geometricFrames: timeline.shots.filter((s) => s.direction).reduce((n, s) => n + s.durationFrames, 0), totalFrames: timeline.totalFrames, contentReview: "not-performed", humanListening: "not-performed" },
        technicalStatus: issues.some((i) => i.severity === "error") ? "failed" : "passed", issues,
    };
}

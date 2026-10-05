import type { DirectorScene } from "../../../types/director";
import type { DirectorDirection, DirectorAudioCue } from "../../../types/director-motion";
import { directorMotionTiming, MOTION_PATTERN_LABELS, retimeDirectorDirection, validateDirectorDirection } from "./director-motion";

export type DirectorTimelineShot = {
    shotId: string;
    startFrame: number;
    endFrame: number;
    durationFrames: number;
    direction?: DirectorDirection;
    prompt: string;
};
export type DirectorTimeline = {
    schemaVersion: 1;
    sceneId: string;
    fps: number;
    totalFrames: number;
    shots: DirectorTimelineShot[];
    audioCues: (DirectorAudioCue & { shotId: string; localFrame: number; globalFrame: number })[];
};

export function compileDirectionPrompt(direction: DirectorDirection) {
    const errors = validateDirectorDirection(direction);
    if (errors.length) throw new Error(errors.join("；"));
    return [
        `导演意图：${direction.intent || "未填写"}；原句：${direction.sourceAnchor || "未填写"}；焦点：${direction.focus}；情绪：${direction.emotion}。`,
        `动效模式：${MOTION_PATTERN_LABELS[direction.patternId]} (${direction.patternId}@${direction.patternVersion})。`,
        `画面文字：${[direction.content.title, ...direction.content.labels].filter(Boolean).join(" / ")}。准确文字由合成层制作。`,
        `主体行动：初态 ${direction.action.initial || "未填写"}；动作 ${direction.action.verb || "未填写"}；终态 ${direction.action.final || "未填写"}；可见变化 ${direction.action.observableChange || "未填写"}。`,
        direction.content.relations?.length ? `已声明关系：${direction.content.relations.map((edge) => `${direction.content.labels[edge.from]}→${direction.content.labels[edge.to]}`).join("；")}。仅绘制这些关系。` : "没有声明连线关系，不自动添加因果关系。",
        `运动语法：预备→主动作→接触或变化→回稳；幅度 ${direction.motion.amplitude}，次主体间隔 ${direction.motion.staggerFrames} 帧，回稳时间 ${direction.motion.settleFrames} 帧。`,
        `相机响应：推进 ${direction.camera.push}，滞后 ${direction.camera.delayFrames} 帧；不以运镜代替主体动作。`,
        `连续性初态：${JSON.stringify(direction.continuity.statesIn)}；终态：${JSON.stringify(direction.continuity.statesOut)}；承接理由：${direction.continuity.reason || "保持已声明状态"}。`,
        direction.subjectBindings.length ? `主体资产绑定：${direction.subjectBindings.map((b) => `${b.objectId} ${b.assetId || "未绑定资产"} ${b.sha256 || "未记录哈希"}`).join("；")}。` : "",
        direction.references.length ? `参考：${direction.references.map((r) => `${r.caseId} ${r.url} (${r.review})`).join("；")}。参考用于导演结构，不替代真实身份资产。` : "",
    ].filter(Boolean).join("\n");
}

/** A frame rate is fixed once for the entire delivery; legacy shot seconds convert here only. */
export function compileDirectorTimeline(scene: DirectorScene, fps = 30): DirectorTimeline {
    if (![24, 25, 30].includes(fps)) throw new Error("timeline.fps: 必须为 24、25 或 30");
    if (!scene.shots.length) throw new Error("timeline.shots: 缺少镜头");
    const ids = new Set<string>();
    let cursor = 0;
    let previousDirection: DirectorDirection | undefined;
    const audioCues: DirectorTimeline["audioCues"] = [];
    const shots = scene.shots.map((shot): DirectorTimelineShot => {
        if (!shot.id || ids.has(shot.id)) throw new Error(`shots.${shot.id}.id: 重复或为空`);
        ids.add(shot.id);
        if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 3600) throw new Error(`shots.${shot.id}.duration: 时长无效`);
        const durationFrames = Math.round(shot.duration * fps);
        if (durationFrames < 1) throw new Error(`shots.${shot.id}.duration: 小于一帧`);
        const direction = shot.direction ? retimeDirectorDirection(shot.direction, fps) : undefined;
        // Shared identity inherits the previous exit, in compiled data only; authoring state stays intact.
        if (direction?.patternId === "continuous-shape-transition" && previousDirection?.patternId === direction.patternId && previousDirection.transition.sharedElementId === direction.transition.sharedElementId) {
            direction.transition.sharedAnchor = structuredClone(previousDirection.transition.exitAnchor);
        }
        if (direction) {
            direction.audioCues = direction.audioCues.map((cue) => cue.anchor === "primary-impact" ? { ...cue, frame: directorMotionTiming(direction, durationFrames, fps).impact } : cue);
            const errors = validateDirectorDirection(shot.direction);
            if (errors.length) throw new Error(`shots.${shot.id}.${errors.join("；")}`);
            for (const cue of direction.audioCues) {
                if (cue.frame >= durationFrames) throw new Error(`shots.${shot.id}.audioCues.${cue.id}: 越过镜头末帧`);
                audioCues.push({ ...cue, shotId: shot.id, localFrame: cue.frame, globalFrame: cursor + cue.frame });
            }
        }
        const entry = { shotId: shot.id, startFrame: cursor, endFrame: cursor + durationFrames, durationFrames, direction, prompt: [shot.prompt, direction ? compileDirectionPrompt(direction) : ""].filter(Boolean).join("\n") };
        cursor += durationFrames;
        previousDirection = direction;
        return entry;
    });
    return { schemaVersion: 1, sceneId: scene.id, fps, totalFrames: cursor, shots, audioCues: audioCues.toSorted((a, b) => a.globalFrame - b.globalFrame) };
}

export function resolveDirectorTimelineFrame(timeline: DirectorTimeline, frame: number) {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= timeline.totalFrames) throw new Error("timeline.frame: 超出交付帧区间");
    const shot = timeline.shots.find((s) => frame >= s.startFrame && frame < s.endFrame);
    if (!shot) throw new Error("timeline.frame: 时间线存在断层");
    return { shot, localFrame: frame - shot.startFrame };
}

export function directorFrameToAudioSample(frame: number, fps: number, sampleRate: number) {
    if (!Number.isSafeInteger(frame) || frame < 0 || ![24, 25, 30].includes(fps) || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("timeline.audioClock: 参数无效");
    return Math.round((frame * sampleRate) / fps);
}

export function canonicalDirectorJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalDirectorJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${canonicalDirectorJson(v)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

export async function hashDirectorValue(value: unknown) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalDirectorJson(value)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Scene, timeline and export are bound; generated provider output still needs its own QA. */
export async function createDirectorProductionPackage(scene: DirectorScene, fps = 30) {
    const timeline = compileDirectorTimeline(scene, fps);
    return {
        schema: "beeftv-motion-production-v1", scene: structuredClone(scene), timeline,
        provenance: { sceneSha256: await hashDirectorValue(scene), timelineSha256: await hashDirectorValue(timeline) },
        shotOrder: timeline.shots.map((s) => s.shotId),
        cameras: structuredClone(scene.cameras), assets: scene.objects.map((o) => ({ objectId: o.id, assetId: o.assetId, storageKey: o.storageKey, url: o.url })),
        capabilities: {
            remotion: { mode: "deterministic-frame-evaluation", renderer: "tools/motion_director" },
            runninghub: { mode: "prompt-and-reference-handoff", exactTrajectoryControl: false, submission: "existing-workflow" },
            comfyui: { mode: "prompt-and-reference-handoff", exactTrajectoryControl: false, submission: "existing-workflow" },
            hyperframes: { mode: "not-verified" },
        },
    };
}

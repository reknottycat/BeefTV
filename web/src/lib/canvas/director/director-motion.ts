import { MOTION_PATTERN_IDS, type DirectorDirection, type DirectorMotionAnchor, type MotionFrame, type MotionNode, type MotionPatternId } from "../../../types/director-motion";

export const MOTION_PATTERN_LABELS: Record<MotionPatternId, string> = {
    "object-relay": "对象交接", "camera-push": "镜头聚焦", "kinetic-type": "语义文字",
    "diagram-morph": "关系变形", "impact-reveal": "冲击揭示", "continuous-shape-transition": "形状连续转场",
};

export function createDirectorDirection(patternId: MotionPatternId, patch: Partial<DirectorDirection> = {}): DirectorDirection {
    return {
        schemaVersion: 1, patternId, patternVersion: "1.0.0", frameRate: 30, intent: "", sourceAnchor: "", emotion: "清晰、克制", focus: "主体",
        action: { initial: "", verb: "", final: "", observableChange: "" },
        content: { title: "", labels: ["输入", "处理", "结果"], relations: [] },
        motion: { amplitude: 1, staggerFrames: 8, settleFrames: 14 }, camera: { push: 0.12, delayFrames: 8 },
        light: { keyColor: "#91b8cc", background: "#101820" },
        audioCues: [], continuity: { statesIn: {}, statesOut: {}, reason: "" }, references: [],
        transition: { sharedElementId: "shared-shape", sharedAnchor: { x: 0.28, y: 0.53, width: 0.11, height: 0.11, rotation: 0 }, exitAnchor: { x: 0.7, y: 0.53, width: 0.23, height: 0.23, rotation: 180 } },
        timingStatus: "estimated", readableHoldFrames: 24, seed: 1, subjectBindings: [], ...patch,
    };
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const integer = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const numeric = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown) => typeof v === "string" && v.length <= 10000;
const hexColor = (v: unknown) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const states = (v: unknown) => record(v) && Object.entries(v).every(([k, value]) => text(k) && text(value));
const anchor = (v: unknown) => record(v) && numeric(v.x, 0, 1) && numeric(v.y, 0, 1) && numeric(v.width, 0.01, 0.9) && numeric(v.height, 0.01, 0.9) && numeric(v.rotation, -360, 360);

/** Errors have stable field paths so imported data can be repaired in the editor. */
export function validateDirectorDirection(value: unknown): string[] {
    if (!record(value)) return ["direction: 缺少导演决定"];
    const errors: string[] = [];
    const check = (ok: boolean, field: string) => { if (!ok) errors.push(`${field}: 值无效`); };
    check(value.schemaVersion === 1, "schemaVersion");
    check(MOTION_PATTERN_IDS.includes(value.patternId as MotionPatternId), "patternId");
    check(value.patternVersion === "1.0.0", "patternVersion");
    check(typeof value.frameRate === "number" && [24, 25, 30].includes(value.frameRate), "frameRate");
    for (const key of ["intent", "sourceAnchor", "emotion", "focus"]) check(text(value[key]), key);
    check(record(value.action) && ["initial", "verb", "final", "observableChange"].every((key) => text((value.action as Record<string, unknown>)[key])), "action");
    check(record(value.content) && text(value.content.title) && Array.isArray(value.content.labels) && value.content.labels.length >= 1 && value.content.labels.length <= 6 && value.content.labels.every(text), "content");
    if (record(value.content) && value.content.relations !== undefined) check(Array.isArray(value.content.relations) && value.content.relations.every((edge) => record(edge) && integer(edge.from, 0, (value.content as { labels: unknown[] }).labels?.length - 1) && integer(edge.to, 0, (value.content as { labels: unknown[] }).labels?.length - 1) && edge.from !== edge.to), "content.relations");
    const authoredFps = typeof value.frameRate === "number" ? value.frameRate : 30;
    check(record(value.motion) && numeric(value.motion.amplitude, 0, 2) && integer(value.motion.staggerFrames, 0, authoredFps * 5) && integer(value.motion.settleFrames, 1, authoredFps * 5), "motion");
    check(record(value.camera) && numeric(value.camera.push, 0, 0.5) && integer(value.camera.delayFrames, 0, authoredFps * 5), "camera");
    check(record(value.light) && hexColor(value.light.keyColor) && hexColor(value.light.background), "light");
    check(Array.isArray(value.audioCues) && value.audioCues.every((cue) => record(cue) && text(cue.id) && ["whoosh", "impact", "settle"].includes(String(cue.kind)) && integer(cue.frame, 0, 1000000) && numeric(cue.gain, 0, 1) && (cue.anchor === undefined || cue.anchor === "primary-impact")), "audioCues");
    if (Array.isArray(value.audioCues)) check(new Set(value.audioCues.map((cue) => record(cue) ? cue.id : "")).size === value.audioCues.length, "audioCues.id");
    check(record(value.continuity) && states(value.continuity.statesIn) && states(value.continuity.statesOut) && text(value.continuity.reason), "continuity");
    check(record(value.transition) && text(value.transition.sharedElementId) && anchor(value.transition.sharedAnchor) && anchor(value.transition.exitAnchor), "transition");
    check(Array.isArray(value.references) && value.references.every((ref) => record(ref) && text(ref.caseId) && typeof ref.url === "string" && /^https?:\/\//.test(ref.url) && ["metadata", "frames", "motion", "reproduced"].includes(String(ref.review)) && (ref.startSeconds === undefined || numeric(ref.startSeconds, 0, 100000)) && (ref.endSeconds === undefined || (numeric(ref.endSeconds, 0, 100000) && typeof ref.startSeconds === "number" && Number(ref.endSeconds) > ref.startSeconds))), "references");
    check(["estimated", "voice_locked"].includes(String(value.timingStatus)), "timingStatus");
    check(integer(value.readableHoldFrames, 0, authoredFps * 3600), "readableHoldFrames");
    check(integer(value.seed, 0, 2147483647), "seed");
    check(Array.isArray(value.subjectBindings) && value.subjectBindings.every((binding) => record(binding) && text(binding.objectId) && ["primary", "secondary"].includes(String(binding.role)) && (binding.assetId === undefined || text(binding.assetId)) && (binding.sha256 === undefined || (typeof binding.sha256 === "string" && /^[a-f0-9]{64}$/i.test(binding.sha256)))), "subjectBindings");
    return errors;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const p = clamp(v); return p * p * (3 - 2 * p); };
const mix = (a: number, b: number, p: number) => a + (b - a) * p;

/** Absolute-time damped response: no frame history, timers, or random state. */
export function motionSpring(frame: number, settleFrames: number) {
    if (frame <= 0) return 0;
    const t = frame / Math.max(1, settleFrames);
    if (t >= 3) return 1;
    return 1 - Math.exp(-4 * t) * Math.cos(9 * t);
}

export function retimeDirectorDirection(direction: DirectorDirection, fps: number): DirectorDirection {
    if (![24, 25, 30].includes(fps)) throw new Error("direction.frameRate: 交付帧率无效");
    const errors = validateDirectorDirection(direction);
    if (errors.length) throw new Error(errors.join("；"));
    if (fps === direction.frameRate) return structuredClone(direction);
    const scale = fps / direction.frameRate;
    const frame = (v: number) => Math.round(v * scale);
    return { ...structuredClone(direction), frameRate: fps as 24 | 25 | 30,
        motion: { ...direction.motion, staggerFrames: frame(direction.motion.staggerFrames), settleFrames: Math.max(1, frame(direction.motion.settleFrames)) },
        camera: { ...direction.camera, delayFrames: frame(direction.camera.delayFrames) },
        readableHoldFrames: frame(direction.readableHoldFrames), audioCues: direction.audioCues.map((cue) => ({ ...cue, frame: frame(cue.frame) })),
    };
}

/** Completion is computed from the same delays that drive the visible content. */
export function directorMotionTiming(direction: DirectorDirection, durationFrames: number, fps: number) {
    const anticipationEnd = Math.min(Math.round(fps * 0.22), Math.max(1, Math.floor(durationFrames * 0.1)));
    const impact = Math.max(anticipationEnd + 1, Math.min(Math.round(durationFrames * 0.54), durationFrames - 1));
    const lastStagger = Math.max(0, direction.content.labels.length - 1) * direction.motion.staggerFrames;
    let complete: number;
    switch (direction.patternId) {
        case "kinetic-type": complete = anticipationEnd + lastStagger + 3 * direction.motion.settleFrames; break;
        case "diagram-morph": complete = impact + lastStagger; break;
        case "camera-push": complete = Math.max(anticipationEnd + 3 * direction.motion.settleFrames, direction.camera.delayFrames + impact); break;
        case "continuous-shape-transition": complete = impact; break;
        default: complete = impact + 3 * direction.motion.settleFrames;
    }
    return { anticipationEnd, impact, complete };
}

export function evaluateDirectorMotion(direction: DirectorDirection, localFrame: number, durationFrames: number, fps: number): MotionFrame {
    const errors = validateDirectorDirection(direction);
    if (errors.length) throw new Error(errors.join("；"));
    if (!integer(durationFrames, 1, 1000000) || !numeric(fps, 1, 120) || !Number.isFinite(localFrame)) throw new Error("motion.timing: 帧或时钟无效");
    direction = retimeDirectorDirection(direction, fps);
    const frame = Math.max(0, Math.min(durationFrames - 1, Math.floor(localFrame)));
    const { anticipationEnd, impact, complete } = directorMotionTiming(direction, durationFrames, fps);
    const action = smooth((frame - anticipationEnd) / Math.max(1, impact - anticipationEnd));
    const settle = motionSpring(frame - impact, direction.motion.settleFrames);
    const { amplitude, staggerFrames } = direction.motion;
    const labels = direction.content.labels;
    const nodes: MotionNode[] = [];
    const edges: MotionFrame["edges"] = [];
    const add = (id: string, x: number, y: number, label: string, patch: Partial<MotionNode> = {}) => {
        nodes.push({ id, kind: "box", x, y, width: 0.19, height: 0.12, scaleX: 1, scaleY: 1, opacity: 1, rotation: 0, label, color: direction.light.keyColor, ...patch });
    };
    let camera = { scale: 1, x: 0, y: 0 };
    switch (direction.patternId) {
        case "object-relay": {
            const kick = frame < anticipationEnd ? Math.sin((frame / Math.max(1, anticipationEnd)) * Math.PI) * -0.025 * amplitude : 0;
            add("sender", 0.2, 0.55, labels[0] || "");
            add("receiver", 0.8, 0.55, labels[1] || "", { scaleX: 1 + (settle - 1) * 0.1 * amplitude * Number(frame >= impact) });
            add("token", mix(0.38 + kick, 0.62, action), 0.55 - Math.sin(action * Math.PI) * 0.12 * amplitude, labels[2] || "", { kind: "circle", width: 0.09, height: 0.09, scaleX: 1 + Math.sin(action * Math.PI) * 0.3 * amplitude, scaleY: 1 - Math.sin(action * Math.PI) * 0.15 * amplitude });
            break;
        }
        case "camera-push": {
            add("context", 0.27, 0.57, labels[0] || "", { opacity: 0.55 });
            add("subject", 0.65, 0.5, labels[1] || labels[0], { width: 0.23, height: 0.16, scaleX: 1 + (motionSpring(frame - anticipationEnd, direction.motion.settleFrames) - 1) * 0.08 * amplitude });
            const push = smooth((frame - direction.camera.delayFrames) / Math.max(1, impact));
            camera = { scale: 1 + direction.camera.push * push, x: -0.15 * direction.camera.push * push, y: 0 };
            break;
        }
        case "kinetic-type": {
            labels.forEach((label, index) => {
                const p = motionSpring(frame - anticipationEnd - index * staggerFrames, direction.motion.settleFrames);
                add(`word-${index}`, 0.5, 0.35 + index * Math.min(0.1, 0.45 / labels.length) + (1 - p) * 0.05 * amplitude, label, { kind: "text", width: 0.75, height: 0.065, opacity: clamp(p), scaleX: 1 + (p - 1) * 0.15 * amplitude, scaleY: 1 + (p - 1) * 0.15 * amplitude });
            });
            break;
        }
        case "diagram-morph": {
            labels.forEach((label, index) => {
                const p = smooth((frame - anticipationEnd - index * staggerFrames) / Math.max(1, impact - anticipationEnd));
                const angle = (index / labels.length) * Math.PI * 2 - Math.PI / 2;
                add(`entity-${index}`, mix(0.2 + (index / Math.max(1, labels.length - 1)) * 0.6, 0.5 + Math.cos(angle) * 0.26, p), mix(0.54, 0.56 + Math.sin(angle) * 0.2, p), label, { width: 0.15, height: 0.09 });
            });
            for (const relation of direction.content.relations || []) edges.push({ from: `entity-${relation.from}`, to: `entity-${relation.to}`, opacity: action });
            break;
        }
        case "impact-reveal": {
            const response = frame < impact ? 0 : settle;
            add("trigger", 0.5, mix(0.29, 0.5, action), labels[0] || "", { kind: "circle", width: 0.085, height: 0.085, scaleY: frame >= impact ? 1 - Math.max(0, 1 - response) * 0.25 * amplitude : 1 });
            add("result", 0.5, 0.64, labels[1] || "", { width: 0.48, height: 0.13, scaleX: Math.max(0.01, response), scaleY: Math.max(0.01, response), opacity: clamp(response) });
            break;
        }
        case "continuous-shape-transition": {
            const p = smooth((frame - anticipationEnd) / Math.max(1, impact - anticipationEnd));
            const a: DirectorMotionAnchor = direction.transition.sharedAnchor;
            const b: DirectorMotionAnchor = direction.transition.exitAnchor;
            add(direction.transition.sharedElementId, mix(a.x, b.x, p), mix(a.y, b.y, p), labels[p < 0.5 ? 0 : Math.min(1, labels.length - 1)] || "", { kind: "circle", width: mix(a.width, b.width, p), height: mix(a.height, b.height, p), rotation: mix(a.rotation, b.rotation, p) });
            break;
        }
    }
    return {
        localFrame: frame, stage: frame < anticipationEnd ? "anticipation" : frame < impact ? "action" : frame < impact + 3 ? "impact" : frame < complete ? "settle" : "hold",
        actionProgress: action, settleProgress: settle, nodes, edges, camera, activeCueIds: direction.audioCues.filter((cue) => cue.frame === frame).map((cue) => cue.id),
    };
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);

/** SVG is shared by the editor and Remotion; all text is escaped, no external assets execute. */
export function renderDirectorMotionSvg(direction: DirectorDirection, localFrame: number, durationFrames: number, fps: number, size: { width?: number; height?: number } = {}) {
    const state = evaluateDirectorMotion(direction, localFrame, durationFrames, fps);
    const width = size.width || 1280;
    const height = size.height || 720;
    const body: string[] = [];
    for (const edge of state.edges) {
        const a = state.nodes.find((n) => n.id === edge.from)!;
        const b = state.nodes.find((n) => n.id === edge.to)!;
        const dx = (b.x - a.x) * width;
        const dy = (b.y - a.y) * height;
        const boundary = (n: MotionNode) => Math.min(Math.abs(dx) > 0 ? n.width * width / (2 * Math.abs(dx)) : Infinity, Math.abs(dy) > 0 ? n.height * height / (2 * Math.abs(dy)) : Infinity);
        const start = Math.min(0.5, boundary(a));
        const end = Math.min(0.5, boundary(b));
        body.push(`<line x1="${a.x * width + dx * start}" y1="${a.y * height + dy * start}" x2="${b.x * width - dx * end}" y2="${b.y * height - dy * end}" stroke="${direction.light.keyColor}" stroke-width="3" opacity="${edge.opacity * 0.6}"/>`);
    }
    for (const n of state.nodes) {
        const w = n.width * width;
        const h = n.height * height;
        const fontSize = Math.max(16, Math.min(n.kind === "text" ? 44 : 32, w / Math.max(2, Array.from(n.label).length) * 0.82));
        const shape = n.kind === "circle" ? `<ellipse rx="${w / 2}" ry="${h / 2}"/>` : n.kind === "box" ? `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="12"/>` : "";
        body.push(`<g transform="translate(${n.x * width} ${n.y * height}) scale(${n.scaleX} ${n.scaleY})" opacity="${n.opacity}"><g transform="rotate(${n.rotation})" fill="${n.color}" fill-opacity="0.14" stroke="${n.color}" stroke-width="2">${shape}</g><text text-anchor="middle" dominant-baseline="central" fill="#e9f0f3" font-size="${fontSize}" font-weight="${n.kind === "text" ? 600 : 500}">${escapeXml(n.label)}</text></g>`);
    }
    const titleFont = Math.max(18, Math.min(42, width * 0.84 / Math.max(1, Array.from(direction.content.title).length)));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(direction.content.title || MOTION_PATTERN_LABELS[direction.patternId])}" style="font-family:Microsoft YaHei,PingFang SC,Arial,sans-serif"><rect width="${width}" height="${height}" fill="${direction.light.background}"/><text x="${width * 0.08}" y="${height * 0.17}" fill="#e9f0f3" font-size="${titleFont}" font-weight="600">${escapeXml(direction.content.title)}</text><g transform="translate(${width * (0.5 + state.camera.x)} ${height * (0.5 + state.camera.y)}) scale(${state.camera.scale}) translate(${-width * 0.5} ${-height * 0.5})">${body.join("")}</g></svg>`;
}

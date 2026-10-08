import type { DirectorDirection } from "@/types/director-motion";

export function createDirectorDirection(): DirectorDirection {
    return {
        schemaVersion: 1, sourceAnchor: "", focus: "", emotion: "",
        action: { initial: "", verb: "", final: "", observableChange: "" },
        motion: { amplitude: 1, staggerMs: 0, settleMs: 300 },
        continuity: { statesIn: "", statesOut: "", reason: "" },
    };
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown) => typeof value === "string" && value.length <= 2000;
const bounded = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function validateDirectorDirection(value: unknown, durationMs = 60000): string[] {
    if (!record(value)) return ["动作设计：数据无效"];
    const errors: string[] = [];
    if (value.schemaVersion !== 1) errors.push("动作设计：版本不支持");
    if (!["sourceAnchor", "focus", "emotion"].every((key) => text(value[key]))) errors.push("动作设计：描述不能超过 2000 字");
    if (!record(value.action) || !["initial", "verb", "final", "observableChange"].every((key) => text((value.action as Record<string, unknown>)[key]))) errors.push("主体动作：描述无效");
    if (!record(value.continuity) || !["statesIn", "statesOut", "reason"].every((key) => text((value.continuity as Record<string, unknown>)[key]))) errors.push("镜头连续性：描述无效");
    if (!record(value.motion) || !bounded(value.motion.amplitude, 0, 2) || !bounded(value.motion.staggerMs, 0, durationMs) || !bounded(value.motion.settleMs, 0, durationMs)) errors.push("运动节奏：幅度须为 0–2，间隔和回稳时间不得超过镜头时长");
    return errors;
}

export function compileDirectionPrompt(direction: DirectorDirection, durationMs?: number): string {
    const errors = validateDirectorDirection(direction, durationMs);
    if (errors.length) throw new Error(errors.join("；"));
    const detail = (label: string, value: string) => value.trim() ? `${label}：${value.trim()}` : "";
    const action = [detail("初态", direction.action.initial), detail("动作", direction.action.verb), detail("终态", direction.action.final), detail("可见变化", direction.action.observableChange)].filter(Boolean).join("；");
    const continuity = [detail("入镜状态", direction.continuity.statesIn), detail("出镜状态", direction.continuity.statesOut), detail("承接理由", direction.continuity.reason)].filter(Boolean).join("；");
    return [
        detail("剧本原句", direction.sourceAnchor), detail("视觉焦点", direction.focus), detail("情绪", direction.emotion),
        action ? `主体行动：${action}。` : "",
        `运动节奏建议：幅度 ${direction.motion.amplitude} 倍；次主体间隔 ${direction.motion.staggerMs / 1000} 秒；回稳 ${direction.motion.settleMs / 1000} 秒。不以运镜代替主体动作。`,
        continuity ? `连续性：${continuity}。` : "",
    ].filter(Boolean).join("\n");
}

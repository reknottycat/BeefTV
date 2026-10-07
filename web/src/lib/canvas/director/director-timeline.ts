import type { DirectorScene } from "@/types/director";
import { compileDirectorPrompt } from "./director-prompt-compiler";

/** Fix one delivery clock; shot order and complete prompts come from the saved scene. */
export function compileDirectorTimeline(scene: DirectorScene, fps: 24 | 25 | 30 = 30) {
    if (![24, 25, 30].includes(fps)) throw new Error("交付帧率必须为 24、25 或 30");
    if (!scene.shots.length) throw new Error("场景没有镜头");
    const ids = new Set<string>();
    let cursor = 0;
    const shots = scene.shots.map((shot) => {
        if (!shot.id || ids.has(shot.id)) throw new Error("镜头 ID 为空或重复");
        ids.add(shot.id);
        if (!scene.cameras.some((camera) => camera.id === shot.cameraId)) throw new Error(`镜头「${shot.name}」的摄影机不存在`);
        if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 3600) throw new Error(`镜头「${shot.name}」时长无效`);
        const durationFrames = Math.round(shot.duration * fps);
        if (durationFrames < 1) throw new Error(`镜头「${shot.name}」短于一帧`);
        const entry = {
            shotId: shot.id, cameraId: shot.cameraId, startFrame: cursor, endFrame: cursor + durationFrames, durationFrames,
            prompt: compileDirectorPrompt(scene, shot), direction: shot.direction ? structuredClone(shot.direction) : undefined,
        };
        cursor += durationFrames;
        return entry;
    });
    return { schemaVersion: 1 as const, sceneId: scene.id, fps, totalFrames: cursor, shots };
}

export function canonicalDirectorJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalDirectorJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDirectorJson(entry)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

export async function hashDirectorValue(value: unknown) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalDirectorJson(value)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createDirectorProductionPackage(source: DirectorScene, fps: 24 | 25 | 30 = 30) {
    const scene = structuredClone(source);
    const timeline = compileDirectorTimeline(scene, fps);
    return {
        schema: "beeftv-director-handoff-v1", scene, timeline,
        provenance: { sceneSha256: await hashDirectorValue(scene), timelineSha256: await hashDirectorValue(timeline) },
        shotOrder: timeline.shots.map((shot) => shot.shotId), cameras: structuredClone(scene.cameras),
        assets: scene.objects.map((object) => ({ objectId: object.id, assetId: object.assetId, storageKey: object.storageKey, url: object.url })),
        capability: { mode: "prompt-and-reference-handoff", exactTrajectoryControl: false, generatedMediaReviewRequired: true },
    };
}

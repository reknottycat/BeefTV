import type { GenerationTask } from "../services/api/task-center";

export type NativeTaskCenterHistory = { tasks: GenerationTask[]; backendAvailable: boolean };

export async function loadNativeTaskCenterHistory(dependencies: { readNative: () => Promise<GenerationTask[]>; readHistory: () => GenerationTask[] }): Promise<NativeTaskCenterHistory> {
    let native: GenerationTask[];
    let backendAvailable = true;
    try {
        native = await dependencies.readNative();
    } catch {
        native = [];
        backendAvailable = false;
    }
    const merged = new Map(native.map((task) => [task.id, { ...task, historyOnly: false }]));
    for (const historical of dependencies.readHistory()) {
        if (merged.has(historical.id)) continue;
        // A canvas snapshot can remember a real task ID without proving the
        // backend still owns that task. It remains a read-only historical view.
        merged.set(historical.id, { ...historical, historyOnly: true });
    }
    return { tasks: [...merged.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)), backendAvailable };
}

export function canOperateNativeTask(task: GenerationTask | undefined) {
    return Boolean(task && !task.historyOnly && !task.id.startsWith("local:"));
}

export function taskResultMediaUrls(value?: string) {
    if (!value) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { parsed = value; }
    const urls: string[] = [];
    const visit = (item: unknown, key = "") => {
        if (typeof item === "string") {
            const namedMedia = /(url|image|video|result|output|media)/i.test(key);
            const inline = /^(data:image\/|data:video\/)/.test(item);
            const path = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov)(?:$|\?)/i.test(item);
            const url = /^(https?:|blob:)/.test(item) && namedMedia;
            const owned = /^\/(?:api\/)?resources\/[^/?#]+\/file(?:[?#]|$)/.test(item) && namedMedia;
            if ((inline || path || url || owned) && !urls.includes(item)) urls.push(item);
            return;
        }
        if (Array.isArray(item)) item.forEach((value) => visit(value, key));
        else if (item && typeof item === "object") Object.entries(item).forEach(([field, value]) => visit(value, field));
    };
    visit(parsed);
    return urls.slice(0, 12);
}

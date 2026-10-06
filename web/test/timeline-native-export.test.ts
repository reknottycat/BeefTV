import { expect, test } from "bun:test";
import { exportNativeTimeline, runNativeTimelineExportAttempt, type NativeTimelineExportIntent } from "../src/services/timeline-native-export";
import type { GenerationTask } from "../src/services/api/task-center";
import type { TimelineProject } from "../src/types/timeline";

const timeline: TimelineProject = {
    version: 2,
    tracks: [{ id: "video", kind: "video", label: "Video", order: 0 }],
    clips: [{ id: "clip", nodeId: "node", trackId: "video", kind: "video", startMs: 0, durationMs: 1000, sourceDurationMs: 2000, directMedia: { id: "source", kind: "video", title: "Source", storageKey: "resource:source" } }],
    durationMs: 1000,
};

function task(status: GenerationTask["status"]): GenerationTask {
    return { id: "render", status, type: "timeline_render", prompt: "", attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ resourceId: "output", durationMs: 1000 }) };
}

function harness() {
    const intentRef: { current: NativeTimelineExportIntent | null } = { current: null };
    const keys: string[] = [];
    const blob = new Blob(["rendered-video"]);
    const hooks: NonNullable<Parameters<typeof exportNativeTimeline>[4]> = {
        createTask: async () => task("queued"),
        waitTask: async () => task("succeeded"),
        readBlob: async () => blob,
    };
    const attempt = (hash = "same-timeline") => runNativeTimelineExportAttempt(intentRef, hash, (clientKey) => exportNativeTimeline(timeline, [], clientKey, () => undefined, {
        createTask: async (request) => { keys.push(request.clientKey!); return hooks.createTask(request); },
        waitTask: (id, options) => hooks.waitTask(id, options),
        readBlob: (key) => hooks.readBlob(key),
    }));
    return { intentRef, keys, blob, hooks, attempt };
}

for (const status of ["failed", "cancelled"] as const) {
    for (const observation of ["creation", "update-before-rejection", "returned-task"] as const) {
        test(`${status} from ${observation} permits a new task only on the next export`, async () => {
            const h = harness();
            if (observation === "creation") {
                h.hooks.createTask = async () => task(status);
                h.hooks.waitTask = async () => { throw new Error("terminal tasks must not be polled"); };
            } else if (observation === "update-before-rejection") {
                h.hooks.waitTask = async (_id, options) => {
                    options?.onTaskUpdate?.(task(status));
                    throw new Error("render stopped");
                };
            } else {
                h.hooks.waitTask = async () => task(status);
            }

            await expect(h.attempt()).rejects.toThrow();
            expect(h.keys).toHaveLength(1);
            expect(h.intentRef.current).toBeNull();

            h.hooks.createTask = async () => task("queued");
            h.hooks.waitTask = async () => task("succeeded");
            expect(await h.attempt()).toBe(h.blob);
            expect(h.keys).toHaveLength(2);
            expect(h.keys[1]).not.toBe(h.keys[0]);
        });
    }
}

test("a lost submission response retains the key instead of creating a second render", async () => {
    const h = harness();
    h.hooks.createTask = async () => { throw new Error("reply lost"); };
    await expect(h.attempt()).rejects.toThrow("reply lost");
    expect(h.intentRef.current?.key).toBe(h.keys[0]);
    h.hooks.createTask = async () => task("queued");
    await h.attempt();
    expect(h.keys[1]).toBe(h.keys[0]);
});

for (const status of [undefined, "queued", "running"] as const) {
    test(`an interrupted observation after ${status || "no update"} retains the key`, async () => {
        const h = harness();
        h.hooks.waitTask = async (_id, options) => {
            if (status) options?.onTaskUpdate?.(task(status));
            // Error text alone is not authoritative task status.
            throw new Error("request failed or was cancelled");
        };
        await expect(h.attempt()).rejects.toThrow("request failed or was cancelled");
        expect(h.intentRef.current?.key).toBe(h.keys[0]);
        h.hooks.waitTask = async () => task("succeeded");
        await h.attempt();
        expect(h.keys[1]).toBe(h.keys[0]);
    });
}

for (const failure of ["download-error", "empty-download", "invalid-receipt"] as const) {
    test(`a succeeded render with ${failure} retains the key`, async () => {
        const h = harness();
        if (failure === "invalid-receipt") h.hooks.waitTask = async () => ({ ...task("succeeded"), resultJson: "{}" });
        else h.hooks.readBlob = async () => {
            if (failure === "download-error") throw new Error("download failed");
            return new Blob();
        };
        await expect(h.attempt()).rejects.toThrow();
        expect(h.intentRef.current?.key).toBe(h.keys[0]);
        h.hooks.waitTask = async () => task("succeeded");
        h.hooks.readBlob = async () => h.blob;
        await h.attempt();
        expect(h.keys[1]).toBe(h.keys[0]);
    });
}

test("a successful repeated download reuses its key, and changed content uses a new key", async () => {
    const h = harness();
    await h.attempt();
    await h.attempt();
    expect(h.keys[1]).toBe(h.keys[0]);
    await h.attempt("edited-timeline");
    expect(h.keys[2]).not.toBe(h.keys[0]);
});

test("a replayed succeeded task retries only the download using its existing key", async () => {
    const h = harness();
    h.hooks.createTask = async () => task("succeeded");
    h.hooks.waitTask = async () => { throw new Error("completed tasks must not be polled"); };
    h.hooks.readBlob = async () => { throw new Error("download failed"); };
    await expect(h.attempt()).rejects.toThrow("download failed");
    expect(h.intentRef.current?.key).toBe(h.keys[0]);
    h.hooks.readBlob = async () => h.blob;
    expect(await h.attempt()).toBe(h.blob);
    expect(h.keys[1]).toBe(h.keys[0]);
});

test("an older failed render cannot clear the intent of a newer timeline", async () => {
    const h = harness();
    let failOlder!: () => void;
    let observationStarted!: () => void;
    const started = new Promise<void>((resolve) => { observationStarted = resolve; });
    h.hooks.waitTask = async (_id, options) => new Promise((_resolve, reject) => {
        failOlder = () => { options?.onTaskUpdate?.(task("failed")); reject(new Error("old render failed")); };
        observationStarted();
    });
    const older = h.attempt();
    await started;
    h.hooks.waitTask = async () => task("succeeded");
    await h.attempt("newer-timeline");
    const newerIntent = h.intentRef.current;
    failOlder();
    await expect(older).rejects.toThrow("old render failed");
    expect(h.intentRef.current).toBe(newerIntent);
});

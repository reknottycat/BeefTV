import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AiConfig } from "../src/stores/use-config-store";

// Run the actual repository implementation with an in-memory versioned server.
// This isolates the write fence without requiring browser packages or network.
const source = readFileSync(new URL("../src/services/model-config-repository.ts", import.meta.url), "utf8");
const start = source.indexOf("export function createModelConfigRepository");
const end = source.indexOf("\nfunction omitManagedBeefAPISecrets");
if (start < 0 || end <= start) throw new Error("repository implementation boundary missing");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end).replace("export function", "function"));
const createRepository = new Function(`${js}; return createModelConfigRepository;`)() as typeof import("../src/services/model-config-repository").createModelConfigRepository;

const oldConfig = { channels: [{ id: "TEST-owned", name: "TEST-owned", apiKey: "TEST-MOCK-OLD", models: ["TEST-image"] }], imageModel: "TEST-owned::TEST-image" } as unknown as AiConfig;
const newConfig = { channels: [{ id: "MiniMax-owned", name: "MiniMax-owned", apiKey: "TEST-MOCK-NEW", models: ["text-real"] }], imageModel: "local-comfy:qwen_image_2_1", localComfyDefaults: { image: { recipeId: "qwen_image_2_1", seed: "42" } } } as unknown as AiConfig;

function memoryServer() {
    let config = structuredClone(oldConfig);
    let revision = 1;
    let failReads = false;
    const attempts: number[] = [];
    const accepted: AiConfig[] = [];
    const dependencies = {
        read: async () => {
            if (failReads) throw new Error("mock canonical read unavailable");
            return { config: structuredClone(config), revision, health: "ready" as const, source: "builtin+local" as const };
        },
        write: async (next: AiConfig, expectedRevision: number) => {
            attempts.push(expectedRevision);
            if (expectedRevision !== revision) throw Object.assign(new Error("mock revision conflict"), { status: 409 });
            config = structuredClone(next);
            accepted.push(config);
            revision += 1;
            return { saved: true, revision };
        },
    };
    return { dependencies, attempts, accepted, current: () => structuredClone(config), failReads: (value: boolean) => { failReads = value; } };
}

describe("model config concurrent writer protection", () => {
    test("two repositories cannot resurrect a removed channel or overwrite newer credentials and seeds", async () => {
        const server = memoryServer();
        const first = createRepository(server.dependencies), stale = createRepository(server.dependencies);
        await Promise.all([first.hydrate(), stale.hydrate()]);
        await first.commit(newConfig);
        await stale.commit({ ...oldConfig, size: "16:9" });
        expect(server.current()).toEqual(newConfig);
        expect(server.accepted).toHaveLength(1);
        expect(server.attempts).toEqual([1, 1]);
        expect(stale.getState()).toMatchObject({ status: "error", dirty: true, revision: 1, conflictRevision: 2 });
        expect(stale.getState().error).toContain("停止自动覆盖");
    });
    test("flush and further stale edits stay blocked until explicit canonical hydration", async () => {
        const server = memoryServer();
        const first = createRepository(server.dependencies), stale = createRepository(server.dependencies);
        await Promise.all([first.hydrate(), stale.hydrate()]);
        await first.commit(newConfig);
        await stale.commit(oldConfig);
        await stale.flush();
        await stale.commit({ ...oldConfig, imageModel: "TEST-owned::another-image" });
        await stale.flush();
        expect(server.attempts).toEqual([1, 1]);
        expect(server.current()).toEqual(newConfig);
        const restored = await stale.hydrate();
        expect(restored.config).toEqual(newConfig);
        expect(stale.getState()).toMatchObject({ status: "idle", dirty: false, revision: 2 });
        await stale.flush();
        expect(server.accepted).toHaveLength(1);
        await stale.commit({ ...restored.config, imageModel: "local-comfy:qwen_image_2_1_preview512" });
        expect(server.current().channels).toEqual(newConfig.channels);
        expect(server.current().localComfyDefaults).toEqual(newConfig.localComfyDefaults);
        expect(server.accepted).toHaveLength(2);
    });
    test("an unavailable conflict reread never authorizes retrying the old full snapshot", async () => {
        const server = memoryServer();
        const first = createRepository(server.dependencies), stale = createRepository(server.dependencies);
        await Promise.all([first.hydrate(), stale.hydrate()]);
        await first.commit(newConfig);
        server.failReads(true);
        await stale.commit(oldConfig);
        await stale.flush();
        await expect(stale.hydrate()).rejects.toThrow("unavailable");
        await stale.flush();
        expect(server.accepted).toHaveLength(1);
        expect(server.current()).toEqual(newConfig);
        expect(stale.getState()).toMatchObject({ status: "error", dirty: true });
    });
    test("a failed first canonical read cannot write browser cache before a successful reload", async () => {
        const server = memoryServer();
        const repository = createRepository(server.dependencies);
        server.failReads(true);
        await expect(repository.hydrate()).rejects.toThrow("unavailable");
        await repository.commit(oldConfig);
        await repository.flush();
        expect(server.attempts).toEqual([]);
        server.failReads(false);
        const restored = await repository.hydrate();
        expect(restored.config).toEqual(oldConfig);
        expect(repository.getState()).toMatchObject({ status: "idle", dirty: false });
        await repository.flush();
        expect(server.attempts).toEqual([]);
    });
});

import { describe, expect, test } from "bun:test";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { bindLocalComfyBackendResult } from "./backend-binding";

const context = { projectId: "canvas-1", nodeId: "source-1", shotId: "director-shot-1" };
const copy = <T,>(value: T): T => structuredClone(value);
const source = { id: "source-1", type: "image", title: "Shot", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { directorShotId: "director-shot-1" } } as CanvasNodeData;
const result = { id: "local-comfy-result-1", type: "image", title: "Result", position: { x: 148, y: 0 }, width: 100, height: 100, metadata: { assetId: "resource-1", storageKey: "resource:resource-1", taskId: "local-comfy:job-1:result-1" } } as CanvasNodeData;
const candidate = {
    id: "resource-1", kind: "image", title: "Result", coverUrl: "/api/resources/resource-1/file", tags: [], category: "material", status: "confirmed",
    createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z",
    data: { dataUrl: "", storageKey: "resource:resource-1", width: 864, height: 480, bytes: 100, mimeType: "image/png" },
    metadata: { localComfyJobId: "job-1", localComfyAssetId: "result-1", sha256: "a".repeat(64), generationEffectKey: "local-comfy:job-1:result-1", sourceNodeId: "source-1", sourceShotId: "director-shot-1", canvasId: "canvas-1", recipeId: "qwen", seed: 0, attempt: 1 },
} as Asset;

function fixture() {
    const initial = { id: "canvas-1", projectId: "domain-1", revision: 7, title: "Canvas", createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", nodes: [copy(source)], connections: [] } as unknown as CanvasProject;
    const memory = { project: copy(initial), cache: copy(initial), assets: new Map<string, Asset>(), links: new Set<string>() };
    const calls = { commits: 0, links: 0, publishes: [] as Array<{ project: CanvasProject; asset: Asset }> };
    const dependencies = {
        readCanvas: async () => copy(memory.project),
        readAsset: async (id: string) => copy(memory.assets.get(id) || null),
        makeResult: () => ({ node: copy(result), asset: copy(candidate) }),
        commit: async (project: CanvasProject, asset: Asset) => {
            calls.commits++;
            if (project.revision !== memory.project.revision) throw Object.assign(new Error("conflict"), { status: 409 });
            memory.assets.set(asset.id, copy(asset));
            memory.project = { ...copy(project), revision: project.revision! + 1, updatedAt: "2026-10-03T00:01:00Z" };
            return { id: memory.project.id, title: memory.project.title, createdAt: memory.project.createdAt, updatedAt: memory.project.updatedAt, revision: memory.project.revision! };
        },
        linkProject: async (projectId: string, asset: Asset) => { calls.links++; memory.links.add(`${projectId}:${asset.id}`); },
        publish: (project: CanvasProject, asset: Asset) => { calls.publishes.push(copy({ project, asset })); memory.cache = copy(project); },
        checkCurrentTarget: () => {},
        readCurrentCanvas: () => copy(memory.cache),
        sameContent: (left: CanvasProject, right: CanvasProject) => {
            const { revision: _leftRevision, updatedAt: _leftUpdated, viewport: _leftView, remoteContentHash: _leftHash, ...a } = left;
            const { revision: _rightRevision, updatedAt: _rightUpdated, viewport: _rightView, remoteContentHash: _rightHash, ...b } = right;
            return JSON.stringify(a) === JSON.stringify(b);
        },
    };
    return { memory, calls, dependencies };
}

describe("local Comfy backend binding", () => {
    test("double bind reuses the canonical Resource asset, node, edge and project link", async () => {
        const state = fixture();
        expect(await bindLocalComfyBackendResult(context, state.dependencies)).toBe("resource-1");
        expect(await bindLocalComfyBackendResult(context, state.dependencies)).toBe("resource-1");
        expect(state.calls.commits).toBe(1);
        expect(state.memory.assets.size).toBe(1);
        expect(state.memory.project.nodes).toHaveLength(2);
        expect(state.memory.project.connections).toHaveLength(1);
        expect(state.memory.project.revision).toBe(8);
        expect(state.memory.links.size).toBe(1);
    });

    test("backend publication works without secure-context browser APIs", async () => {
        const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
        try {
            const state = fixture();
            expect(await bindLocalComfyBackendResult(context, state.dependencies)).toBe("resource-1");
            expect(state.calls.commits).toBe(1);
        } finally {
            if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
            else Reflect.deleteProperty(globalThis, "crypto");
        }
    });

    test("a concurrent canvas change yields a clear conflict without guessed revision or cache publication", async () => {
        const state = fixture();
        const commit = state.dependencies.commit;
        state.dependencies.commit = async (project, asset) => {
            state.memory.project.revision = 8;
            state.memory.project.nodes.push({ ...copy(source), id: "concurrent-node" });
            return commit(project, asset);
        };
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("重新加载后重试");
        expect(state.calls.commits).toBe(1);
        expect(state.calls.publishes).toHaveLength(0);
        expect(state.memory.assets.size).toBe(0);
        expect(state.memory.project.nodes.map((node) => node.id)).toEqual(["source-1", "concurrent-node"]);
    });

    test("a rejected transaction cannot publish a successful result", async () => {
        const state = fixture();
        const rejected = Object.assign(new Error("forbidden"), { status: 403 });
        state.dependencies.commit = async () => { state.calls.commits++; throw rejected; };
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toBe(rejected);
        expect(state.calls.publishes).toHaveLength(0);
        expect(state.calls.links).toBe(0);
        expect(state.memory.assets.size).toBe(0);
    });

    test("a lost commit response is reconciled by exact server IDs without a second write", async () => {
        const state = fixture();
        const commit = state.dependencies.commit;
        state.dependencies.commit = async (project, asset) => { await commit(project, asset); throw new Error("response lost"); };
        expect(await bindLocalComfyBackendResult(context, state.dependencies)).toBe("resource-1");
        expect(state.calls.commits).toBe(1);
        expect(state.memory.assets.size).toBe(1);
        expect(state.memory.links.size).toBe(1);
    });

    test("a project-link failure stays partial and retries the same persisted asset", async () => {
        const state = fixture();
        const link = state.dependencies.linkProject;
        state.dependencies.linkProject = async () => { state.calls.links++; throw new Error("link offline"); };
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("项目素材关联尚未完成");
        expect(state.calls.commits).toBe(1);
        expect(state.calls.publishes).toHaveLength(1);
        expect(state.memory.links.size).toBe(0);
        state.dependencies.linkProject = link;
        expect(await bindLocalComfyBackendResult(context, state.dependencies)).toBe("resource-1");
        expect(state.calls.commits).toBe(1);
        expect(state.memory.links.size).toBe(1);
        expect(state.memory.assets.size).toBe(1);
    });

    test("an existing asset with conflicting provenance cannot be overwritten", async () => {
        const state = fixture();
        state.memory.assets.set(candidate.id, { ...copy(candidate), metadata: { ...candidate.metadata, sha256: "b".repeat(64) } });
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("来源不一致");
        expect(state.calls.commits).toBe(0);
        expect(state.calls.publishes).toHaveLength(0);
        expect(state.memory.assets.get(candidate.id)?.metadata?.sha256).toBe("b".repeat(64));
    });

    test("an exact asset with inconsistent media metadata is rejected", async () => {
        const state = fixture();
        const asset = copy(candidate);
        if (asset.kind !== "image") throw new Error("fixture");
        asset.data.bytes++;
        state.memory.assets.set(asset.id, asset);
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("媒体信息不一致");
        expect(state.calls.commits).toBe(0);
    });

    test("a deleted or changed server shot cannot receive the result", async () => {
        const state = fixture();
        state.memory.project.nodes[0].metadata = { directorShotId: "another-shot" };
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("后端镜头已删除或发生变化");
        expect(state.calls.commits).toBe(0);
        expect(state.calls.publishes).toHaveLength(0);
    });

    test("a missing server revision is rejected before attempting a transaction", async () => {
        const state = fixture();
        state.memory.project.revision = undefined;
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("后端画布版本无效");
        expect(state.calls.commits).toBe(0);
    });

    test("a remote node missing from the local draft cannot be lost through an upgraded cache revision", async () => {
        const state = fixture();
        state.memory.project.nodes.push({ ...copy(source), id: "remote-new-node" });
        state.memory.project.revision = 8;
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("本地草稿与后端画布不一致");
        expect(state.calls.commits).toBe(0);
        expect(state.memory.cache.revision).toBe(7);
        state.memory.cache = copy(state.memory.project);
        await bindLocalComfyBackendResult(context, state.dependencies);
        expect(state.memory.cache.nodes.map((node) => node.id)).toEqual(["source-1", "remote-new-node", "local-comfy-result-1"]);
        await state.dependencies.commit(copy(state.memory.cache), copy(candidate));
        expect(state.memory.project.nodes.some((node) => node.id === "remote-new-node")).toBe(true);
    });

    test("a local edit while the transaction is in flight preserves the draft and its old revision", async () => {
        const state = fixture();
        const commit = state.dependencies.commit;
        state.dependencies.commit = async (project, asset) => {
            const saved = await commit(project, asset);
            state.memory.cache.nodes.push({ ...copy(source), id: "unsaved-local-node" });
            return saved;
        };
        await expect(bindLocalComfyBackendResult(context, state.dependencies)).rejects.toThrow("草稿与版本未被覆盖");
        expect(state.memory.project.revision).toBe(8);
        expect(state.memory.project.nodes.some((node) => node.id === "local-comfy-result-1")).toBe(true);
        expect(state.memory.cache.revision).toBe(7);
        expect(state.memory.cache.nodes.map((node) => node.id)).toEqual(["source-1", "unsaved-local-node"]);
        expect(state.calls.publishes).toHaveLength(0);
    });
});

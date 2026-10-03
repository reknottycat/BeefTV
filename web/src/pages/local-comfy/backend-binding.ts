import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { LocalComfyCanvasSave } from "@/services/api/local-comfy";
import type { LocalComfyCanvasContext } from "./context";

type BackendBindingDependencies = {
    readCanvas: () => Promise<CanvasProject>;
    readAsset: (id: string) => Promise<Asset | null>;
    makeResult: (source: CanvasNodeData) => { node: CanvasNodeData; asset: Asset };
    commit: (project: CanvasProject, asset: Asset) => Promise<LocalComfyCanvasSave>;
    linkProject: (projectId: string, asset: Asset) => Promise<void>;
    publish: (project: CanvasProject, asset: Asset) => void;
    checkCurrentTarget: () => void;
    readCurrentCanvas: () => CanvasProject;
    sameContent: (left: CanvasProject, right: CanvasProject) => boolean;
};

function validateTarget(context: LocalComfyCanvasContext, project: CanvasProject) {
    if (project.id !== context.projectId || !Number.isSafeInteger(project.revision) || project.revision! < 0 || project.revision! >= Number.MAX_SAFE_INTEGER) throw new Error("后端画布版本无效，请返回画布重新加载");
    const source = project.nodes.find((node) => node.id === context.nodeId);
    if (!source || (context.shotId && source.metadata?.directorShotId !== context.shotId)) throw new Error("后端镜头已删除或发生变化，请从画布重新打开本地生成");
    return source;
}

function validateAsset(existing: Asset, candidate: Asset) {
    const keys = ["localComfyJobId", "localComfyAssetId", "sha256", "generationEffectKey", "sourceNodeId", "sourceShotId", "canvasId", "recipeId", "seed", "attempt"];
    if (existing.id !== candidate.id || existing.kind !== candidate.kind || !("storageKey" in existing.data) || !("storageKey" in candidate.data) || existing.data.storageKey !== candidate.data.storageKey || existing.data.storageKey !== `resource:${existing.id}` || keys.some((key) => existing.metadata?.[key] !== candidate.metadata?.[key])) throw new Error("后端资产身份或来源不一致，已停止关联以保留原资产");
    const existingData = existing.data as Record<string, unknown>;
    const candidateData = candidate.data as Record<string, unknown>;
    if (["mimeType", "bytes", "width", "height"].some((key) => existingData[key] !== candidateData[key])) throw new Error("后端资产媒体信息不一致，已停止关联以保留原资产");
}

function alreadyBound(project: CanvasProject, node: CanvasNodeData, connectionId: string, sourceId: string) {
    const existing = project.nodes.find((item) => item.id === node.id);
    if (existing && (existing.type !== node.type || existing.metadata?.assetId !== node.metadata?.assetId || existing.metadata?.storageKey !== node.metadata?.storageKey || existing.metadata?.taskId !== node.metadata?.taskId)) throw new Error("画布结果标识已被其他资产使用，已停止关联");
    const connection = project.connections.find((item) => item.id === connectionId);
    if (connection && (connection.fromNodeId !== node.id || connection.toNodeId !== sourceId)) throw new Error("画布连接标识已被其他镜头使用，已停止关联");
    return Boolean(existing && connection);
}

/** Backend CAS and its transaction own durable publication; browser stores are caches. */
export async function bindLocalComfyBackendResult(context: LocalComfyCanvasContext, dependencies: BackendBindingDependencies) {
    dependencies.checkCurrentTarget();
    let project = await dependencies.readCanvas();
    const source = validateTarget(context, project);
    let expectedDraft = structuredClone(dependencies.readCurrentCanvas());
    if (!dependencies.sameContent(expectedDraft, project)) throw new Error("本地草稿与后端画布不一致，请先保存草稿并返回画布重新加载后再关联");
    const checkDraft = (committed: boolean) => {
        if (!dependencies.sameContent(dependencies.readCurrentCanvas(), expectedDraft)) throw new Error(committed ? "结果已保存到后端画布，但本地草稿在等待期间发生变化；草稿与版本未被覆盖，请返回画布重新加载核验" : "本地草稿在等待期间发生变化，本次未提交关联；请保存草稿后重试");
    };
    const publish = (savedAsset: Asset) => {
        checkDraft(true);
        dependencies.publish(project, savedAsset);
        expectedDraft = structuredClone(dependencies.readCurrentCanvas());
    };
    const result = dependencies.makeResult(source);
    const resourceKey = "storageKey" in result.asset.data ? result.asset.data.storageKey : undefined;
    if (!resourceKey || resourceKey !== `resource:${result.asset.id}` || result.node.metadata?.assetId !== result.asset.id || result.node.metadata?.storageKey !== resourceKey) throw new Error("结果尚未保存为后端资源，无法关联画布");
    const existingAsset = await dependencies.readAsset(result.asset.id);
    if (existingAsset) validateAsset(existingAsset, result.asset);
    let asset = existingAsset || result.asset;
    const connectionId = `${result.node.id}-to-${source.id}`;
    const bound = alreadyBound(project, result.node, connectionId, source.id);
    if (!bound || !existingAsset) {
        const proposed: CanvasProject = {
            ...project,
            nodes: project.nodes.some((node) => node.id === result.node.id) ? project.nodes : [...project.nodes, result.node],
            connections: project.connections.some((connection) => connection.id === connectionId) ? project.connections : [...project.connections, { id: connectionId, fromNodeId: result.node.id, toNodeId: source.id }],
        };
        dependencies.checkCurrentTarget();
        checkDraft(false);
        try {
            const saved = await dependencies.commit(proposed, asset);
            if (!saved || saved.id !== project.id || !Number.isSafeInteger(saved.revision) || saved.revision <= project.revision! || saved.revision >= Number.MAX_SAFE_INTEGER) throw new Error("后端保存响应缺少有效版本，请刷新记录核验关联结果");
            project = { ...proposed, revision: saved.revision, updatedAt: saved.updatedAt };
        } catch (error) {
            if (error && typeof error === "object" && "status" in error && error.status === 409) throw new Error("画布已被其他操作更新，本次关联未覆盖它；请返回画布重新加载后重试");
            // A lost response can follow a committed transaction. Read exact IDs before retrying.
            try {
                const latest = await dependencies.readCanvas();
                validateTarget(context, latest);
                const recovered = await dependencies.readAsset(asset.id);
                if (!recovered || !alreadyBound(latest, result.node, connectionId, source.id)) throw error;
                validateAsset(recovered, result.asset);
                project = latest;
                asset = recovered;
            } catch {
                throw error;
            }
        }
    }
    dependencies.checkCurrentTarget();
    publish(asset);
    if (project.projectId) {
        try {
            await dependencies.linkProject(project.projectId, asset);
        } catch (error) {
            throw new Error(`结果已保存到后端画布，项目素材关联尚未完成；重试会沿用同一资产：${error instanceof Error ? error.message : "请求未完成"}`);
        }
        const projectIds = Array.isArray(asset.metadata?.projectIds) ? asset.metadata.projectIds.filter((id): id is string => typeof id === "string") : [];
        asset = { ...asset, metadata: { ...asset.metadata, projectIds: [...new Set([...projectIds, project.projectId])] } };
        publish(asset);
    }
    return asset.id;
}

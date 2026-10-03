import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { parseAssetRecord } from "@/lib/asset-record";
import { normalizeAssetCategory } from "@/lib/asset-category";
import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { imageMetadata, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { canvasNodeToAsset } from "@/lib/canvas/canvas-node-asset";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { syncLocalCanvasSnapshot } from "@/services/local-workspace-sync";
import { requiresBackendLocalResourceStore, usesBrowserLocalResourceStore, usesNativeLocalResourceStore } from "@/services/workspace-resource-storage";
import { getResource, resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { linkProjectAsset } from "@/services/api/projects";
import { commitLocalComfyBackendResult, getLocalComfyBackendAsset, getLocalComfyBackendCanvas, readLocalComfyAssetBlob, type LocalComfyAsset, type LocalComfyJob } from "@/services/api/local-comfy";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { LocalComfyCanvasContext } from "./context";
import { bindLocalComfyBackendResult } from "./backend-binding";

/** Explicitly attach a sidecar archive to the existing local canvas, preserving the shot. */
export async function bindLocalComfyResult(context: LocalComfyCanvasContext, job: LocalComfyJob, asset: LocalComfyAsset, signal?: AbortSignal) {
    if (!isLocalRuntimeMode() || !(usesBrowserLocalResourceStore() || usesNativeLocalResourceStore())) throw new Error("关联结果需要本机工作区；当前存储模式不能安全关联");
    if (asset.job_id !== job.id || !job.archived_asset_ids.includes(asset.id)) throw new Error("结果尚未归档或不属于当前任务");
    const resultId = `local-comfy-${asset.id}`;
    const findTarget = () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === context.projectId);
        const source = project?.nodes.find((item) => item.id === context.nodeId);
        if (!project || !source || (context.shotId && source.metadata?.directorShotId !== context.shotId)) throw new Error("原画布镜头已删除或发生变化，请从镜头重新打开本地生成");
        return { project, source };
    };
    const persistTarget = async () => {
        await flushCanvasStorePersistence();
        if (requiresBackendLocalResourceStore()) {
            const latest = findTarget().project;
            await syncLocalCanvasSnapshot(context.projectId, { nodes: latest.nodes, connections: latest.connections });
            await flushCanvasStorePersistence();
        }
    };
    const first = findTarget();
    const already = first.project.nodes.find((item) => item.id === resultId);
    if (!requiresBackendLocalResourceStore() && already?.metadata?.assetId) { await persistTarget(); return already.metadata.assetId; }
    const isImage = asset.mime_type.startsWith("image/");
    if (!isImage && !asset.mime_type.startsWith("video/")) throw new Error("当前结果格式不能作为画布图片或视频关联");
    const effectKey = `local-comfy:${job.id}:${asset.id}`;
    if (requiresBackendLocalResourceStore()) {
        const blob = await readLocalComfyAssetBlob(asset.id, signal);
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const media = isImage ? imageMetadata(await uploadImage(blob, undefined, { idempotencyKey: effectKey })) : videoMetadata(await uploadMediaFile(blob, "local-comfy", undefined, { idempotencyKey: effectKey }));
        const resourceId = resourceIdFromStorageKey(media.storageKey);
        if (!resourceId) throw new Error("结果尚未保存为后端资源，无法关联画布");
        const resource = await getResource(resourceId);
        if (resource.id !== resourceId || resource.status !== "ready" || resource.mimeType !== asset.mime_type || resource.size !== asset.size || !resource.createdAt) throw new Error("后端资源与归档结果不一致，已停止关联");
        return bindLocalComfyBackendResult(context, {
            readCanvas: () => getLocalComfyBackendCanvas(context.projectId, signal),
            readAsset: (id) => getLocalComfyBackendAsset(id, signal),
            commit: (project, resultAsset) => commitLocalComfyBackendResult(project, resultAsset, signal),
            linkProject: async (projectId, resultAsset) => { await linkProjectAsset(projectId, { assetId: resultAsset.id, category: normalizeAssetCategory(resultAsset.category), title: resultAsset.title, source: "canvas" }, signal); },
            checkCurrentTarget: () => { if (signal?.aborted) throw new DOMException("请求已取消", "AbortError"); findTarget(); },
            readCurrentCanvas: () => findTarget().project,
            sameContent: sameCanvasContent,
            makeResult: (source) => {
                const node: CanvasNodeData = { id: resultId, type: isImage ? CanvasNodeType.Image : CanvasNodeType.Video, title: `${source.title} · 本地生成 ${job.attempt}`, position: { x: source.position.x + source.width + 48, y: source.position.y }, width: 360, height: 260, metadata: { ...media, assetId: resourceId, prompt: job.prompt, assetTags: ["本地生成", `镜头:${source.title}`], taskId: effectKey, directorSceneId: source.metadata?.directorSceneId, directorShotId: source.metadata?.directorShotId, workflowKind: isImage ? "reference_set" : "reference_video" } };
                const input = canvasNodeToAsset(node, { canvasId: context.projectId, source: "canvas-generation", taskId: effectKey });
                if (!input) throw new Error("结果不能登记为画布素材");
                const resultAsset = parseAssetRecord({ ...input, id: resourceId, createdAt: resource.createdAt, updatedAt: resource.createdAt, metadata: { ...input.metadata, generationEffectKey: effectKey, localComfyJobId: job.id, localComfyAssetId: asset.id, sourceNodeId: source.id, sourceShotId: context.shotId || source.id, sha256: asset.sha256, recipeId: job.recipe_id, seed: job.seed, attempt: job.attempt } });
                return { node, asset: resultAsset };
            },
            publish: (project, resultAsset) => {
                useAssetStore.setState((state) => ({ assets: [resultAsset, ...state.assets.filter((item) => item.id !== resultAsset.id)] }));
                useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id !== project.id ? item : { ...project, viewport: item.viewport }) }));
                void flushCanvasStorePersistence().catch((error) => console.error("后端结果已保存，画布缓存写入失败", error));
            },
        });
    }
    const stored = useAssetStore.getState().assets.find((item) => item.metadata?.generationEffectKey === effectKey);
    let media = already?.metadata;
    if (!media && stored && (stored.kind === "image" || stored.kind === "video")) {
        const resourceId = resourceIdFromStorageKey(stored.data.storageKey);
        media = { content: stored.kind === "image" ? (stored.coverUrl || (resourceId ? resourceFileUrl(resourceId) : stored.data.dataUrl)) : stored.data.url, storageKey: stored.data.storageKey, naturalWidth: stored.data.width, naturalHeight: stored.data.height, bytes: stored.data.bytes, mimeType: stored.data.mimeType, status: "success" };
    }
    if (!media) {
        const blob = await readLocalComfyAssetBlob(asset.id, signal);
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        media = isImage ? imageMetadata(await uploadImage(blob, undefined, { idempotencyKey: effectKey })) : videoMetadata(await uploadMediaFile(blob, "local-comfy", undefined, { idempotencyKey: effectKey }));
    }
    if (requiresBackendLocalResourceStore() && !resourceIdFromStorageKey(media.storageKey)) throw new Error("结果尚未保存到后端资源库，不能关联镜头");
    const { project, source } = findTarget();
    const node: CanvasNodeData = { id: resultId, type: isImage ? CanvasNodeType.Image : CanvasNodeType.Video, title: `${source.title} · 本地生成 ${job.attempt}`, position: { x: source.position.x + source.width + 48, y: source.position.y }, width: 360, height: 260, metadata: { ...media, prompt: job.prompt, assetTags: ["本地生成", `镜头:${source.title}`], taskId: effectKey, directorSceneId: source.metadata?.directorSceneId, directorShotId: source.metadata?.directorShotId, workflowKind: isImage ? "reference_set" : "reference_video" } };
    const input = canvasNodeToAsset(node, { canvasId: context.projectId, source: "canvas-generation", taskId: effectKey });
    if (!input) throw new Error("结果不能登记为画布素材");
    const materializedId = await useAssetStore.getState().addGenerationAsset(effectKey, { ...input, metadata: { ...input.metadata, localComfyJobId: job.id, localComfyAssetId: asset.id, sourceNodeId: source.id, sourceShotId: context.shotId || source.id, sha256: asset.sha256, recipeId: job.recipe_id, seed: job.seed, attempt: job.attempt } }, signal);
    node.metadata = { ...node.metadata, assetId: materializedId };
    const linked = await ensureCanvasNodeAsset({ canvasId: context.projectId, domainProjectId: project.projectId, node, source: "canvas-generation", taskId: effectKey, signal });
    const latest = findTarget();
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const nodes = latest.project.nodes.filter((item) => item.id !== resultId).concat({ ...node, metadata: { ...node.metadata, assetId: linked.assetId } });
    const connectionId = `${resultId}-to-${source.id}`;
    const connections = latest.project.connections.filter((item) => item.id !== connectionId).concat({ id: connectionId, fromNodeId: resultId, toNodeId: source.id });
    useCanvasStore.getState().updateProject(context.projectId, { nodes, connections });
    await persistTarget();
    return linked.assetId;
}

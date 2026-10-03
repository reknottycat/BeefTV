import type { Asset } from "@/stores/use-asset-store";

export type BackendAssetPageOptions = {
    page: number;
    pageSize: number;
    kind?: string;
    category?: string;
    folderId?: string;
    uncategorized?: boolean;
    status?: string;
    query?: string;
    signal?: AbortSignal;
    favoriteOnly?: boolean;
    recentOnly?: boolean;
    projectLabel?: string;
    generatedOnly?: boolean;
    sort?: "updated_desc" | "updated_asc" | "name_asc";
};

export type BackendAssetPage = {
    assets: Asset[];
    kindCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    folderCounts: Record<string, number>;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
    matchingAssets?: Asset[];
};

export type BackendAssetPersistenceDependencies = {
    getCachedAssets: () => readonly Asset[];
    putAsset: (asset: Asset) => Promise<unknown>;
    flushCache: () => Promise<void>;
};

export class BackendAssetCacheError extends Error {
    readonly backendPersisted = true;
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("素材已保存到本机后端，但浏览器缓存写入失败");
        this.name = "BackendAssetCacheError";
        this.cause = cause;
    }
}

export function isBackendAssetCacheError(error: unknown): error is BackendAssetCacheError {
    return error instanceof BackendAssetCacheError;
}

export function appendMissingBackendAssets(cache: Asset[], backendPage: readonly Asset[]): Asset[] {
    const knownIds = new Set(cache.map((asset) => asset.id));
    const missing: Asset[] = [];
    for (const asset of backendPage) {
        if (knownIds.has(asset.id)) continue;
        knownIds.add(asset.id);
        missing.push(asset);
    }
    return missing.length ? [...cache, ...missing] : cache;
}

function throwIfAssetPageAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function validateBackendAssetPage(result: BackendAssetPage, requestedPage: number) {
    if (result.page !== requestedPage) throw new Error("后端素材分页不连续，请重新加载素材库");
    if (result.hasMore && result.assets.length === 0) throw new Error("后端素材分页为空但仍有后续页，请重新加载素材库");
}

function backendAssetProjectLabel(asset: Asset) {
    const name = asset.metadata?.projectName;
    if (typeof name === "string" && name.trim()) return name.trim();
    return Array.isArray(asset.metadata?.projectIds) && asset.metadata.projectIds.length ? "已关联项目" : "未关联项目";
}

function isGeneratedBackendAsset(asset: Asset) {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return false;
    return asset.source === "生成任务" || typeof asset.metadata?.generationEffectKey === "string";
}

export async function loadFilteredBackendAssetPage(
    options: BackendAssetPageOptions,
    fetchPage: (options: BackendAssetPageOptions) => Promise<BackendAssetPage>,
): Promise<BackendAssetPage> {
    throwIfAssetPageAborted(options.signal);
    const { page, pageSize, favoriteOnly, recentOnly, projectLabel, generatedOnly, sort, ...serverFilters } = options;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
        throw new Error("素材分页参数无效");
    }
    const selectedProject = projectLabel?.trim();
    const aggregate = favoriteOnly || recentOnly || selectedProject || generatedOnly || (sort && sort !== "updated_desc");
    const firstRequestedPage = aggregate ? 1 : page;
    const firstPage = await fetchPage({ ...serverFilters, page: firstRequestedPage, pageSize: aggregate ? 120 : pageSize });
    throwIfAssetPageAborted(options.signal);
    validateBackendAssetPage(firstPage, firstRequestedPage);
    if (!aggregate) return firstPage;

    const completeAssets = [...firstPage.assets];
    let previousPage = firstPage;
    while (previousPage.hasMore) {
        throwIfAssetPageAborted(options.signal);
        const requestedPage = previousPage.page + 1;
        const nextPage = await fetchPage({ ...serverFilters, page: requestedPage, pageSize: 120 });
        throwIfAssetPageAborted(options.signal);
        validateBackendAssetPage(nextPage, requestedPage);
        completeAssets.push(...nextPage.assets);
        previousPage = nextPage;
    }

    const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const matchingAssets = completeAssets.filter((asset) => {
        if (asset.kind === "entity") return false;
        if (favoriteOnly && asset.metadata?.favorite !== true) return false;
        if (recentOnly && !(Date.parse(asset.updatedAt) >= recentCutoff)) return false;
        if (selectedProject && backendAssetProjectLabel(asset) !== selectedProject) return false;
        if (generatedOnly && !isGeneratedBackendAsset(asset)) return false;
        return true;
    });
    if (sort === "name_asc") matchingAssets.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
    if (sort === "updated_asc") matchingAssets.sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    const start = (page - 1) * pageSize;
    return {
        ...firstPage,
        assets: matchingAssets.slice(start, start + pageSize),
        matchingAssets,
        page,
        pageSize,
        total: matchingAssets.length,
        hasMore: start + pageSize < matchingAssets.length,
    };
}

export async function persistSelectedBackendAssets(
    ids: Iterable<string>,
    { getCachedAssets, putAsset, flushCache }: BackendAssetPersistenceDependencies,
): Promise<void> {
    if (ids == null || typeof ids === "string") throw new Error("请选择要保存的素材 ID");
    const selectedIds: string[] = [];
    const seen = new Set<string>();
    for (const value of ids) {
        if (typeof value !== "string" || !value.trim()) throw new Error("素材 ID 不能为空");
        const id = value.trim();
        if (seen.has(id)) continue;
        seen.add(id);
        selectedIds.push(id);
    }
    if (!selectedIds.length) throw new Error("请选择要保存的素材 ID");

    const cachedAssets = new Map(getCachedAssets().map((asset) => [asset.id, asset]));
    // Resolve every selection before starting writes, so a stale ID cannot
    // turn an invalid selection into a partially submitted request.
    const selectedAssets = selectedIds.map((id) => {
        const asset = cachedAssets.get(id);
        if (!asset) throw new Error("部分素材不存在，请重新选择素材");
        return asset;
    });
    for (const asset of selectedAssets) await putAsset(asset);

    try {
        await flushCache();
    } catch (error) {
        throw new BackendAssetCacheError(error);
    }
}

// @ts-ignore Bun provides this built-in without an installed type package.
import { expect, test } from "bun:test";
import type { Asset } from "@/stores/use-asset-store";
import {
    appendMissingBackendAssets,
    BackendAssetCacheError,
    isBackendAssetCacheError,
    loadFilteredBackendAssetPage,
    persistSelectedBackendAssets,
    type BackendAssetPage,
    type BackendAssetPageOptions,
} from "./workspace-asset-backend";

function asset(id: string, title = id): Asset {
    return {
        id,
        kind: "text",
        title,
        coverUrl: "",
        tags: [],
        data: { content: title },
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
    };
}

test("backend pages append missing IDs while preserving dirty cache objects and earlier pages", () => {
    const dirty = asset("dirty", "unsaved local edit");
    const cache = [dirty];
    Object.freeze(dirty);
    Object.freeze(cache);
    const first = asset("first");
    const second = asset("second");
    const pageOne = [asset("dirty", "older backend value"), first, asset("first", "duplicate")];
    const mergedOne = appendMissingBackendAssets(cache, pageOne);
    const mergedTwo = appendMissingBackendAssets(mergedOne, [asset("first", "different backend value"), second]);

    expect(mergedTwo.map((item) => item.id)).toEqual(["dirty", "first", "second"]);
    expect(mergedTwo[0]).toBe(dirty);
    expect(mergedTwo[0].title).toBe("unsaved local edit");
    expect(mergedTwo[1]).toBe(first);
    expect(mergedTwo[2]).toBe(second);
    expect(cache).toEqual([dirty]);
    expect(pageOne.map((item) => item.id)).toEqual(["dirty", "first", "first"]);
    expect(appendMissingBackendAssets(mergedTwo, [asset("dirty")])).toBe(mergedTwo);
});

test("only explicitly selected assets are submitted once and cache flush follows every PUT", async () => {
    const cache = [asset("unselected"), asset("a"), asset("b")];
    const events: string[] = [];
    const submitted: Asset[] = [];
    let reads = 0;
    await persistSelectedBackendAssets(["b", " a ", "b", "a"], {
        getCachedAssets: () => { reads += 1; return cache; },
        putAsset: async (item) => {
            events.push(`start:${item.id}`);
            await Promise.resolve();
            submitted.push(item);
            events.push(`done:${item.id}`);
        },
        flushCache: async () => { events.push("flush"); },
    });

    expect(submitted).toEqual([cache[2], cache[1]]);
    expect(events).toEqual(["start:b", "done:b", "start:a", "done:a", "flush"]);
    expect(reads).toBe(1);
    expect(cache.map((item) => item.id)).toEqual(["unselected", "a", "b"]);
});

test("empty IDs, blank IDs, and a scalar ID are rejected before any backend or cache action", async () => {
    const events: string[] = [];
    const dependencies = {
        getCachedAssets: () => { events.push("read"); return [asset("a")]; },
        putAsset: async () => { events.push("put"); },
        flushCache: async () => { events.push("flush"); },
    };
    for (const ids of [[], ["a", " "], "a" as unknown as Iterable<string>]) {
        await expect(persistSelectedBackendAssets(ids, dependencies)).rejects.toThrow();
    }
    expect(events).toEqual([]);
});

test("a missing selection prevents every PUT even when an earlier selection exists", async () => {
    const cache = [asset("a")];
    const events: string[] = [];
    await expect(persistSelectedBackendAssets(["a", "missing"], {
        getCachedAssets: () => cache,
        putAsset: async (item) => { events.push(item.id); },
        flushCache: async () => { events.push("flush"); },
    })).rejects.toThrow("部分素材不存在");

    expect(events).toEqual([]);
    expect(cache).toEqual([asset("a")]);
});

test("backend failure preserves the cache, propagates the original error, and skips flush", async () => {
    const cache = [asset("a"), asset("b")];
    const original = [...cache];
    Object.freeze(cache);
    for (const item of cache) Object.freeze(item);
    const failure = new Error("backend unavailable");
    const events: string[] = [];
    let caught: unknown;
    try {
        await persistSelectedBackendAssets(["a", "b"], {
            getCachedAssets: () => cache,
            putAsset: async (item) => { events.push(item.id); throw failure; },
            flushCache: async () => { events.push("flush"); },
        });
    } catch (error) {
        caught = error;
    }

    expect(caught).toBe(failure);
    expect(isBackendAssetCacheError(caught)).toBe(false);
    expect(events).toEqual(["a"]);
    expect(cache).toEqual(original);
    expect(cache[0]).toBe(original[0]);
    expect(cache[1]).toBe(original[1]);
});

test("a later backend failure stops remaining selected writes without retry or cache flush", async () => {
    const cache = [asset("a"), asset("b"), asset("c")];
    const failure = new Error("second PUT failed");
    const events: string[] = [];
    await expect(persistSelectedBackendAssets(["a", "b", "c"], {
        getCachedAssets: () => cache,
        putAsset: async (item) => { events.push(item.id); if (item.id === "b") throw failure; },
        flushCache: async () => { events.push("flush"); },
    })).rejects.toThrow("second PUT failed");

    expect(events).toEqual(["a", "b"]);
    expect(cache).toEqual([asset("a"), asset("b"), asset("c")]);
});

test("cache failure after successful backend writes identifies backend persistence and retains its cause", async () => {
    const cache = [asset("a"), asset("b")];
    const failure = new Error("IndexedDB quota");
    const events: string[] = [];
    let caught: unknown;
    try {
        await persistSelectedBackendAssets(["a", "b"], {
            getCachedAssets: () => cache,
            putAsset: async (item) => { events.push(item.id); },
            flushCache: async () => { events.push("flush"); throw failure; },
        });
    } catch (error) {
        caught = error;
    }

    expect(events).toEqual(["a", "b", "flush"]);
    expect(caught).toBeInstanceOf(BackendAssetCacheError);
    expect(isBackendAssetCacheError(caught)).toBe(true);
    if (!isBackendAssetCacheError(caught)) throw new Error("Expected a backend/cache error");
    expect(caught.backendPersisted).toBe(true);
    expect(caught.cause).toBe(failure);
    expect(caught.message).toContain("素材已保存到本机后端");
    expect(isBackendAssetCacheError({ backendPersisted: true })).toBe(false);
    expect(cache).toEqual([asset("a"), asset("b")]);
});

function backendPage(page: number, assets: Asset[], hasMore = false): BackendAssetPage {
    return {
        assets,
        page,
        pageSize: 120,
        total: 4,
        hasMore,
        kindCounts: { text: 10, image: 3 },
        categoryCounts: { other: 10, material: 3 },
        folderCounts: { "": 13 },
    };
}

test("favorites include later backend pages before slicing and retain the first server status facets", async () => {
    const firstFavorite = { ...asset("first-favorite"), metadata: { favorite: true } };
    const lastFavorite = { ...asset("last-favorite"), metadata: { favorite: true } };
    const entity: Asset = { ...asset("entity"), kind: "entity", metadata: { favorite: true }, data: { definition: {} } };
    const pages = [backendPage(1, [asset("not-favorite"), firstFavorite], true), backendPage(2, [lastFavorite, entity])];
    pages[1].kindCounts = { entity: 99 };
    const requests: BackendAssetPageOptions[] = [];
    const result = await loadFilteredBackendAssetPage({ page: 2, pageSize: 1, favoriteOnly: true, status: "active" }, async (options) => {
        requests.push(options);
        return pages[options.page - 1];
    });

    expect(requests).toEqual([{ page: 1, pageSize: 120, status: "active" }, { page: 2, pageSize: 120, status: "active" }]);
    expect(result.assets).toEqual([lastFavorite]);
    expect(result.matchingAssets).toEqual([firstFavorite, lastFavorite]);
    expect(result.total).toBe(2);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.kindCounts).toBe(pages[0].kindCounts);
    expect(result.categoryCounts).toBe(pages[0].categoryCounts);
    expect(result.folderCounts).toBe(pages[0].folderCounts);
    expect(pages[0].assets).toEqual([asset("not-favorite"), firstFavorite]);
});

test("project filters match names across pages and use the linked-project fallback only without a name", async () => {
    const namedOne = { ...asset("named-one"), metadata: { projectName: " 剧本甲 ", projectIds: ["p1"] } };
    const namedTwo = { ...asset("named-two"), metadata: { projectName: "剧本甲" } };
    const linked = { ...asset("linked"), metadata: { projectName: " ", projectIds: ["p2"] } };
    const pages = [backendPage(1, [namedOne, asset("unlinked")], true), backendPage(2, [namedTwo, linked])];
    for (const [projectLabel, expectedIds] of [["剧本甲", ["named-one", "named-two"]], ["已关联项目", ["linked"]], ["未关联项目", ["unlinked"]]] as const) {
        const requests: number[] = [];
        const result = await loadFilteredBackendAssetPage({ page: 1, pageSize: 20, projectLabel }, async (options) => {
            requests.push(options.page);
            return pages[options.page - 1];
        });
        expect(requests).toEqual([1, 2]);
        expect(result.assets.map((item) => item.id)).toEqual([...expectedIds]);
        expect(result.total).toBe(expectedIds.length);
    }
});

test("name and ascending-time sorts order complete backend results before UI pagination", async () => {
    const zulu = { ...asset("zulu", "Zulu"), updatedAt: "2026-10-04T00:00:00Z" };
    const charlie = { ...asset("charlie", "Charlie"), updatedAt: "2026-10-03T00:00:00Z" };
    const alpha = { ...asset("alpha", "Alpha"), updatedAt: "2026-10-02T00:00:00Z" };
    const bravo = { ...asset("bravo", "Bravo"), updatedAt: "2026-10-01T00:00:00Z" };
    const pages = [backendPage(1, [zulu, charlie], true), backendPage(2, [alpha, bravo])];
    const fetchPage = async (options: BackendAssetPageOptions) => pages[options.page - 1];
    const named = await loadFilteredBackendAssetPage({ page: 2, pageSize: 2, sort: "name_asc" }, fetchPage);
    const oldest = await loadFilteredBackendAssetPage({ page: 1, pageSize: 2, sort: "updated_asc" }, fetchPage);

    expect(named.assets.map((item) => item.id)).toEqual(["charlie", "zulu"]);
    expect(named.matchingAssets?.map((item) => item.id)).toEqual(["alpha", "bravo", "charlie", "zulu"]);
    expect(named.total).toBe(4);
    expect(named.hasMore).toBe(false);
    expect(oldest.assets.map((item) => item.id)).toEqual(["bravo", "alpha"]);
    expect(oldest.hasMore).toBe(true);
    expect(pages[0].assets).toEqual([zulu, charlie]);
    expect(pages[1].assets).toEqual([alpha, bravo]);
});

test("ordinary backend filters request one page and keep its original totals and continuation", async () => {
    const original = { ...backendPage(3, [asset("server-filtered")], true), pageSize: 40, total: 130 };
    const requests: BackendAssetPageOptions[] = [];
    const options: BackendAssetPageOptions = {
        page: 3, pageSize: 40, kind: "text", category: "other", folderId: "folder", uncategorized: false,
        status: "active", query: "query", sort: "updated_desc", favoriteOnly: false,
    };
    const result = await loadFilteredBackendAssetPage(options, async (request) => { requests.push(request); return original; });

    expect(requests).toEqual([{
        page: 3, pageSize: 40, kind: "text", category: "other", folderId: "folder", uncategorized: false, status: "active", query: "query",
    }]);
    expect(result).toBe(original);
    expect(result.total).toBe(130);
    expect(result.hasMore).toBe(true);
    expect(result.matchingAssets).toBeUndefined();
});

test("recent generated filters scan all pages and require media generation provenance within thirty days", async () => {
    const now = Date.now();
    const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const image = (id: string, source: string, updatedAt = recent): Asset => ({
        ...asset(id), kind: "image", source, updatedAt,
        data: { dataUrl: "/api/resources/example/file", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
    });
    const generated = image("generated", "生成任务");
    const effect = { ...image("effect", ""), metadata: { generationEffectKey: "task-effect" } };
    const pages = [
        backendPage(1, [image("manual", "手动上传"), image("old", "生成任务", old)], true),
        backendPage(2, [generated, effect, { ...asset("generated-text"), source: "生成任务", updatedAt: recent }, image("invalid-time", "生成任务", "invalid")]),
    ];
    const result = await loadFilteredBackendAssetPage({ page: 1, pageSize: 1, recentOnly: true, generatedOnly: true }, async (options) => pages[options.page - 1]);

    expect(result.assets).toEqual([generated]);
    expect(result.matchingAssets).toEqual([generated, effect]);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
});

test("aborted reads reject before the first request and after an ignored in-flight cancellation", async () => {
    const before = new AbortController();
    before.abort();
    let requests = 0;
    await expect(loadFilteredBackendAssetPage({ page: 1, pageSize: 20, signal: before.signal }, async () => {
        requests += 1;
        return backendPage(1, []);
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);

    const during = new AbortController();
    await expect(loadFilteredBackendAssetPage({ page: 1, pageSize: 20, favoriteOnly: true, signal: during.signal }, async (options) => {
        requests += 1;
        expect(options.signal).toBe(during.signal);
        during.abort();
        return backendPage(1, [asset("first")], true);
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1);
});

test("discontinuous or empty continuing pages reject instead of returning incomplete filtered data", async () => {
    let requests = 0;
    await expect(loadFilteredBackendAssetPage({ page: 1, pageSize: 20, favoriteOnly: true }, async (options) => {
        requests += 1;
        return backendPage(1, [asset(options.page === 1 ? "first" : "repeated")], true);
    })).rejects.toThrow("分页不连续");
    expect(requests).toBe(2);

    requests = 0;
    await expect(loadFilteredBackendAssetPage({ page: 2, pageSize: 20 }, async () => {
        requests += 1;
        return backendPage(2, [], true);
    })).rejects.toThrow("分页为空但仍有后续页");
    expect(requests).toBe(1);
});

test("a later page request failure propagates without presenting the first filtered page as complete", async () => {
    const failure = new Error("page two unavailable");
    const requests: number[] = [];
    let caught: unknown;
    try {
        await loadFilteredBackendAssetPage({ page: 1, pageSize: 20, favoriteOnly: true }, async (options) => {
            requests.push(options.page);
            if (options.page === 2) throw failure;
            return backendPage(1, [{ ...asset("favorite"), metadata: { favorite: true } }], true);
        });
    } catch (error) {
        caught = error;
    }
    expect(caught).toBe(failure);
    expect(requests).toEqual([1, 2]);
});

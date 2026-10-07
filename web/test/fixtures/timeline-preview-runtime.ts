export const receipt = { sources: [] as { storageKey: string; url: string }[], unavailable: false };

export async function resolveMediaUrl(storageKey: string, fallback: string) {
    receipt.sources.push({ storageKey, url: fallback.slice(0, 60) });
    if (receipt.unavailable || storageKey === "resource:unselected" || fallback.includes("unselected")) throw new Error("fixture unavailable");
    return fallback;
}
export async function cacheResourceObjectUrl() { return null; }
export function resourceIdFromStorageKey(key?: string) { return key?.startsWith("resource:") ? key.slice(9) : null; }

export type LocalComfyMode = "image" | "video";
export type LocalComfyDefault = { recipeId: string; seed: string };
export type LocalComfyDefaults = Partial<Record<LocalComfyMode, LocalComfyDefault>>;
export type LocalRecipeOption = { id: string; name: string; mode: string; ready: boolean; reference_slots: number };

export function normalizeLocalComfyMode(value: unknown): LocalComfyMode | undefined {
    return value === "image" || value === "video" ? value : undefined;
}

export function normalizeLocalComfyDefaults(value: unknown): LocalComfyDefaults {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const result: LocalComfyDefaults = {};
    for (const mode of ["image", "video"] as const) {
        const item = record[mode];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const selection = item as Record<string, unknown>;
        if (typeof selection.recipeId !== "string" || !selection.recipeId.trim()) continue;
        result[mode] = {
            recipeId: selection.recipeId.trim(),
            seed: typeof selection.seed === "string" ? selection.seed : typeof selection.seed === "number" ? String(selection.seed) : "0",
        };
    }
    return result;
}

export function localComfyRecipeMode(recipe: Pick<LocalRecipeOption, "mode">): LocalComfyMode | undefined {
    if (recipe.mode === "t2i" || recipe.mode === "i2i") return "image";
    if (recipe.mode === "t2v" || recipe.mode === "i2v") return "video";
    return undefined;
}

export function localComfySeedProblem(seed: string) {
    const number = Number(seed);
    return /^\d+$/.test(seed) && Number.isInteger(number) && number >= 0 && number <= 4_294_967_295
        ? "" : "种子需为 0 到 4294967295 的整数";
}

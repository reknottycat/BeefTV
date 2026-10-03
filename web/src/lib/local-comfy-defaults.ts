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

export function localComfyDefaultProblem(selection: LocalComfyDefault | undefined, recipes: readonly LocalRecipeOption[], mode: LocalComfyMode) {
    if (!selection?.recipeId) return "尚未配置本地默认配方";
    const recipe = recipes.find((item) => item.id === selection.recipeId);
    if (!recipe) return "已保存的配方当前未登记，请重新选择";
    if (localComfyRecipeMode(recipe) !== mode) return "已保存的配方与当前生成用途不一致，请重新选择";
    if (!recipe.ready) return "已保存的配方当前未就绪，请检查工作流配置";
    return localComfySeedProblem(selection.seed);
}

// Missing/stale preferences remain visible; opening a workflow never switches
// to another recipe or a cloud channel without the user's selection.
export function localComfyEntrySelection(defaults: LocalComfyDefaults | undefined, mode: LocalComfyMode) {
    const saved = normalizeLocalComfyDefaults(defaults)[mode];
    return saved ? { ...saved } : { recipeId: "", seed: "0" };
}

export function applyLocalComfyEntryDefaults(saved: LocalComfyDefault, current: LocalComfyDefault, edited: { recipe: boolean; seed: boolean }): LocalComfyDefault {
    return {
        recipeId: edited.recipe ? current.recipeId : saved.recipeId,
        seed: edited.seed ? current.seed : saved.seed,
    };
}

export function localComfyDefaultsReady(defaults: LocalComfyDefaults | undefined, recipes: readonly LocalRecipeOption[] | undefined, catalogUsable: boolean): boolean {
    if (!catalogUsable || !recipes) return false;
    const saved = normalizeLocalComfyDefaults(defaults);
    return (["image", "video"] as const).some((mode) => saved[mode] && !localComfyDefaultProblem(saved[mode], recipes, mode));
}

// The existing native autosave gate needs a cloud channel. Local defaults use
// the same canonical repository directly, including a zero-channel workspace.
export function persistLocalComfyDefaultDraft<Config>(defaults: LocalComfyDefaults, dependencies: {
    updateDefaults: (defaults: LocalComfyDefaults) => void;
    readConfig: () => Config;
    commitConfig: (config: Config) => Promise<unknown>;
}) {
    dependencies.updateDefaults(normalizeLocalComfyDefaults(defaults));
    return dependencies.commitConfig(dependencies.readConfig());
}

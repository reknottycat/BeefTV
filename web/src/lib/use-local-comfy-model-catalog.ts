import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getLocalComfyConfig, listLocalComfyRecipes, type LocalComfyConfig, type LocalComfyRecipe } from "@/services/api/local-comfy";
import { getUserScopeGeneration, subscribeUserScope } from "@/lib/user-scope";
import { validatedLocalComfyRecipes, type LocalComfyModelConfig, type LocalComfyStatus } from "@/lib/local-comfy-models";

export function localComfyCatalogState(input: { config?: LocalComfyConfig; recipes?: LocalComfyRecipe[]; failed: boolean }): LocalComfyModelConfig {
    const { config, recipes, failed } = input;
    let status: LocalComfyStatus = "loading";
    if (failed) status = "offline";
    else if (config?.configured === false) status = "unconfigured";
    else if (config && recipes) {
        if (!recipes.length) status = "empty";
        else if (!validatedLocalComfyRecipes(recipes).length) status = "unsupported";
        else if (!validatedLocalComfyRecipes(recipes).some((recipe) => recipe.ready)) status = "not_ready";
        else status = config.generation_enabled ? "ready" : "disabled";
    }
    return { localComfyModels: recipes || [], localComfyStatus: status, localComfyGenerationEnabled: status === "ready", localComfyMaxReferenceBytes: config?.max_reference_bytes };
}

export function useLocalComfyModelCatalog() {
    const scopeGeneration = useSyncExternalStore(subscribeUserScope, getUserScopeGeneration, getUserScopeGeneration);
    const runtime = useQuery({ queryKey: ["local-comfy", scopeGeneration, "config"], queryFn: ({ signal }) => getLocalComfyConfig(signal), retry: false, staleTime: 30_000 });
    const recipes = useQuery({ queryKey: ["local-comfy", scopeGeneration, "recipes"], queryFn: ({ signal }) => listLocalComfyRecipes(signal), enabled: runtime.data?.configured === true, retry: false, staleTime: 30_000 });
    const state = useMemo(() => localComfyCatalogState({ config: runtime.data, recipes: recipes.data, failed: runtime.isError || (runtime.data?.configured === true && recipes.isError) }), [runtime.data, runtime.isError, recipes.data, recipes.isError]);
    return useMemo(() => ({ ...state, refreshing: runtime.isFetching || recipes.isFetching, refresh: async () => {
        const result = await runtime.refetch();
        if (result.data?.configured) await recipes.refetch();
    } }), [state, runtime.isFetching, recipes.isFetching, runtime.refetch, recipes.refetch]);
}

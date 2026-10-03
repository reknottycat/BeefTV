import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getLocalComfyConfig, listLocalComfyRecipes } from "@/services/api/local-comfy";
import { validatedLocalComfyRecipes, type LocalComfyModelConfig } from "@/lib/local-comfy-models";

export function useLocalComfyModelCatalog(): LocalComfyModelConfig {
    const recipes = useQuery({ queryKey: ["local-comfy", "native-model-recipes"], queryFn: ({ signal }) => listLocalComfyRecipes(signal), retry: false, staleTime: 30_000 });
    const runtime = useQuery({ queryKey: ["local-comfy", "native-model-runtime"], queryFn: ({ signal }) => getLocalComfyConfig(signal), retry: false, staleTime: 30_000 });
    return useMemo(() => ({
        // Failed revalidation removes selectable entries but preserves saved IDs.
        localComfyModels: recipes.isSuccess ? validatedLocalComfyRecipes(recipes.data) : [],
        localComfyGenerationEnabled: runtime.isSuccess && !runtime.isFetching && runtime.data.generation_enabled === true,
    }), [recipes.data, recipes.isSuccess, runtime.data, runtime.isSuccess, runtime.isFetching]);
}

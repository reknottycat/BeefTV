import { http } from "./request";

export type LocalComfyConfig = {
    configured: boolean;
    generation_enabled: boolean;
    max_reference_bytes: number;
    recipe_count: number;
};

export type LocalComfyRecipe = {
    id: string;
    name: string;
    mode: string;
    ready: boolean;
    recipe_version: string;
    reference_slots: number;
    reference_constraints?: Array<{ role?: string; width: number; height: number; mime_types: string[] }>;
    output?: { width: number; height: number; fps?: number; duration_seconds?: number; mime_type?: string };
};

export function getLocalComfyConfig(signal?: AbortSignal) {
    return http.get<LocalComfyConfig>("/local-comfy/v1/config", { signal });
}

export function listLocalComfyRecipes(signal?: AbortSignal) {
    return http.get<LocalComfyRecipe[]>("/local-comfy/v1/recipes", { signal });
}

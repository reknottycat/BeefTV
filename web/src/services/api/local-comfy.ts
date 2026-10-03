import { ApiError, apiBaseURL, http } from "@/services/api/request";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const BASE = "/local-comfy/v1";
const TIMEOUT = 15_000;
export const localComfyServiceUrl = `${String(apiBaseURL).replace(/\/$/, "")}${BASE}`;

export type LocalComfyConfig = { generation_enabled: boolean; storage_scope: "sidecar"; concurrency: number; max_reference_bytes: number; recipe_count: number; comfyui_endpoint?: string };
export type LocalComfyRecipe = { id: string; name: string; mode: string; reference_slots: number; ready: boolean; reference_constraints?: Array<{ role: string; width: number; height: number; mime_types: string[] }> };
export type LocalComfyProject = { id: string; name: string; upstream_project_id: string | null; canvas_project_id?: string | null; storage_scope: "sidecar"; script: string; created_at: string };
export type LocalComfyAsset = { id: string; project_id: string; name: string; kind: string; mime_type: string; size: number; sha256: string; source: string; upstream_asset_id: string | null; job_id?: string; shot_id?: string; width?: number; height?: number; content_url: string; created_at: string };
export type LocalComfyShot = { id: string; project_id: string; name: string; upstream_shot_id: string | null; reference_asset_ids: string[]; created_at: string };
export type LocalComfyJobStatus = "submitting" | "submitted" | "running" | "completed" | "failed" | "submission_unknown";
export type LocalComfyJob = { id: string; project_id: string; shot_id: string; recipe_id: string; prompt: string; seed: number; reference_asset_ids: string[]; request_key: string; attempt: number; parent_job_id: string | null; prompt_id: string | null; status: LocalComfyJobStatus; error: string | null; results: Array<{ node_id: string; filename: string; subfolder: string; type: string }>; archived_asset_ids: string[]; created_at: string; updated_at: string; deduplicated?: boolean; workflow_sha256?: string; recipe_sha256?: string; output_nodes?: string[] };
export type LocalComfyJobInput = { project_id: string; shot_id: string; recipe_id: string; prompt: string; seed: number; reference_asset_ids: string[]; request_key: string };

const options = (signal?: AbortSignal) => ({ signal, timeout: TIMEOUT });
export const getLocalComfyConfig = (signal?: AbortSignal) => http.get<LocalComfyConfig>(`${BASE}/config`, options(signal));
export const listLocalComfyRecipes = (signal?: AbortSignal) => http.get<LocalComfyRecipe[]>(`${BASE}/recipes`, options(signal));
export const listLocalComfyProjects = (signal?: AbortSignal) => http.get<LocalComfyProject[]>(`${BASE}/projects`, options(signal));
export const createLocalComfyProject = (input: { name: string; upstream_project_id?: string; canvas_project_id?: string }, signal?: AbortSignal) => http.post<LocalComfyProject>(`${BASE}/projects`, input, options(signal));
export const saveLocalComfyScript = (id: string, script: string, signal?: AbortSignal) => http.post<LocalComfyProject>(`${BASE}/projects/${encodeURIComponent(id)}/script`, { script, format: "text" }, options(signal));
export const listLocalComfyShots = (projectId: string, signal?: AbortSignal) => http.get<LocalComfyShot[]>(`${BASE}/shots`, { ...options(signal), params: { project_id: projectId } });
export const createLocalComfyShot = (input: { project_id: string; name: string; upstream_shot_id?: string; reference_asset_ids?: string[] }, signal?: AbortSignal) => http.post<LocalComfyShot>(`${BASE}/shots`, input, options(signal));
export const listLocalComfyAssets = (projectId: string, signal?: AbortSignal) => http.get<LocalComfyAsset[]>(`${BASE}/assets`, { ...options(signal), params: { project_id: projectId } });
export const getLocalComfyAsset = (id: string, signal?: AbortSignal) => http.get<LocalComfyAsset>(`${BASE}/assets/${encodeURIComponent(id)}`, options(signal));
export const uploadLocalComfyReference = (input: { project_id: string; name: string; kind: "character" | "scene" | "prop" | "reference"; mime_type: string; data_base64: string; upstream_asset_id?: string }, signal?: AbortSignal) => http.post<LocalComfyAsset>(`${BASE}/assets`, input, options(signal));
export const listLocalComfyJobs = (projectId: string, shotId?: string, signal?: AbortSignal) => http.get<LocalComfyJob[]>(`${BASE}/jobs`, { ...options(signal), params: { project_id: projectId, shot_id: shotId } });
export const createLocalComfyJob = (input: LocalComfyJobInput, signal?: AbortSignal) => http.post<LocalComfyJob>(`${BASE}/jobs`, input, options(signal));
export const pollLocalComfyJob = (id: string, signal?: AbortSignal) => http.post<LocalComfyJob>(`${BASE}/jobs/${encodeURIComponent(id)}/poll`, {}, options(signal));
export const archiveLocalComfyJob = (id: string, signal?: AbortSignal) => http.post<LocalComfyJob>(`${BASE}/jobs/${encodeURIComponent(id)}/archive`, {}, { ...options(signal), timeout: 60_000 });
export const retryLocalComfyJob = (id: string, input: { request_key: string; prompt?: string; seed?: number }, signal?: AbortSignal) => http.post<LocalComfyJob>(`${BASE}/jobs/${encodeURIComponent(id)}/retry`, input, options(signal));
export async function readLocalComfyAssetBlob(id: string, signal?: AbortSignal) {
    const result = await http.raw<Blob>({ method: "get", url: `${BASE}/assets/${encodeURIComponent(id)}/content`, responseType: "blob", signal, timeout: 60_000 });
    return result.data;
}
export const localComfyAssetContentUrl = (id: string) => `${String(apiBaseURL).replace(/\/$/, "")}${BASE}/assets/${encodeURIComponent(id)}/content`;

export type LocalComfyCanvasSave = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt"> & { revision: number };
export async function getLocalComfyBackendCanvas(id: string, signal?: AbortSignal) {
    return (await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`, options(signal))).project;
}
export async function getLocalComfyBackendAsset(id: string, signal?: AbortSignal) {
    try {
        return (await http.get<{ asset: Asset }>(`/assets/${encodeURIComponent(id)}`, options(signal))).asset;
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
    }
}
export async function commitLocalComfyBackendResult(project: CanvasProject, asset: Asset, signal?: AbortSignal) {
    return (await http.put<{ project: LocalComfyCanvasSave }>(`/canvas-projects/${encodeURIComponent(project.id)}/generated-assets`, { project, assets: [asset] }, options(signal))).project;
}

import { compactApiParams, http } from "@/services/api/request";

const API_PREFIX = "/asset-index/v1";

export type ProductionAssetIndexSourceHealth = {
    source: string;
    state: string;
    error?: string;
    observed_at: number;
    last_success?: number;
};

export type ProductionAssetIndexMetadata = {
    catalog_revision: string;
    source_health: ProductionAssetIndexSourceHealth[];
};

export type ProductionAssetStateDimension = "generation" | "technical_qa" | "visual_review" | "user_acceptance" | "availability";

export type ProductionAssetStateClaim = {
    value: unknown;
    source: string;
    pointer: string;
    field: string;
    scope?: "current" | "historical" | "context" | "planned" | "input" | "audio";
    semantic_value?: unknown;
};

export type ProductionAssetState = {
    value: unknown;
    conflict: boolean;
    claims: ProductionAssetStateClaim[];
};

export type ProductionAssetStates = Record<ProductionAssetStateDimension, ProductionAssetState>;
export type ProductionAssetConflict = ProductionAssetState & { dimension: ProductionAssetStateDimension };

export type ProductionAssetSource = {
    source: string;
    pointer: string;
    source_sha256?: string;
    last_success?: number;
};

export type ProductionAssetBlob = {
    id: string;
    sha256: string | null;
    declared_sha256: string | null;
    verified_sha256: string | null;
    hash_state: "verified" | "declared" | "not_hashed";
    size_bytes: number | null;
    location_ids: string[];
};

export type ProductionAssetReviewHistoryEntry = {
    dimension: "technical_qa" | "visual_review" | "user_acceptance";
    claims: ProductionAssetStateClaim[];
};

export type ProductionAssetVersion = {
    id: string;
    asset_id: string;
    label: string;
    blob_ids: string[];
    blobs: ProductionAssetBlob[];
    location_ids: string[];
    sources: ProductionAssetSource[];
    states: ProductionAssetStates;
    record_state?: "historical_not_in_current_snapshot";
    review_history?: ProductionAssetReviewHistoryEntry[];
};

export type ProductionAsset = {
    id: string;
    native_id: string;
    kind: string;
    label: string;
    project_id: string;
    states: ProductionAssetStates;
    conflicts: ProductionAssetConflict[];
    versions: ProductionAssetVersion[];
    thumbnail_url: string | null;
    version_count: number;
    record_state?: "retained_not_in_current_sources";
};

export type ProductionAssetEdge = ProductionAssetSource & {
    from_id: string;
    to_id: string;
    type: string;
};

export type ProductionAssetLocation = {
    id: string;
    path: string;
    resolved_path: string | null;
    original_paths: string[];
    host: "local" | "dgx";
    root_alias: string;
    state: "available" | "remote_only" | "unmapped" | "outside_whitelist" | "missing_or_offline" | "historical_missing_or_changed";
    mime_type: string;
    size_bytes?: number;
    mtime_ns?: number;
    media_url: string | null;
    thumbnail_url: string | null;
};

export type ProductionAssetJob = ProductionAssetSource & {
    id: string;
    prompt_id: string;
    status: unknown;
    recovery: "observe_only_no_resubmit";
};

export type ProductionAssetDetail = ProductionAsset & {
    sources: ProductionAssetSource[];
    edges: ProductionAssetEdge[];
    locations: ProductionAssetLocation[];
    jobs: ProductionAssetJob[];
};

export type ProductionAssetDetailResponse = ProductionAssetDetail & ProductionAssetIndexMetadata;

export type ProductionAssetProjectCounts = {
    logical_assets: number;
    versions: number;
    mother_shots: number;
    generation_units: number;
    observed_files: number;
    current_scan_observed_files: number;
    retained_known_files: number;
    declared_or_verified_blob_groups: number;
    verified_unique_blobs: number;
};

export type ProductionAssetScanJournal = {
    id: number;
    started: number;
    finished: number | null;
    summary: string | null;
};

export type ProductionAssetScanError = {
    id: number;
    scan_id: number;
    source: string;
    error: string;
    recorded: number;
};

export type ProductionAssetProject = {
    id: string;
    name: string;
    root: string;
    states: ProductionAssetStates;
    conflicts: ProductionAssetConflict[];
    counts: ProductionAssetProjectCounts;
    count_scope: string;
    scan_journal: ProductionAssetScanJournal[];
    scan_errors: ProductionAssetScanError[];
};

export type ProductionAssetShot = ProductionAssetDetailResponse & {
    related_assets: ProductionAssetDetail[];
    lineage_completeness: string;
};

export type ProductionAssetIndexCollection<T> = ProductionAssetIndexMetadata & {
    items: T[];
    total: number;
};

export type ProductionAssetIndexPage<T> = ProductionAssetIndexCollection<T> & {
    limit: number;
    offset: number;
};

export type ProductionAssetIndexPageOptions = {
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
};

export type ProductionAssetListOptions = ProductionAssetIndexPageOptions & {
    projectId?: string;
    kind?: string;
    query?: string;
    state?: string;
    hasConflict?: boolean;
};

export function listProductionAssetProjects(signal?: AbortSignal) {
    return http.get<ProductionAssetIndexCollection<ProductionAssetProject>>(`${API_PREFIX}/projects`, { signal });
}

export function listProductionAssets(options: ProductionAssetListOptions = {}) {
    return http.get<ProductionAssetIndexPage<ProductionAssetDetail>>(`${API_PREFIX}/assets`, {
        signal: options.signal,
        params: compactApiParams({
            project_id: options.projectId,
            kind: options.kind,
            q: options.query,
            state: options.state,
            has_conflict: options.hasConflict === undefined ? undefined : String(options.hasConflict),
            limit: options.limit,
            offset: options.offset,
        }),
    });
}

export function getProductionAsset(id: string, signal?: AbortSignal) {
    return http.get<ProductionAssetDetailResponse>(`${API_PREFIX}/assets/${encodeURIComponent(id)}`, { signal });
}

export function getProductionShot(nativeId: string, signal?: AbortSignal) {
    return http.get<ProductionAssetShot>(`${API_PREFIX}/shots/${encodeURIComponent(nativeId)}`, { signal });
}

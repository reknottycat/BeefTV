import { getLocalModelConfig, saveLocalModelConfig, type LocalModelConfigPayload } from "@/services/api/workspace";
import type { AiConfig } from "@/stores/use-config-store";

export type ModelConfigPersistenceState = {
    status: "idle" | "hydrating" | "saving" | "saved" | "error";
    revision: number;
    dirty: boolean;
    error: string;
    conflictRevision?: number;
};

type ModelConfigRepositoryDependencies = {
    read: () => Promise<LocalModelConfigPayload>;
    write: (config: AiConfig, expectedRevision: number) => Promise<{ saved: boolean; revision: number }>;
};

export function createModelConfigRepository(dependencies: ModelConfigRepositoryDependencies) {
    let state: ModelConfigPersistenceState = { status: "idle", revision: 0, dirty: false, error: "" };
    let hydrated = false;
    let revisionConflict = false;
    let canonicalReadFailed = false;
    let latestConfig: AiConfig | null = null;
    let generation = 0;
    let drainPromise: Promise<void> | null = null;
    let resolveHydration: (() => void) | null = null;
    const hydrationBarrier = new Promise<void>((resolve) => {
        resolveHydration = resolve;
    });
    const listeners = new Set<(next: ModelConfigPersistenceState) => void>();

    const publish = (patch: Partial<ModelConfigPersistenceState>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener(state));
    };

    const hydrate = async () => {
        const discardBlockedDraft = revisionConflict || canonicalReadFailed;
        publish({ status: "hydrating", error: "" });
        try {
            const result = await dependencies.read();
            if (discardBlockedDraft) {
                latestConfig = null;
                generation += 1;
            }
            revisionConflict = false;
            canonicalReadFailed = false;
            state = { status: "idle", revision: result.revision, dirty: Boolean(latestConfig), error: "" };
            return result;
        } catch (error) {
            canonicalReadFailed = true;
            publish({ status: "error", error: error instanceof Error ? error.message : "读取模型配置失败" });
            throw error;
        } finally {
            hydrated = true;
            resolveHydration?.();
            resolveHydration = null;
            if (latestConfig) void scheduleDrain();
        }
    };

    const runDrain = async () => {
        while (hydrated && latestConfig && state.dirty && !revisionConflict && !canonicalReadFailed) {
            const config = latestConfig;
            const savingGeneration = generation;
            publish({ status: "saving", error: "" });
            try {
                const result = await dependencies.write(config, state.revision);
                state = { status: "saved", revision: result.revision, dirty: generation !== savingGeneration, error: "" };
            } catch (error) {
                if (isRevisionConflict(error)) {
                    // A fresh revision does not make this tab's old full snapshot
                    // authoritative. Freeze writes until explicit canonical hydration.
                    revisionConflict = true;
                    let conflictRevision: number | undefined;
                    try {
                        const current = await dependencies.read();
                        conflictRevision = current.revision;
                    } catch { /* Conflict still blocks writes when the read is unavailable. */ }
                    publish({ status: "error", dirty: true, conflictRevision, error: "其他页面已修改模型配置。本页编辑仍保留，已停止自动覆盖；请刷新读取最新配置后重新应用修改。" });
                    return;
                }
                publish({ status: "error", dirty: true, error: error instanceof Error ? error.message : "保存模型配置失败" });
                return;
            }
        }
        listeners.forEach((listener) => listener(state));
    };

    const scheduleDrain = (): Promise<void> => {
        if (revisionConflict || canonicalReadFailed) return Promise.resolve();
        if (!hydrated) return hydrationBarrier.then(scheduleDrain);
        if (!drainPromise) {
            drainPromise = runDrain().finally(() => {
                drainPromise = null;
            });
        }
        return drainPromise;
    };

    const commit = (config: AiConfig) => {
        latestConfig = { ...config };
        delete latestConfig.localComfyModels;
        delete latestConfig.localComfyGenerationEnabled;
        generation += 1;
        publish({ dirty: true });
        return scheduleDrain();
    };

    return {
        hydrate,
        commit,
        flush: scheduleDrain,
        getState: () => state,
        subscribe: (listener: (next: ModelConfigPersistenceState) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

function isRevisionConflict(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: number; response?: { status?: number } };
    return candidate.status === 409 || candidate.response?.status === 409;
}

function omitManagedBeefAPISecrets(config: AiConfig): AiConfig {
    return {
        ...config,
        channels: config.channels.map((channel) => {
            if (channel.id !== "beefapi" || !channel.pinned) return channel;
            return { ...channel, apiKey: "", secretKey: "" };
        }),
    };
}

const repository = createModelConfigRepository({
    read: getLocalModelConfig,
    write: (config, expectedRevision) => saveLocalModelConfig(omitManagedBeefAPISecrets(config), expectedRevision),
});

export const hydrateModelConfig = repository.hydrate;
export const commitModelConfig = repository.commit;
export const flushModelConfig = repository.flush;
export const getModelConfigPersistenceState = repository.getState;
export const subscribeModelConfigPersistence = repository.subscribe;

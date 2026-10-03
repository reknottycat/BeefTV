import { isLocalRuntimeMode, isNativeDesktopRuntime } from "@/lib/runtime-mode";

/**
 * Resource storage policy for the two local runtimes:
 * - native desktop: Go resource service is the durable local store;
 * - browser local: IndexedDB is the durable local store.
 * Hosted mode always attempts the remote resource API first.
 * A local browser deployment may explicitly select its co-packaged backend
 * with VITE_CANVAS_LOCAL_RESOURCE_STORE=backend (for example on Spark).
 */
export function requiresBackendLocalResourceStore() {
    return isLocalRuntimeMode() && import.meta.env.VITE_CANVAS_LOCAL_RESOURCE_STORE === "backend";
}

export function usesBrowserLocalResourceStore() {
    return isLocalRuntimeMode() && !isNativeDesktopRuntime() && !requiresBackendLocalResourceStore();
}

/** Historical name also includes an explicitly selected local backend deployment. */
export function usesNativeLocalResourceStore() {
    return isLocalRuntimeMode() && (isNativeDesktopRuntime() || requiresBackendLocalResourceStore());
}

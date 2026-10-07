import { describe, expect, test } from "bun:test";
import { assembleProductionTimeline, productionAttemptAction, productionProposal, productionReviewSnapshot, productionSelection, productionTaskStatus, productionTimelineCurrent, type ProductionState } from "@/lib/creation/production";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

function state(): ProductionState {
    return { kind: "canvas-production", version: 1, proposalVersion: 1, exports: [], shots: [{ nodeId: "shot", title: "门外", mode: "video", prompt: "人物开门", model: "video-model", options: {}, referenceNodeIds: [], selectedAttemptId: "v1", attempts: [
        { id: "v1", status: "ready", media: { id: "v1", kind: "video", title: "旧版", storageKey: "resource:old", durationMs: 2000 } },
        { id: "v2", status: "ready", media: { id: "v2", kind: "video", title: "新版", storageKey: "resource:new", durationMs: 3000 } },
    ] }] };
}

describe("production version and recovery contract", () => {
    test("assembling uses the selected resource, even when a newer result exists", () => {
        const current = state();
        expect(assembleProductionTimeline(current).clips[0].directMedia?.storageKey).toBe("resource:old");
        current.shots[0].selectedAttemptId = "v2";
        expect(assembleProductionTimeline(current).clips[0].directMedia?.storageKey).toBe("resource:new");
    });
    test("changing volume cannot mark a stale shot selection as assembled or reviewed", () => {
        const current = state();
        current.timeline = assembleProductionTimeline(current);
        current.assembledSelection = productionSelection(current);
        current.reviewedSnapshot = productionReviewSnapshot(current);
        expect(productionTimelineCurrent(current)).toBe(true);
        current.shots[0].selectedAttemptId = "v2";
        current.timeline.clips[0].volume = 0;
        expect(productionTimelineCurrent(current)).toBe(false);
        expect(productionReviewSnapshot(current)).not.toBe(current.reviewedSnapshot);
        expect(current.timeline.clips[0].directMedia?.storageKey).toBe("resource:old");
    });
    test("unknown submission, uncertain cancellation, and materialization each keep a recovery action", () => {
        const base = { status: "failed" } as GenerationTask;
        expect(productionTaskStatus({ ...base, errorCode: "GENERATION_SUBMISSION_UNKNOWN" })).toBe("unknown");
        expect(productionTaskStatus({ ...base, status: "cancelled", providerCancelStatus: "uncertain" })).toBe("unknown");
        expect(productionTaskStatus({ ...base, resultState: "FAILED_RETRYABLE" })).toBe("retrieve");
        expect(productionAttemptAction({ id: "a", status: "unknown" }).action).toBe("observe");
        expect(productionAttemptAction({ id: "a", status: "write_failed" }).action).toBe("save");
        expect(productionAttemptAction({ id: "a", status: "failed" }).action).toBe("retry");
    });
    test("film reference images are not silently inserted as final movie shots", () => {
        const project = { nodes: [
            { id: "reference", type: "image", metadata: { prompt: "人物参考", model: "image" } },
            { id: "second", type: "video", metadata: { prompt: "镜头二", model: "video", shotIndex: 1 } },
            { id: "first", type: "video", metadata: { prompt: "镜头一", model: "video", shotIndex: 0 } },
        ], connections: [{ fromNodeId: "reference", toNodeId: "first" }] } as CanvasProject;
        const proposal = productionProposal(project);
        expect(proposal.state.shots.map((shot) => shot.nodeId)).toEqual(["first", "second"]);
        expect(proposal.state.shots[0].referenceNodeIds).toEqual(["reference"]);
    });
});

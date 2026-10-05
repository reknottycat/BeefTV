import { describe, expect, test } from "bun:test";
import { createDirectorSaveCoordinator } from "../src/lib/canvas/director/director-save";
import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { createDirectorDirection } from "../src/lib/canvas/director/director-motion";
import type { DirectorScene } from "../src/types/director";
import { useCanvasStore, withCanvasStorePersistenceSuppressed } from "../src/stores/canvas/use-canvas-store";

describe("motion decisions through the existing save coordinator", () => {
    test("the actual canvas copy preserves direction and isolates nested edits", () => {
        const previousProjects = useCanvasStore.getState().projects;
        try {
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                const rootId = useCanvasStore.getState().createProject("motion copy");
                const scene = createDirectorReproScene();
                scene.shots[0].direction = createDirectorDirection("impact-reveal", { intent: "结果触发", sourceAnchor: "例句" });
                useCanvasStore.getState().updateProject(rootId, { directorScenes: [scene] });
                const root = useCanvasStore.getState().openProject(rootId)!;
                const copyId = useCanvasStore.getState().importProject(root, rootId);
                const copy = useCanvasStore.getState().openProject(copyId)!;
                expect(copy.directorScenes).toEqual(root.directorScenes);
                expect(copy.directorScenes[0].shots[0].direction).not.toBe(root.directorScenes[0].shots[0].direction);
                copy.directorScenes[0].shots[0].direction!.content.labels[0] = "copy edit";
                expect(root.directorScenes[0].shots[0].direction!.content.labels[0]).toBe("输入");
            });
        } finally { withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previousProjects })); }
    });
    test("failed save, reopen, recovery and retry retain the full director decision", async () => {
        const records = new Map<string, string>();
        const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
        const initial = createDirectorReproScene();
        const edited = structuredClone(initial);
        edited.shots[0].direction = createDirectorDirection("diagram-morph", {
            intent: "保持实体关系", sourceAnchor: "教师向学生交付知识", frameRate: 24,
            content: { title: "交接", labels: ["教师", "学生"], relations: [{ from: 0, to: 1 }] },
            action: { initial: "教师持物", verb: "交接", final: "学生持物", observableChange: "道具持有者改变" },
            subjectBindings: [{ objectId: initial.objects[0].id, role: "primary", sha256: "a".repeat(64) }],
            references: [{ caseId: "reviewed-ref", url: "https://example.com/ref", review: "frames", startSeconds: 0, endSeconds: 3 }],
        });
        const first = createDirectorSaveCoordinator({ initialScene: initial, scope: "motion-test", storage, schedule: () => 0, cancelSchedule: () => undefined, flush: async () => { throw new Error("expected offline"); } });
        first.edit(edited);
        expect(await first.flushLatest()).toBe(false);
        expect(first.getSnapshot().draftStored).toBe(true);
        first.dispose();
        let persisted: DirectorScene | undefined;
        const second = createDirectorSaveCoordinator({ initialScene: initial, scope: "motion-test", storage, schedule: () => 0, cancelSchedule: () => undefined, flush: async (request) => { persisted = request.scene; } });
        const recovery = second.restoreCandidate();
        expect(recovery?.scene.shots[0].direction).toEqual(edited.shots[0].direction);
        expect(second.explicitRestore(recovery)).toBe(true);
        expect(await second.retry()).toBe(true);
        expect(persisted!.shots[0].direction).toEqual(edited.shots[0].direction);
        // Persisted scene and UI edits cannot share nested mutable director values.
        edited.shots[0].direction!.content.labels[0] = "external edit";
        expect(persisted!.shots[0].direction!.content.labels[0]).toBe("教师");
        second.dispose();
    });
});

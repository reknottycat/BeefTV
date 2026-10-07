/** Authored shot instructions for prompt/reference handoff; not a rendering engine. */
export type DirectorDirection = {
    schemaVersion: 1;
    sourceAnchor: string;
    focus: string;
    emotion: string;
    action: { initial: string; verb: string; final: string; observableChange: string };
    motion: { amplitude: number; staggerMs: number; settleMs: number };
    continuity: { statesIn: string; statesOut: string; reason: string };
};

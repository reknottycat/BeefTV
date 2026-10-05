export const MOTION_PATTERN_IDS = ["object-relay", "camera-push", "kinetic-type", "diagram-morph", "impact-reveal", "continuous-shape-transition"] as const;
export type MotionPatternId = typeof MOTION_PATTERN_IDS[number];

export type DirectorReference = {
    caseId: string;
    url: string;
    review: "metadata" | "frames" | "motion" | "reproduced";
    startSeconds?: number;
    endSeconds?: number;
};

export type DirectorAudioCue = { id: string; kind: "whoosh" | "impact" | "settle"; frame: number; gain: number; anchor?: "primary-impact" };
export type DirectorMotionAnchor = { x: number; y: number; width: number; height: number; rotation: number };

/** Shot intent is persisted with the existing scene; previews and exports derive from it. */
export type DirectorDirection = {
    schemaVersion: 1;
    patternId: MotionPatternId;
    patternVersion: "1.0.0";
    frameRate: 24 | 25 | 30;
    intent: string;
    sourceAnchor: string;
    emotion: string;
    focus: string;
    action: { initial: string; verb: string; final: string; observableChange: string };
    content: { title: string; labels: string[]; relations?: { from: number; to: number }[] };
    motion: { amplitude: number; staggerFrames: number; settleFrames: number };
    camera: { push: number; delayFrames: number };
    light: { keyColor: string; background: string };
    audioCues: DirectorAudioCue[];
    continuity: { statesIn: Record<string, string>; statesOut: Record<string, string>; reason: string };
    transition: { sharedElementId: string; sharedAnchor: DirectorMotionAnchor; exitAnchor: DirectorMotionAnchor };
    references: DirectorReference[];
    timingStatus: "estimated" | "voice_locked";
    readableHoldFrames: number;
    seed: number;
    subjectBindings: { objectId: string; assetId?: string; sha256?: string; role: "primary" | "secondary" }[];
};

export type MotionNode = {
    id: string;
    kind: "box" | "circle" | "text";
    x: number;
    y: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
    rotation: number;
    label: string;
    color: string;
};
export type MotionFrame = {
    localFrame: number;
    stage: "anticipation" | "action" | "impact" | "settle" | "hold";
    actionProgress: number;
    settleProgress: number;
    nodes: MotionNode[];
    edges: { from: string; to: string; opacity: number }[];
    camera: { scale: number; x: number; y: number };
    activeCueIds: string[];
};

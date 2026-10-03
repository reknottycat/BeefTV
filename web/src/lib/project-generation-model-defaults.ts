export type ProjectGenerationModelDefaults = {
    defaultImageModel?: string;
    defaultVideoModel?: string;
};

// Saved project selections remain authoritative when their directory is unavailable.
export function withProjectGenerationModelDefaults<T extends { imageModel: string; videoModel: string }>(config: T, project?: ProjectGenerationModelDefaults): T {
    const imageModel = project?.defaultImageModel?.trim() || config.imageModel;
    const videoModel = project?.defaultVideoModel?.trim() || config.videoModel;
    return imageModel === config.imageModel && videoModel === config.videoModel ? config : { ...config, imageModel, videoModel };
}

export function projectGenerationModel(config: { imageModel: string; videoModel: string }, project: ProjectGenerationModelDefaults | undefined, mode: "image" | "video", nodeModel?: string): string {
    const inherited = withProjectGenerationModelDefaults(config, project);
    return nodeModel?.trim() || (mode === "image" ? inherited.imageModel : inherited.videoModel);
}

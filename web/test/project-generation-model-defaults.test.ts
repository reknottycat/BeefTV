import { describe, expect, test } from "bun:test";
import { projectGenerationModel, withProjectGenerationModelDefaults } from "../src/lib/project-generation-model-defaults";

const global = { imageModel: "cloud:image", videoModel: "cloud:video", textModel: "cloud:text", size: "16:9", videoSeconds: "6" };

describe("native project generation model inheritance", () => {
    test("explicit node, project, then global selections determine the actual request model", () => {
        const project = { defaultImageModel: "local-comfy:qwen_image_2_1", defaultVideoModel: "local-comfy:h3_i2v_turbo4" };
        expect(projectGenerationModel(global, project, "image", "cloud:node")).toBe("cloud:node");
        expect(projectGenerationModel(global, project, "image")).toBe(project.defaultImageModel);
        expect(projectGenerationModel(global, project, "video")).toBe(project.defaultVideoModel);
        expect(projectGenerationModel(global, undefined, "video")).toBe(global.videoModel);
    });
    test("an unavailable saved recipe remains selected instead of falling back to cloud", () => {
        expect(projectGenerationModel(global, { defaultImageModel: "local-comfy:missing" }, "image")).toBe("local-comfy:missing");
        expect(projectGenerationModel(global, undefined, "video", "local-comfy:missing")).toBe("local-comfy:missing");
    });
    test("empty defaults follow global and applying local defaults preserves cloud parameters", () => {
        expect(withProjectGenerationModelDefaults(global, { defaultImageModel: " " })).toBe(global);
        const result = withProjectGenerationModelDefaults(global, { defaultVideoModel: " local-comfy:h3_i2v_turbo4 " });
        expect(result.videoModel).toBe("local-comfy:h3_i2v_turbo4");
        expect(result.imageModel).toBe(global.imageModel);
        expect(result.size).toBe("16:9");
        expect(result.videoSeconds).toBe("6");
        expect(result.textModel).toBe(global.textModel);
        expect(global.videoModel).toBe("cloud:video");
    });
});

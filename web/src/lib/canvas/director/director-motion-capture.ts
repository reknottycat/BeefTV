import type { DirectorDirection } from "../../../types/director-motion";
import { renderDirectorMotionSvg } from "./director-motion";

/** Rasterize the exact frame shown in motion preview before returning it to the canvas. */
export async function captureDirectorMotionFrame(direction: DirectorDirection, frame: number, durationFrames: number, fps: number): Promise<Blob> {
    const svg = renderDirectorMotionSvg(direction, frame, durationFrames, fps);
    const bitmap = new Image();
    bitmap.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await bitmap.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("motion.capture: 无法创建画布");
    context.drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("motion.capture: 帧图片编码失败")), "image/png"));
}

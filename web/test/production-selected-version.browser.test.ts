import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { timelineClipSource } from "../src/lib/timeline/timeline-source";
import { lowerCanonicalPlan } from "../src/lib/timeline/timeline-to-ffmpeg";
import { executeTimelineRenderPlan, type TimelineRenderEngine } from "../src/lib/timeline/timeline-render-service";
import type { CanonicalTimelinePlan } from "../src/lib/timeline/timeline-canonical-plan";
import type { TimelineRenderCreateRequest } from "../src/services/api/timeline-tasks";
import type { CanvasNodeData } from "../src/types/canvas";

// Opt-in UI/source/encoder regression, NOT a real backend or wasm-worker E2E.
// The real ProductionPage/Coordinator submit their frozen export snapshot.
// Creation/task/resource persistence and the single-clip semantic plan are fixtures.
// Only timelineClipSource decides which real file to encode from that submitted
// snapshot and the newer canvas; the shared lowerer/executor use native FFmpeg.
const enabled = process.env.BEEFTV_PRODUCTION_MEDIA_TEST === "1";
const mediaFormat = process.env.BEEFTV_PRODUCTION_MEDIA_FORMAT === "mp4" ? "mp4" : "webm";
let browser: Browser, server: ReturnType<typeof Bun.serve>, dir: string;
let submitted: { input: TimelineRenderCreateRequest; canvas: { nodes: CanvasNodeData[] } } | undefined;
let renderCalls = 0;
let renderError = "";
let resolvedStorageKey = "";

function ffmpeg(args: string[]) {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr.toString());
    return result.stdout;
}

async function renderSubmittedSnapshot(payload: NonNullable<typeof submitted>) {
    const { timeline } = payload.input;
    const clip = timeline.clips[0];
    // This fixture only promises one unedited, silent, two-second video.
    // Refuse drift rather than fabricate a plan that silently drops content.
    if (timeline.durationMs !== 2000 || timeline.clips.length !== 1 || clip.kind !== "video" || clip.nodeId !== "shot-0" || clip.startMs !== 0 || clip.durationMs !== 2000 || (clip.sourceStartMs || 0) !== 0 || (clip.volume ?? 1) !== 1 || clip.fadeInMs || clip.fadeOutMs || timeline.tracks.some((track) => track.muted || track.visible === false)) {
        throw new Error("single-clip planner fixture no longer matches the submitted snapshot");
    }
    const source = timelineClipSource(clip, payload.canvas.nodes.find((node) => node.id === clip.nodeId));
    const sourceFiles: Record<string, string> = { "resource:old": `old.${mediaFormat}`, "resource:new": `new.${mediaFormat}` };
    const file = sourceFiles[source.storageKey];
    if (!file) throw new Error(`unexpected selected source: ${source.storageKey}`);
    resolvedStorageKey = source.storageKey;
    copyFileSync(join(dir, file), join(dir, `input.${mediaFormat}`));
    const canonical: CanonicalTimelinePlan = {
        version: 1, durationMs: 2000,
        output: { width: 320, height: 180, fps: 30, sampleRate: 44100, burnSubtitles: true },
        segments: [{ kind: "video", clipId: clip.id, sourceId: "shot-0", startMs: 0, durationMs: 2000, sourceStartMs: 0, volume: 1, hasAudio: false }],
        audio: [], subtitles: [],
    };
    const engine: TimelineRenderEngine = {
        async writeFile(name, data) { writeFileSync(join(dir, name), data); },
        async readFile(name) { return readFileSync(join(dir, name)); },
        async deleteFile(name) { rmSync(join(dir, name), { force: true }); },
        async exec(args) {
            const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
            return { exitCode: result.status ?? 1, log: result.error?.message || result.stderr.toString() };
        },
    };
    const plan = lowerCanonicalPlan(canonical, [{ nodeId: "shot-0", fileName: `input.${mediaFormat}`, durationMs: 2000, hasAudio: false }], { outputName: "film.mp4" });
    const result = await executeTimelineRenderPlan({ plan, engine });
    return { id: "render", type: "timeline_render", status: "succeeded", attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ resourceId: "film", fileName: "selected-version.mp4", size: result.output.length, durationMs: 2000 }) };
}

beforeAll(async () => {
    if (!enabled) return;
    dir = mkdtempSync(join(tmpdir(), "beeftv-production-version-"));
    // Default VP8 supports Chromium headless_shell. Set BEEFTV_PRODUCTION_MEDIA_FORMAT=mp4 with
    // an H.264-capable CHROME_PATH to verify the same browser pixel assertions.
    for (const [name, color] of [["old", "red"], ["new", "blue"]]) ffmpeg(["-f", "lavfi", "-i", `color=${color}:s=320x180:r=30:d=2`, "-c:v", mediaFormat === "mp4" ? "libx264" : "libvpx", "-pix_fmt", "yuv420p", `${name}.${mediaFormat}`]);
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/production-ui-harness.tsx")], target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "production-business-api-fixture", setup(builder) {
            builder.onResolve({ filter: /^@\/(?:services\/api\/(?:creation-runs|generation-task|task-center|timeline-tasks|resources)|services\/(?:local-workspace-sync|file-storage|resource-blob-cache)|stores\/use-config-store|stores\/canvas\/use-canvas-theme-store|lib\/user-scope-guard|components\/canvas\/asset-picker-modal)$/ }, () => ({ path: resolve(import.meta.dir, "fixtures/production-ui-runtime.ts") }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (/^\/media\/(?:(old|new)\.(webm|mp4)|film\.mp4)$/.test(path)) return new Response(Bun.file(join(dir, path.slice("/media/".length))));
        if (path === "/fixture/render" && request.method === "POST") {
            renderCalls++;
            try { submitted = await request.json() as NonNullable<typeof submitted>; return Response.json(await renderSubmittedSnapshot(submitted)); }
            catch (error) { renderError = String(error); return new Response(renderError, { status: 500 }); }
        }
        if (path !== "/") return new Response("fixture route not found", { status: 404 });
        return new Response('<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); if (dir) rmSync(dir, { recursive: true, force: true }); });

function pixel(file: string, time = 0.5) {
    return [...ffmpeg(["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "crop=2:2:0:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).subarray(0, 3)];
}
function expectColor(rgb: number[], channel: 0 | 2) {
    expect(rgb).toHaveLength(3);
    expect(rgb[channel]).toBeGreaterThan(180);
    expect(rgb[channel]).toBeGreaterThan(rgb[1] + 100);
    expect(rgb[channel]).toBeGreaterThan(rgb[channel === 0 ? 2 : 0] + 100);
}
async function previewPixel(page: Page, version: "old" | "new") {
    try { await page.waitForFunction(({ id, format }) => { const video = document.querySelector("video"); return Boolean(video && video.readyState >= 2 && video.currentSrc.endsWith(`/media/${id}.${format}`)); }, { id: version, format: mediaFormat }); }
    catch (error) {
        const state = await page.evaluate(() => ({ videos: Array.from(document.querySelectorAll("video"), (video) => ({ src: video.currentSrc, readyState: video.readyState, error: video.error?.message })), body: document.body.innerText }));
        throw new Error(`preview ${version} failed: ${error}; ${JSON.stringify(state)}`);
    }
    return page.locator("video").first().evaluate((video: HTMLVideoElement) => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!; context.drawImage(video, 0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
}

test.skipIf(!enabled)("explicitly selected old red version stays red in encoded export after canvas changes to blue", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, acceptDownloads: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    try {
        const originalPixels = { old: pixel(`old.${mediaFormat}`), new: pixel(`new.${mediaFormat}`) };
        expectColor(originalPixels.old, 0); expectColor(originalPixels.new, 2);
        await page.goto(`${server.url}?mode=media&mediaFormat=${mediaFormat}`);
        // The baseline really displays B, so an oracle that always returns A cannot pass.
        const baselinePixel = await previewPixel(page, "new"); expectColor(baselinePixel, 2);
        await page.getByRole("combobox", { name: "第一镜的采用版本" }).click();
        await page.getByText("版本 1", { exact: true }).click();
        await page.getByText("镜头采用版本已变化", { exact: true }).waitFor();
        await page.getByRole("checkbox", { name: "重新组装将替换本次时间线的剪辑和声音设置，历史成片保留" }).check();
        await page.getByRole("button", { name: "按采用版本重新组装", exact: true }).click();
        await page.getByText("镜头采用版本已变化", { exact: true }).waitFor({ state: "hidden" });
        const selectedPixel = await previewPixel(page, "old"); expectColor(selectedPixel, 0);
        await page.getByRole("button", { name: "已检查预览，确认当前版本", exact: true }).click();
        await page.getByRole("button", { name: "已确认当前预览", exact: true }).waitFor();
        await page.evaluate(() => (window as any).productionFixture.replaceCanvasVersion());
        await page.reload();
        await page.getByRole("button", { name: "已确认当前预览", exact: true }).waitFor();
        expect(await page.evaluate(() => (window as any).productionFixture.canvas().nodes[0].metadata.storageKey)).toBe("resource:new");
        expect(await page.evaluate(() => (window as any).productionFixture.current().run.state.shots[0].selectedAttemptId)).toBe("old");
        const reloadedPixel = await previewPixel(page, "old"); expectColor(reloadedPixel, 0);
        await page.getByRole("button", { name: "导出已确认成片", exact: true }).click();
        await page.waitForFunction(() => Boolean((window as any).productionFixture.current().run.state.render?.result) || Boolean(document.querySelector('[role="alert"]')), undefined, { timeout: 30_000 });
        expect(renderError).toBe(""); expect(renderCalls).toBe(1);
        expect(submitted!.input.projectId).toBe("canvas");
        expect(submitted!.input.clientOperationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(submitted!.input.options).toEqual({ burnSubtitles: true });
        expect(submitted!.input.timeline.clips[0].directMedia?.storageKey).toBe("resource:old");
        expect(submitted!.canvas.nodes[0].metadata?.storageKey).toBe("resource:new");
        expect(resolvedStorageKey).toBe("resource:old");
        const frozen = await page.evaluate(() => (window as any).productionFixture.current().run.state.render);
        expect(frozen.timeline).toEqual(submitted!.input.timeline);
        expect(frozen.clientOperationId).toBe(submitted!.input.clientOperationId);
        const download = page.waitForEvent("download");
        await page.getByRole("link", { name: "下载成片", exact: true }).click();
        const file = join(dir, "download.mp4"); await (await download).saveAs(file);
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]);
        expect(probe.status).toBe(0);
        const info = JSON.parse(probe.stdout.toString());
        expect(Math.abs(Number(info.format.duration) - 2)).toBeLessThan(0.15);
        expect(info.streams.find((stream: { codec_type: string }) => stream.codec_type === "video")).toMatchObject({ width: 320, height: 180 });
        const outputPixels = [0.2, 1, 1.8].map((time) => ({ time, rgb: pixel(file, time) }));
        for (const sample of outputPixels) expectColor(sample.rgb, 0);
        expect(errors).toEqual([]);
        if (process.env.PRODUCTION_MEDIA_EVIDENCE_DIR) {
            const evidenceDir = process.env.PRODUCTION_MEDIA_EVIDENCE_DIR;
            mkdirSync(evidenceDir, { recursive: true });
            copyFileSync(file, join(evidenceDir, "production-selected-old-version.mp4"));
            writeFileSync(join(evidenceDir, "production-selected-version.json"), JSON.stringify({
                boundary: `Real ProductionPage/Coordinator and native FFmpeg lowerer/executor; business APIs and single-clip semantic plan are fixtures. ${mediaFormat === "mp4" ? "H.264/MP4" : "VP8/WebM"} browser input previews.`,
                originalPixels, previewPixels: { baseline: baselinePixel, selected: selectedPixel, afterCanvasChangeAndReload: reloadedPixel },
                submitted, resolvedStorageKey, outputProbe: info, outputPixels, browserErrors: errors,
            }, null, 2));
        }
    } finally { await page.close(); }
}, 60_000);

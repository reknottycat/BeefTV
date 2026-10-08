import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/timeline-preview-harness.tsx"], target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "preview-media-boundary", setup(build) {
            build.onResolve({ filter: /^@\/services\/(file-storage|resource-blob-cache|api\/resources)$/ }, () => ({ path: import.meta.dir + "/fixtures/timeline-preview-runtime.ts" }));
            build.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch(request) {
        return new URL(request.url).pathname === "/harness.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
            : new Response('<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : undefined;
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

async function openPage() {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "播放预览", exact: true }).waitFor();
    return page;
}
const state = (page: Page) => page.evaluate(() => (window as any).previewFixture);

test("真实音频与图片预览跨越画面间隙，在末尾停止并保留选用版本", async () => {
    const page = await openPage();
    try {
        await page.getByRole("button", { name: "播放预览", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[aria-label="播放头"]')?.textContent === "900");
        expect(await page.getByLabel("播放状态").textContent()).toBe("已暂停");
        expect((await state(page)).receipt.sources.every((source: { storageKey: string; url: string }) => source.storageKey !== "resource:unselected" && !source.url.includes("unselected"))).toBe(true);
        expect(await page.getByRole("alert").count()).toBe(0);
    } finally { await page.close(); }
}, 15_000);

test("声音控件保持零音量与轨静音，导演输入进入交付提示词", async () => {
    const page = await openPage();
    try {
        await page.getByRole("spinbutton", { name: "旁白音量百分比" }).fill("0");
        await page.getByRole("spinbutton", { name: "旁白音量百分比" }).press("Tab");
        expect((await state(page)).timeline.clips.find((clip: { id: string }) => clip.id === "voice").volume).toBe(0);
        await page.getByRole("button", { name: "静音配音", exact: true }).click();
        expect(await page.getByRole("button", { name: "取消静音配音", exact: true }).getAttribute("aria-pressed")).toBe("true");
        await page.getByRole("button", { name: "补充动作与连续性" }).click();
        await page.getByRole("textbox", { name: "主体动作", exact: true }).fill("甲把信交给乙");
        expect((await state(page)).prompt).toContain("甲把信交给乙");
        await page.getByRole("button", { name: "定位图片" }).click();
        await page.getByRole("img", { name: "选用镜头" }).waitFor();
        if (process.env.BEEFTV_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.BEEFTV_PREVIEW_SCREENSHOT, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.getByRole("button", { name: "播放预览", exact: true }).isVisible()).toBe(true);
    } finally { await page.close(); }
}, 15_000);

test("素材离线显示错误且停播，恢复后可原位重试", async () => {
    const page = await openPage();
    try {
        await page.getByRole("button", { name: "定位图片" }).click();
        await page.getByRole("button", { name: "模拟素材离线" }).click();
        await page.getByRole("button", { name: "重试预览" }).waitFor();
        expect(await page.getByLabel("播放状态").textContent()).toBe("已暂停");
        await page.getByRole("button", { name: "恢复素材服务" }).click();
        await page.getByRole("button", { name: "重试预览" }).click();
        await page.waitForFunction(() => document.querySelector("img")?.complete && !document.querySelector('[role="alert"]'));
        await page.getByRole("button", { name: "播放预览", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector('[aria-label="播放头"]')?.textContent === "900");
    } finally { await page.close(); }
}, 15_000);

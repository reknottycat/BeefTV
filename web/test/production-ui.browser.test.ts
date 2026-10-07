import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "fixtures/production-ui-harness.tsx")], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "production-business-api-fixture", setup(build) {
        build.onResolve({ filter: /^@\/(?:services\/api\/(?:creation-runs|generation-task|task-center|timeline-tasks|resources)|services\/(?:local-workspace-sync|file-storage|resource-blob-cache)|stores\/use-config-store|stores\/canvas\/use-canvas-theme-store|lib\/user-scope-guard|components\/canvas\/asset-picker-modal)$/ }, () => ({ path: resolve(import.meta.dir, "fixtures/production-ui-runtime.ts") }));
        build.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const css = await compile(readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8"), { base: resolve(import.meta.dir, "../src/styles"), onDependency() {} });
    const scanner = new Scanner({ sources: [{ base: resolve(import.meta.dir, "../src"), pattern: "**/*.{ts,tsx}", negated: false }] });
    const fontDir = process.env.PRODUCTION_TEST_FONT_DIR;
    const fontCSS = fontDir ? readFileSync(resolve(fontDir, "400.css"), "utf8").replaceAll("./files/", "/fonts/") + '\n* { font-family:"Noto Sans SC",sans-serif!important; }' : "";
    const styles = css.build(scanner.scan()) + fontCSS + "\n#root,.ant-app { height:100vh; }";
    server = Bun.serve({ port: 0, fetch(request) { const path = new URL(request.url).pathname; if (fontDir && path.startsWith("/fonts/")) return new Response(Bun.file(resolve(fontDir, "files", basename(path)))); return path === "/harness.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } }) : path === "/style.css" ? new Response(styles, { headers: { "Content-Type": "text/css" } }) : new Response('<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }); } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("real production page requires confirmation, exposes pause while running, and stops later shots", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    try {
        await page.goto(server.url.toString());
        const start = page.getByRole("button", { name: "确认方案并开始生成", exact: true });
        await start.waitFor(); expect(await start.isDisabled()).toBe(true);
        await page.getByRole("checkbox").check(); await start.click();
        await page.waitForFunction(() => (window as any).productionFixture.waiting);
        const pause = page.getByRole("button", { name: "暂停后续镜头", exact: true });
        expect(await pause.isEnabled()).toBe(true); await pause.click();
        await page.getByText("已暂停。", { exact: false }).waitFor();
        expect(await page.evaluate(() => (window as any).productionFixture.executed)).toBe(1);
        if (process.env.PRODUCTION_TEST_SCREENSHOTS) { mkdirSync(process.env.PRODUCTION_TEST_SCREENSHOTS, { recursive: true }); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${process.env.PRODUCTION_TEST_SCREENSHOTS}/production-paused-light.png`, fullPage: true }); }
    } finally { await page.close(); }
}, 20_000);

test("confirmed page refuses a proposal changed in another window", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString()); await page.getByRole("checkbox").check();
        await page.evaluate(() => (window as any).productionFixture.mutateProposal());
        await page.getByRole("button", { name: "确认方案并开始生成", exact: true }).click();
        await page.getByText("方案已在其他窗口更新，请重新核对当前方案后确认生成", { exact: true }).first().waitFor();
        expect(await page.evaluate(() => (window as any).productionFixture.executed)).toBe(0);
        expect(await page.getByRole("checkbox").isChecked()).toBe(false);
    } finally { await page.close(); }
}, 20_000);

test("unsaved timeline survives a version change and blocks leaving or exporting stale media", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    try {
        await page.goto(`${server.url}?mode=ready&theme=dark`);
        const startTime = page.getByRole("spinbutton").first(); await startTime.fill("1"); await startTime.blur();
        await page.getByText("编辑尚未保存", { exact: true }).waitFor();
        await page.getByRole("combobox", { name: "第一镜的采用版本" }).click();
        await page.getByText("版本 2", { exact: true }).click();
        await page.getByText("镜头采用版本已变化", { exact: true }).waitFor();
        expect(await startTime.inputValue()).toBe("1");
        expect(await page.getByRole("button", { name: "导出已确认成片", exact: true }).isDisabled()).toBe(true);
        await page.getByRole("link", { name: "返回作品" }).click();
        await page.getByRole("button", { name: "继续编辑", exact: true }).waitFor();
        await page.getByRole("button", { name: "继续编辑", exact: true }).click();
        await page.getByRole("button", { name: "继续编辑", exact: true }).waitFor({ state: "hidden" });
        expect(await startTime.inputValue()).toBe("1");
        if (process.env.PRODUCTION_TEST_SCREENSHOTS) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${process.env.PRODUCTION_TEST_SCREENSHOTS}/production-draft-dark.png`, fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${process.env.PRODUCTION_TEST_SCREENSHOTS}/production-draft-mobile.png`, fullPage: true }); await page.locator("main").evaluate((element) => { element.scrollTop = element.scrollHeight; }); await page.screenshot({ path: `${process.env.PRODUCTION_TEST_SCREENSHOTS}/production-timeline-mobile.png`, fullPage: true }); }
    } finally { await page.close(); }
}, 20_000);

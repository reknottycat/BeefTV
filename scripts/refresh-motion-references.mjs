import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = "guanmo-ai/awesome-ai-motion";
const dataDirectory = new URL("../web/src/lib/canvas/director/motion-data/", import.meta.url);
const snapshotFile = new URL("motion-references.json", dataDirectory);
const annotationsFile = new URL("motion-reference-annotations.json", dataDirectory);
const initialCommit = "203472a514a4d41c12b1cee8e82423b5ca311186";

export function normalizeMotionReferences(input, { commit, fetchedAt, sourceSha256 }) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full upstream commit SHA.");
    if (input?.schemaVersion !== 2 || !Array.isArray(input.cases) || input.cases.length === 0) {
        throw new Error("Unsupported Awesome AI Motion schema; expected schemaVersion 2 and cases[].");
    }
    const ids = new Set();
    const cases = input.cases.map((item) => {
        if (!item.id || ids.has(item.id) || !item.title || !item.source?.url || !item.author?.handle) {
            throw new Error(`Missing or duplicate case identity: ${item.id ?? "unknown"}`);
        }
        if (!["original", "brief", "unknown"].includes(item.prompt?.status)) {
            throw new Error(`Unsupported prompt status for ${item.id}.`);
        }
        ids.add(item.id);
        const resources = (item.resources ?? []).map(({ kind, url, label, evidenceUrl, checkedAt, license, licenseUrl }) => ({
            kind, url, label, evidenceUrl, checkedAt, license, licenseUrl,
        }));
        if (item.codeUrl && !resources.some((resource) => resource.url === item.codeUrl)) {
            resources.push({ kind: "code", url: item.codeUrl, label: "上游源码入口" });
        }
        return {
            id: item.id,
            title: item.title,
            titleEn: item.titleEn ?? null,
            category: item.category,
            author: item.author,
            source: item.source,
            durationSeconds: item.media?.durationSeconds ?? null,
            videoCount: item.media?.videoCount ?? null,
            cover: item.cover ? {
                url: `https://raw.githubusercontent.com/${repository}/${commit}/${item.cover.path}`,
                kind: item.cover.kind,
                timeSeconds: item.cover.timeSeconds ?? null,
            } : null,
            media: item.webPlayback ? {
                url: item.webPlayback.url,
                kind: item.webPlayback.kind,
                checkedAt: item.webPlayback.checkedAt,
                verificationLevel: item.webPlayback.verificationLevel ?? null,
                reuploadPermission: item.webPlayback.reuploadPermission ?? "not_verified",
            } : null,
            prompt: {
                status: item.prompt.status,
                sourceUrl: item.prompt.sourceUrl,
                checkedAt: item.prompt.checkedAt,
                display: item.prompt.display ?? "inline_in_upstream",
                hasInlineText: Boolean(item.prompt.text?.trim()),
            },
            resources,
            upstreamVerification: item.verification ?? {},
            upstreamStage: item.stage ?? "catalogued",
            galleryUrl: `https://guanmo-ai.github.io/awesome-ai-motion/#case-${item.id}`,
            caseUrl: `https://github.com/${repository}/blob/${commit}/cases/${item.id}.md`,
        };
    });
    return {
        schemaVersion: 1,
        source: {
            repository: `https://github.com/${repository}`,
            commit,
            fetchedAt,
            upstreamSchemaVersion: input.schemaVersion,
            sourceSha256,
            dataUrl: `https://raw.githubusercontent.com/${repository}/${commit}/data/cases.json`,
            verification: "metadata_fetched",
        },
        stats: {
            works: cases.length,
            originalPrompts: cases.filter((item) => item.prompt.status === "original").length,
            codeCases: cases.filter((item) => item.resources.some((resource) => resource.kind === "code")).length,
            mediaEntrypoints: cases.filter((item) => item.media?.url).length,
        },
        cases,
    };
}

async function fetchText(url) {
    const response = await fetch(url, { headers: { "User-Agent": "BeefTV-Motion-References" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Reference refresh failed: HTTP ${response.status} at ${url}`);
    return response.text();
}

async function main(args) {
    if (args.some((arg) => !["--latest", "--commit"].includes(arg) && !/^[a-f0-9]{40}$/.test(arg))) {
        throw new Error("Usage: bun scripts/refresh-motion-references.mjs [--latest | --commit FULL_SHA]");
    }
    if (args.includes("--latest") && args.includes("--commit")) throw new Error("Choose either --latest or --commit.");
    let commit = initialCommit;
    try { commit = JSON.parse(await readFile(snapshotFile, "utf8")).source.commit; } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (args.includes("--commit")) commit = args[args.indexOf("--commit") + 1] ?? "";
    if (args.includes("--latest")) {
        const page = await fetchText(`https://github.com/${repository}`);
        commit = page.match(/"currentOid":"([a-f0-9]{40})"/)?.[1] ?? "";
    }
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Unable to resolve a full upstream commit SHA; snapshot retained.");
    const sourceText = await fetchText(`https://raw.githubusercontent.com/${repository}/${commit}/data/cases.json`);
    const snapshot = normalizeMotionReferences(JSON.parse(sourceText), {
        commit,
        fetchedAt: new Date().toISOString(),
        sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    });
    const annotations = JSON.parse(await readFile(annotationsFile, "utf8"));
    const refreshedIds = new Set(snapshot.cases.map((item) => item.id));
    const missingIds = Object.keys(annotations.entries).filter((id) => !refreshedIds.has(id));
    if (missingIds.length) throw new Error(`Refresh would orphan local reference annotations: ${missingIds.join(", ")}; snapshot retained.`);
    await mkdir(dataDirectory, { recursive: true });
    const temporary = new URL("motion-references.json.refresh.tmp", dataDirectory);
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporary, snapshotFile);
    process.stdout.write(`${JSON.stringify({ ...snapshot.source, ...snapshot.stats })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    await main(process.argv.slice(2));
}

import { describe, expect, test } from "bun:test";

import {
    lookupMotionReference, MOTION_REFERENCES, MOTION_REFERENCE_SOURCE, MOTION_REFERENCE_STATS,
    MOTION_REFERENCE_ANNOTATIONS, searchMotionReferences,
} from "@/lib/canvas/director/motion-reference";
import { normalizeMotionReferences } from "../../scripts/refresh-motion-references.mjs";

describe("动效参考固定快照", () => {
    test("来源固定到完整提交与数据哈希，数量来自本地数据", () => {
        expect(MOTION_REFERENCE_SOURCE.commit).toMatch(/^[a-f0-9]{40}$/);
        expect(MOTION_REFERENCE_SOURCE.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(MOTION_REFERENCE_SOURCE.dataUrl).toContain(MOTION_REFERENCE_SOURCE.commit);
        expect(MOTION_REFERENCE_SOURCE.verification).toBe("metadata_fetched");
        expect(MOTION_REFERENCE_STATS.works).toBe(MOTION_REFERENCES.length);
        expect(MOTION_REFERENCE_STATS.originalPrompts).toBe(MOTION_REFERENCES.filter((item) => item.prompt.status === "original").length);
        expect(MOTION_REFERENCE_STATS.codeCases).toBe(MOTION_REFERENCES.filter((item) => item.resources.some((resource) => resource.kind === "code")).length);
        expect(new Set(MOTION_REFERENCES.map((item) => item.id)).size).toBe(MOTION_REFERENCES.length);
    });

    test("保留 source-only 提示词状态，不将未收全文当未公开", () => {
        const reference = lookupMotionReference("2103099194693271874")!;
        expect(reference.prompt.status).toBe("original");
        expect(reference.prompt.display).toBe("source_link");
        expect(reference.prompt.hasInlineText).toBe(false);
        expect(reference.upstreamVerification.independentlyReproduced).toBe(false);
    });

    test("本地注释与上游事实独立且没有虚构动态审看", () => {
        expect(Object.keys(MOTION_REFERENCE_ANNOTATIONS).every((id) => Boolean(lookupMotionReference(id)))).toBe(true);
        for (const annotation of Object.values(MOTION_REFERENCE_ANNOTATIONS)) {
            expect(["metadata_only", "static_frame_reviewed"]).toContain(annotation.reviewState);
            if (annotation.reviewState === "static_frame_reviewed") {
                expect(annotation.reviewEvidence?.method).toBe("sampled_contact_sheet");
                expect(annotation.reviewEvidence?.mediaSha256).toMatch(/^[a-f0-9]{64}$/);
                expect(annotation.segment!.toSeconds).toBeGreaterThan(annotation.segment!.fromSeconds);
            } else expect(annotation.segment).toBeNull();
        }
        expect(MOTION_REFERENCES.every((item) => !("tags" in item) && !("reviewState" in item))).toBe(true);
    });
});

describe("可解释中文检索", () => {
    test("科技感但不要满屏 glow 优先明确禁用辉光的连续 UI", () => {
        const results = searchMotionReferences("科技感但不要满屏 glow，简洁连续的产品界面", 5);
        expect(results).toHaveLength(5);
        expect(results[0].reference.id).toBe("2103273003555402193");
        expect(results[0].matchedTags).toContain("no-glow");
        expect(results.every((result) => !result.matchedTags.includes("glow"))).toBe(true);
        expect(results.some((result) => result.reference.id === "2105783511433318451")).toBe(false);
        expect(results.every((result) => result.exclusionCoverage === "tagged_only")).toBe(true);
        expect(results[0].reasons.join(" ")).toContain("未标注画面仍需审看");
    });

    test("数据交接不要像 PPT 映射连续因果而非随机炫技", () => {
        const results = searchMotionReferences("讲清数据交接，不要像 PPT，要连续流畅", 5);
        expect(results).toHaveLength(5);
        expect(results.some((result) => result.reference.id === "2104148233106723099")).toBe(true);
        expect(results[0].matchedTags).toContain("object-relay");
        expect(results[0].matchedTags).toContain("causality");
        expect(results[0].reasons.join(" ")).toContain("对象交接");
        expect(results.every((result) => result.excludedTags.includes("slide"))).toBe(true);
    });

    test("角色跨镜连续与画风变化保持身份，保留待审看状态", () => {
        const results = searchMotionReferences("角色连续性，机器人穿越不同材质与空间", 5);
        expect(results).toHaveLength(5);
        expect(results.some((result) => result.reference.id === "2103099194693271874")).toBe(true);
        expect(results.every((result) => ["metadata_only", "static_frame_reviewed"].includes(result.reviewState))).toBe(true);
        expect(results.every((result) => result.reasons.length > 0)).toBe(true);
    });

    test("稳定排序、不修改数据、空及未知查询和限制有明确结果", () => {
        const before = JSON.stringify(MOTION_REFERENCE_ANNOTATIONS);
        expect(searchMotionReferences("图解推进", 3)).toEqual(searchMotionReferences("图解推进", 3));
        expect(searchMotionReferences("", 3)).toHaveLength(3);
        expect(searchMotionReferences("no-such-case-498251", 5)).toEqual([]);
        expect(searchMotionReferences("技术", Number.NaN)).toEqual([]);
        expect(searchMotionReferences("技术", 0)).toEqual([]);
        expect(searchMotionReferences("技术 -camera-push", 10).every((result) => !result.matchedTags.includes("camera-push"))).toBe(true);
        expect(JSON.stringify(MOTION_REFERENCE_ANNOTATIONS)).toBe(before);
    });
});

describe("参考刷新规范化", () => {
    const source = { commit: "a".repeat(40), fetchedAt: "2026-10-05T00:00:00.000Z", sourceSha256: "b".repeat(64) };
    const item = { id: "case-1", title: "用例", category: "短动效", author: { handle: "author" }, source: { url: "https://example.com/post" }, prompt: { status: "original", text: "private prompt is not copied", sourceUrl: "https://example.com/prompt" }, resources: [{ kind: "code", url: "https://example.com/code" }], codeUrl: "https://example.com/code" };

    test("计数去重资源，禁止引入本地评价和第三方全文", () => {
        const result = normalizeMotionReferences({ schemaVersion: 2, cases: [item] }, source);
        expect(result.stats).toEqual({ works: 1, originalPrompts: 1, codeCases: 1, mediaEntrypoints: 0 });
        expect(result.cases[0].resources).toHaveLength(1);
        expect(result.cases[0].prompt.hasInlineText).toBe(true);
        expect(JSON.stringify(result)).not.toContain("private prompt is not copied");
        expect(result.cases[0]).not.toHaveProperty("reviewState");
    });

    test("坏 schema、重复 ID、提示词状态或不完整 SHA 拒绝更新", () => {
        expect(() => normalizeMotionReferences({ schemaVersion: 3, cases: [] }, source)).toThrow("Unsupported");
        expect(() => normalizeMotionReferences({ schemaVersion: 2, cases: [item, item] }, source)).toThrow("duplicate");
        expect(() => normalizeMotionReferences({ schemaVersion: 2, cases: [{ ...item, prompt: { status: "verified" } }] }, source)).toThrow("prompt status");
        expect(() => normalizeMotionReferences({ schemaVersion: 2, cases: [] }, { ...source, commit: "main" })).toThrow("commit SHA");
    });
});

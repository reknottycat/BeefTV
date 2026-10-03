import { expect, test } from "bun:test";
import { catalogEntryStatus, catalogInputDescription, readModelCatalogLocation } from "../src/lib/model-catalog-types";

test("catalog location preserves a supported source and bounded server search/paging", () => {
    expect(readModelCatalogLocation(new URLSearchParams("catalogSource=rh.standard&catalogCapability=video&catalogPage=3&catalogSearch=first-frame"))).toEqual({ source: "rh.standard", capability: "video", page: 3, page_size: 20, search: "first-frame" });
    expect(readModelCatalogLocation(new URLSearchParams("section=channels"))).toEqual({ source: "comfy.recipes", page: 1, page_size: 20, search: "" });
});

test("unknown source, invalid capability and invalid pagination cannot become outbound addresses", () => {
    for (const page of ["0", "-1", "1.1", "1e3", "1000000", "url"]) {
        const result = readModelCatalogLocation(new URLSearchParams(`catalogSource=https://untrusted.invalid&catalogCapability=vision-guessed&catalogPage=${page}`));
        expect(result.source).toBe("comfy.recipes");
        expect(result.page).toBe(1);
        expect(result.capability).toBeUndefined();
    }
    expect(readModelCatalogLocation(new URLSearchParams({ catalogSearch: "x".repeat(250) })).search).toHaveLength(200);
    expect(readModelCatalogLocation(new URLSearchParams("catalogPageSize=50")).page_size).toBe(50);
    expect(readModelCatalogLocation(new URLSearchParams("catalogPageSize=201")).page_size).toBe(20);
});

test("a public directory entry never becomes account-authorized or a successful generation", () => {
    expect(catalogEntryStatus({ source: "rh.llm", availability: { status: "account_unknown", callable: false, accountVerified: false } })).toBe("账户可用性未验证");
    expect(catalogEntryStatus({ source: "rh.standard", availability: { status: "deprecated", callable: false, accountVerified: false } })).toBe("目录标记已下架");
    const local = { source: "comfy.recipes" as const, availability: { status: "account_unknown", callable: false, accountVerified: false }, staticChecks: { recipe: "passed", objectInfo: "passed", issues: [], modelChecks: [] } };
    expect(catalogEntryStatus(local)).toContain("真实生成未验证");
    expect(catalogEntryStatus({ ...local, staticChecks: { ...local.staticChecks, objectInfo: "failed" } })).toBe("静态检查未通过");
    expect(catalogEntryStatus({ ...local, staticChecks: undefined })).toContain("节点检查未完成");
});

test("first-frame constraints describe minimum resolution and unchanged aspect accurately", () => {
    const value = catalogInputDescription({ name: "reference_1", kind: "image", required: true, mimeTypes: ["image/png"], sameAspect: true, minimumWidth: 864, minimumHeight: 480 });
    expect(value).toContain("必填");
    expect(value).toContain("image/png");
    expect(value).toContain("至少 864×480");
    expect(value).toContain("宽高比必须与配方相同");
    expect(value).not.toContain("自动裁剪");
});

test("requirements retain limits and public enum options without inventing defaults", () => {
    expect(catalogInputDescription({ name: "images", kind: "image", required: false, multiple: true, maxCount: 3, maxSizeMB: 10 })).toContain("最多 3 项");
    expect(catalogInputDescription({ name: "duration", kind: "enum", required: true, options: [5, 10], min: 5, max: 10 })).toContain("可选：5 / 10");
});

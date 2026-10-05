import snapshot from "./motion-data/motion-references.json";
import localAnnotations from "./motion-data/motion-reference-annotations.json";

export type MotionReferenceReviewState = "metadata_only" | "static_frame_reviewed" | "dynamic_segment_reviewed" | "independently_reproduced";

export interface MotionReference {
    id: string;
    title: string;
    titleEn: string | null;
    category: string;
    author: { name: string; handle: string; url: string };
    source: { url: string; publishedAt: string };
    durationSeconds: number | null;
    videoCount: number | null;
    cover: { url: string; kind: string; timeSeconds: number | null } | null;
    media: { url: string; kind: string; checkedAt: string; verificationLevel: string | null; reuploadPermission: string } | null;
    prompt: { status: "original" | "brief" | "unknown"; sourceUrl: string; checkedAt: string; display: string; hasInlineText: boolean };
    resources: Array<{ kind: string; url: string; label?: string; evidenceUrl?: string; checkedAt?: string; license?: string; licenseUrl?: string }>;
    upstreamVerification: Record<string, unknown>;
    upstreamStage: string;
    galleryUrl: string;
    caseUrl: string;
}

export interface MotionReferenceAnnotation {
    tags: string[];
    basis: "upstream_metadata" | "source_prompt_read" | "source_code_read";
    reason: string;
    reviewState: MotionReferenceReviewState;
    segment: { fromSeconds: number; toSeconds: number } | null;
    sourceUrls: string[];
    reviewEvidence?: {
        method: "sampled_contact_sheet";
        reviewedAt: string;
        frameTimesSeconds: number[];
        artifactRelativePath: string;
        mediaSha256: string;
        observations: string[];
        limitations: string[];
    };
}

export interface MotionReferenceSearchResult {
    reference: MotionReference;
    score: number;
    reasons: string[];
    matchedTags: string[];
    excludedTags: string[];
    reviewState: MotionReferenceReviewState;
    annotation?: MotionReferenceAnnotation;
    exclusionCoverage: "tagged_only";
}

export const MOTION_REFERENCE_SOURCE = snapshot.source;
export const MOTION_REFERENCE_STATS = snapshot.stats;
export const MOTION_REFERENCES = snapshot.cases as unknown as MotionReference[];
export const MOTION_REFERENCE_ANNOTATIONS = localAnnotations.entries as unknown as Record<string, MotionReferenceAnnotation>;

const tagQueries: Array<{ test: RegExp; tags: string[]; label: string }> = [
    { test: /科技|技术|模型|人工智能|AI|LLM|transformer/i, tags: ["technology"], label: "技术主题" },
    { test: /讲解|解释|教学|知识|原理|机制/, tags: ["explanation", "causality"], label: "解释关系" },
    { test: /交接|传递|接力|relay/i, tags: ["object-relay", "causality"], label: "对象交接" },
    { test: /数据|任务|权限|信息流|因果/, tags: ["causality", "token-routing", "state-propagation"], label: "信息因果" },
    { test: /不要像\s*PPT|避免.*PPT|连贯|连续|一镜到底|流畅|不断切/i, tags: ["continuous-shape-transition", "continuity"], label: "连续编排" },
    { test: /转场|承接|过镜/, tags: ["continuous-shape-transition", "object-relay", "portal-passage"], label: "镜间承接" },
    { test: /推进|推镜|聚焦|焦点|近看|camera\s*push/i, tags: ["camera-push", "focus-shift"], label: "焦点和机位" },
    { test: /空间|纵深|三维|3D|景深|视差/i, tags: ["spatial"], label: "空间关系" },
    { test: /文字|字幕|术语|关键句|排版|type/i, tags: ["kinetic-type", "semantic-highlight"], label: "文字阅读" },
    { test: /图解|关系图|架构|流程|状态变化|diagram/i, tags: ["diagram-morph", "causality"], label: "图解变化" },
    { test: /角色|人物|身份|机器人/, tags: ["character", "continuity"], label: "角色连续性" },
    { test: /弹性|回弹|弹簧|spring/i, tags: ["spring", "physics"], label: "受力回稳" },
    { test: /重量|惯性|冲击|碰撞|impact/i, tags: ["physics", "impact-reveal", "momentum-carry"], label: "受力响应" },
    { test: /节拍|节奏|快慢|音乐|beat/i, tags: ["beat-sync"], label: "节奏锚点" },
    { test: /材质|水墨|纸|玻璃|金属/, tags: ["material", "material-shift"], label: "材质" },
    { test: /简洁|克制|极简|不要满屏|少字|文字少/, tags: ["minimal", "low-text-density"], label: "视觉密度" },
    { test: /产品|发布|界面|UI/i, tags: ["product"], label: "产品用途" },
];

function getQueryExclusions(query: string): string[] {
    const exclusions: string[] = [];
    if (/(?:不要|避免|排除|不想|不用|无|没有|少)(?:\s*满屏)?\s*(?:glow|辉光|泛光|发光)/i.test(query)) exclusions.push("glow");
    if (/(?:不要|避免|排除|不想).*?(?:PPT|幻灯片)/i.test(query)) exclusions.push("slide");
    for (const match of query.matchAll(/-([a-z][a-z-]+)/gi)) exclusions.push(match[1].toLowerCase());
    return Array.from(new Set(exclusions));
}

function metadataTags(reference: MotionReference): string[] {
    const tags: string[] = [];
    if (/知识|科普/.test(reference.category)) tags.push("explanation");
    if (/产品/.test(reference.category)) tags.push("product");
    if (/像素|角色/.test(reference.category)) tags.push("character");
    if (/3D|交互/.test(reference.category)) tags.push("spatial");
    if (/glow|辉光|霓虹|发光/i.test(reference.title)) tags.push("glow");
    if (/课件|PPT|幻灯片/i.test(reference.title)) tags.push("slide");
    return tags;
}

export function lookupMotionReference(id: string): MotionReference | undefined {
    return MOTION_REFERENCES.find((reference) => reference.id === id);
}

export function searchMotionReferences(query: string, limit = 5): MotionReferenceSearchResult[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const trimmedQuery = query.trim();
    const exclusions = getQueryExclusions(trimmedQuery);
    const facets = tagQueries.filter((facet) => facet.test.test(trimmedQuery));
    const words = trimmedQuery.toLowerCase().split(/[\s，。；、,;]+/).filter((word) => word.length >= 2 && !word.startsWith("-"));
    const results = MOTION_REFERENCES.flatMap((reference): MotionReferenceSearchResult[] => {
        const annotation = MOTION_REFERENCE_ANNOTATIONS[reference.id];
        const tags = new Set([...metadataTags(reference), ...(annotation?.tags ?? [])]);
        if (exclusions.some((tag) => tags.has(tag))) return [];
        let score = 0;
        const reasons: string[] = [];
        const matchedTags = new Set<string>();
        for (const facet of facets) {
            const matches = facet.tags.filter((tag) => tags.has(tag));
            if (!matches.length) continue;
            score += matches.length * 3;
            if (tags.has(facet.tags[0])) score += 4;
            matches.forEach((tag) => matchedTags.add(tag));
            reasons.push(`${facet.label}：${matches.join("、")}${annotation ? "（本地候选标签）" : "（上游分类）"}`);
        }
        const searchable = `${reference.id} ${reference.title} ${reference.titleEn ?? ""} ${reference.author.handle} ${reference.category}`.toLowerCase();
        for (const word of words) {
            if (!searchable.includes(word)) continue;
            score += 4;
            reasons.push(`元数据匹配：${word}`);
        }
        if (trimmedQuery && score === 0) return [];
        if (annotation) reasons.push(annotation.reason);
        if (annotation?.reviewEvidence) reasons.push(`已看${annotation.reviewEvidence.frameTimesSeconds.length}个时码静帧；连续动作和听感未验证`);
        if (exclusions.includes("glow") && tags.has("no-glow")) {
            score += 5;
            matchedTags.add("no-glow");
            reasons.push("原始制作规格明确排除 glow");
        }
        if (!trimmedQuery) reasons.push("未设检索条件，按稳定案例 ID 排列");
        if (exclusions.length) reasons.push(`排除已标注项：${exclusions.join("、")}；未标注画面仍需审看`);
        return [{
            reference, score, reasons, matchedTags: [...matchedTags], excludedTags: exclusions,
            reviewState: annotation?.reviewState ?? "metadata_only", annotation, exclusionCoverage: "tagged_only",
        }];
    });
    return results.sort((a, b) => b.score - a.score || a.reference.id.localeCompare(b.reference.id)).slice(0, Math.floor(limit));
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Select as AntSelect, Tag } from "antd";
import type { InputRef } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PaginationBar } from "@/components/layout/workspace-page";

import {
    catalogEntryStatus, catalogInputDescription, modelCatalogCapabilityLabels, modelCatalogSourceLabels,
    modelCatalogSources, readModelCatalogLocation,
} from "@/lib/model-catalog-types";
import type { ModelCatalogEntry, ModelCatalogSource } from "@/lib/model-catalog-types";
import { listLocalModelCatalog, refreshLocalModelCatalog } from "@/services/api/local-comfy";

function CatalogEntry({ entry }: { entry: ModelCatalogEntry }) {
    return <li className="space-y-2 border-b border-border py-3 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-medium">{entry.name}</h3>
            <Tag>{modelCatalogCapabilityLabels[entry.capability]}</Tag>
            <span className="text-xs text-foreground/60">{catalogEntryStatus(entry)}</span>
        </div>
        <p className="break-all font-mono text-xs text-foreground/60">{entry.modelId}</p>
        <p className="text-sm">{entry.task || "输入模式尚需核对"} · {entry.source === "comfy.recipes" ? "配方声明输出" : "官方输出类型"}：{entry.outputKind}</p>
        <p className="text-xs text-foreground/60">{entry.source === "comfy.recipes" ? "本地目录检查不会开启生成。" : "目录已发现；真实调用、账户权限和余额未验证。"}</p>
        <details className="text-sm">
            <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">查看输入要求与证据</summary>
            <div className="space-y-2 py-2">
                {entry.inputRequirementsKnown ? <ul className="space-y-1">{entry.inputs.map((input) => <li key={input.name} className="break-words">{catalogInputDescription(input)}</li>)}</ul> : <p>此目录未提供完整输入合同；不能从模型名称推断图片或视频识别能力。</p>}
                {entry.source === "comfy.recipes" ? <>
                    <p>当前适配器只接收图片参考，不支持视频或音频参考上传。</p>
                    <p>配方检查：{entry.staticChecks?.recipe || "未知"}；节点检查：{entry.staticChecks?.objectInfo || "未知"}</p>
                    {entry.staticChecks?.issues.length ? <ul className="space-y-1">{entry.staticChecks.issues.map((issue, index) => <li key={index} className="break-words">{issue.code}{issue.nodeId ? ` · 节点 ${issue.nodeId}` : ""}{issue.input ? ` · ${issue.input}` : ""}</li>)}</ul> : null}
                    <p className="break-all font-mono text-xs">工作流 SHA-256：{entry.workflowSha256}</p>
                    <p className="break-all font-mono text-xs">配方 SHA-256：{entry.recipeSha256}</p>
                </> : <p>费用：账户报价未知；未授权付费调用。</p>}
                {entry.officialPricing !== undefined ? <div><p>官方价格元数据（非账户报价）</p><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(entry.officialPricing, null, 2)}</pre></div> : null}
                {entry.officialCapabilities !== undefined ? <div><p>官方能力元数据（真实识别未验证）</p><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(entry.officialCapabilities, null, 2)}</pre></div> : null}
            </div>
        </details>
    </li>;
}

export function ModelCatalogPane() {
    const [params, setParams] = useSearchParams();
    const query = readModelCatalogLocation(params);
    const [draft, setDraft] = useState(query.search || "");
    const composing = useRef(false);
    const searchRef = useRef<InputRef>(null);
    const queryClient = useQueryClient();
    const update = (values: Record<string, string | undefined>) => setParams((current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
        if (!("catalogPage" in values)) next.delete("catalogPage");
        return next;
    }, { replace: true });
    const commitSearch = (value: string) => update({ catalogSearch: value.trim().slice(0, 200) || undefined });

    useEffect(() => { setDraft(query.search || ""); }, [query.search]);
    useEffect(() => {
        if (composing.current || draft.trim() === query.search) return;
        const timer = window.setTimeout(() => { if (!composing.current) commitSearch(draft); }, 300);
        return () => window.clearTimeout(timer);
    }, [draft, query.search]);

    const result = useQuery({
        queryKey: ["local-comfy", "model-catalog", query.source, query],
        queryFn: ({ signal }) => listLocalModelCatalog(query, signal),
        retry: false,
        staleTime: 30_000,
        placeholderData: (previous) => previous?.source === query.source ? previous : undefined,
    });
    const refresh = useMutation({
        mutationFn: (source: ModelCatalogSource) => refreshLocalModelCatalog(source),
        onSuccess: (_data, source) => queryClient.invalidateQueries({ queryKey: ["local-comfy", "model-catalog", source] }),
    });
    const refreshing = refresh.isPending && refresh.variables === query.source;
    const data = result.data;
    const cacheLabel = data?.cacheStatus === "fresh" ? "上次查询时缓存有效" : data?.cacheStatus === "stale" ? "上次查询时缓存过期" : "尚未刷新";
    useEffect(() => {
        if (!data || result.isPlaceholderData) return;
        const lastPage = Math.max(1, Math.ceil(data.total / query.page_size));
        if (query.page > lastPage) update({ catalogPage: String(lastPage) });
    }, [data, result.isPlaceholderData, query.page, query.page_size]);

    return <section className="settings-section mb-4 space-y-4" aria-labelledby="model-catalog-title">
        <div className="settings-pane-header"><div><h2 id="model-catalog-title">工作流与模型目录</h2><p>先核对输入模式与目录来源；刷新目录不会调用生成接口。</p></div></div>
        <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 space-y-1.5" htmlFor="model-catalog-source"><span className="block text-sm">目录来源</span><AntSelect id="model-catalog-source" className="w-72 max-w-full" value={query.source} options={modelCatalogSources.map((source) => ({ value: source, label: modelCatalogSourceLabels[source] }))} onChange={(value) => { refresh.reset(); update({ catalogSource: value }); }} /></label>
            <label className="space-y-1.5" htmlFor="model-catalog-capability"><span className="block text-sm">输出类型</span><AntSelect id="model-catalog-capability" className="w-32" value={query.capability || "all"} options={[{ value: "all", label: "全部输出" }, ...Object.entries(modelCatalogCapabilityLabels).map(([value, label]) => ({ value, label }))]} onChange={(value) => update({ catalogCapability: value === "all" ? undefined : value })} /></label>
            <Button loading={refreshing} disabled={refresh.isPending} onClick={() => refresh.mutate(query.source)}>刷新当前目录</Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1.5" htmlFor="model-catalog-search"><span className="block text-sm">搜索名称、标识或输入模式</span><Input id="model-catalog-search" ref={searchRef} value={draft} maxLength={200} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(event) => { composing.current = false; setDraft(event.currentTarget.value); commitSearch(event.currentTarget.value); }} onPressEnter={() => { if (!composing.current) commitSearch(draft); }} /></label>
            <Button onClick={() => { if (!composing.current) commitSearch(draft); }}>搜索</Button>
            {draft ? <Button onClick={() => { setDraft(""); commitSearch(""); searchRef.current?.focus(); }} aria-label="清空目录搜索">清空搜索</Button> : null}
        </div>
        <p className="text-sm text-foreground/60">{query.source === "comfy.recipes" ? "只检查已登记的配方、节点和所选权重是否匹配；静态检查通过不能证明 GPU 生成成功。" : query.source === "rh.standard" ? "来源为官方 capabilities.json 能力目录，属于官方目录快照；不代表账户实时授权或可用额度。" : "来源为公开 /v1/models 文本目录。实际文本调用需要配置 Enterprise-Shared Key；此页不读取任何密钥。"}</p>
        {result.isPending ? <p role="status" className="min-h-16 text-sm text-foreground/60">正在读取工作区目录缓存…</p> : null}
        {result.isError ? <Alert type="error" title="目录缓存读取失败" description="当前列表状态未知，请重试读取缓存。" action={<Button size="small" loading={result.isFetching} onClick={() => void result.refetch()}>重试读取</Button>} /> : null}
        {refresh.isError && refresh.variables === query.source ? <Alert type="error" title="目录刷新未完成" description="已有缓存仍可查看，请稍后再刷新。" /> : null}
        {data ? <>
            <div className="flex flex-wrap gap-2 text-xs text-foreground/60" role="status"><Tag>{cacheLabel}</Tag><span>最近成功刷新：{data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN", { timeZone: "UTC" }) + " UTC" : "尚无记录"}</span><span className="break-all">来源版本：{data.sourceVersion || "未知"}</span></div>
            {data.lastError ? <Alert type="warning" title="上游目录刷新失败" description={`${data.lastError === "invalid_snapshot" ? "目录内容未通过格式校验" : "目录来源暂时不可达"}；${data.fetchedAt ? "继续显示上次成功缓存。" : "尚无成功缓存，请重试刷新当前目录。"}`} /> : null}
            <p className="text-sm">{modelCatalogSourceLabels[data.source]} · 共 {data.total} 项{result.isFetching ? " · 正在更新列表…" : ""}</p>
            <div className="min-h-24" aria-busy={result.isFetching || refreshing}>
                {data.items.length ? <ul>{data.items.map((entry) => <CatalogEntry key={entry.id} entry={entry} />)}</ul> : <p className="py-4 text-sm text-foreground/60">{data.cacheStatus === "empty" ? "尚无目录缓存，点击“刷新当前目录”读取官方目录或已登记节点。" : "没有符合当前筛选条件的条目，请清空搜索或调整输出类型。"}</p>}
            </div>
            {data.total > 0 ? <PaginationBar current={query.page} pageSize={query.page_size} total={data.total} itemLabel="项" onChange={(page, pageSize) => update({ catalogPage: String(page), catalogPageSize: String(pageSize) })} /> : null}
        </> : null}
        <p className="text-xs text-foreground/60">AI 应用社区浏览、个人工作流 ID 导入和 Comfy 权重资源库是不同目录，尚未接入此页。已登记的本地配方可在项目默认模型和图片、视频模型选择器中选择。</p>
        <Link to="/local-comfy" className="text-sm underline underline-offset-4">打开本地工作流工作台</Link>
    </section>;
}

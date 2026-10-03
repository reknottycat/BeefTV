import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Tag } from "antd";
import { Link } from "react-router";

import { getLocalComfyConfig, listLocalComfyRecipes, localComfyServiceUrl } from "@/services/api/local-comfy";
import { publicLocalComfyEndpoint } from "@/lib/local-comfy-settings";
import { ModelCatalogPane } from "./model-catalog-pane";

export function LocalComfySettingsPane() {
    const status = useQuery({
        queryKey: ["local-comfy", "settings-status"],
        queryFn: async ({ signal }) => {
            const [config, recipes] = await Promise.all([getLocalComfyConfig(signal), listLocalComfyRecipes(signal)]);
            return { config, recipes };
        },
        retry: false,
        staleTime: 30_000,
    });
    const readyRecipes = status.data?.recipes.filter((recipe) => recipe.ready) || [];
    const upstream = publicLocalComfyEndpoint(status.data?.config.comfyui_endpoint);

    return <><section className="settings-section mb-4" aria-labelledby="local-comfy-settings-title">
        <div className="settings-pane-header">
            <div className="min-w-0"><h2 id="local-comfy-settings-title">本地 ComfyUI 工作流</h2><p>使用已登记的配方和参考图，本地工作流独立于下方模型渠道。</p></div>
            <Link to="/local-comfy" className="text-sm underline underline-offset-4">打开本地 ComfyUI 工作台</Link>
        </div>
        {status.isPending ? <p role="status" className="text-sm text-foreground/60">正在读取本地工作流配置…</p> : null}
        {status.isError ? <Alert type="error" title="本地工作流配置读取失败" description="当前端点与配方状态未知，请重试读取。" action={<Button size="small" loading={status.isFetching} onClick={() => void status.refetch()}>重试读取</Button>} /> : null}
        {status.data ? <div className="space-y-3">
            <label className="block space-y-1.5" htmlFor="local-comfy-settings-endpoint"><span className="text-sm">工作流接口</span><Input id="local-comfy-settings-endpoint" readOnly value={localComfyServiceUrl} /></label>
            {upstream ? <label className="block space-y-1.5" htmlFor="local-comfy-settings-upstream"><span className="text-sm">ComfyUI 地址</span><Input id="local-comfy-settings-upstream" readOnly value={upstream} /></label> : <p className="text-xs text-foreground/50">当前服务尚未提供可显示的 ComfyUI 上游地址。</p>}
            <div className="flex flex-wrap items-center gap-2"><Tag color={status.data.config.generation_enabled ? "success" : "default"}>{status.data.config.generation_enabled ? "生成已启用" : "生成未启用"}</Tag><span className="text-sm">已配置 {readyRecipes.length} / {status.data.recipes.length} 个配方</span><Button size="small" loading={status.isFetching} onClick={() => void status.refetch()}>刷新状态</Button></div>
            {status.data.recipes.length ? <ul className="space-y-2">{status.data.recipes.map((recipe) => <li key={recipe.id} className="flex flex-wrap items-center gap-2 text-sm"><span>{recipe.name}</span><Tag>{recipe.ready ? "已配置" : "未配置"}</Tag><span className="text-xs text-foreground/50">{recipe.reference_slots} 张参考图</span></li>)}</ul> : <p className="text-sm text-foreground/60">尚无已登记配方。</p>}
            <p className="text-xs text-foreground/50">配方状态表示工作流已配置；真实生成与结果验收在工作台中记录。</p>
        </div> : null}
    </section><ModelCatalogPane /></>;
}

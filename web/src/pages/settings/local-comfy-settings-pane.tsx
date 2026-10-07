import { Alert, Button, Tag } from "antd";
import { useLocalComfyModelCatalog } from "@/lib/use-local-comfy-model-catalog";
import { encodeLocalComfyModel, localComfyModelSummary, localComfyRecipeSupportProblem, localComfyStatusMessage, type LocalComfyStatus } from "@/lib/local-comfy-models";

const statusLabels: Record<LocalComfyStatus, string> = {
    loading: "正在读取", offline: "暂时无法连接", unconfigured: "尚未连接", empty: "尚无配方", disabled: "生成未启用", unsupported: "暂无支持的配方", not_ready: "工作流未就绪", ready: "本地服务已连接，生成已启用",
};

export function LocalComfySettingsPane() {
    const catalog = useLocalComfyModelCatalog();
    const status = catalog.localComfyStatus || "loading";
    const recipes = catalog.localComfyModels || [];
    return <section className="settings-section mb-4" aria-labelledby="local-comfy-settings-title">
        <div className="settings-pane-header">
            <div className="min-w-0"><h2 id="local-comfy-settings-title">本地 ComfyUI</h2><p>在现有项目中选择本地图片或视频模型，生成记录统一进入任务中心。</p></div>
            <Button size="small" loading={catalog.refreshing} onClick={() => void catalog.refresh()}>刷新状态</Button>
        </div>
        <div className="space-y-3" aria-live="polite" aria-busy={catalog.refreshing}>
            <p className="flex flex-wrap items-center gap-2"><Tag color={status === "ready" ? "success" : status === "offline" ? "warning" : "default"}>{statusLabels[status]}</Tag>{catalog.refreshing && status !== "loading" ? <span className="text-xs text-foreground/60">正在刷新，保留上次读取的配方。</span> : null}</p>
            {status !== "ready" && status !== "loading" ? <Alert type={status === "offline" ? "warning" : "info"} title={localComfyStatusMessage(status)} description={status === "offline" ? "暂不能提交生成；原模型选择和项目内容保持不变。恢复连接后点击“刷新状态”。" : "请按下方配置说明完成本地服务与配方设置，再刷新状态。"} /> : null}
            {status === "loading" ? <p role="status" className="text-sm text-foreground/60">正在读取本地服务与配方…</p> : null}
            {recipes.length ? <ul className="space-y-3">{recipes.map((recipe) => {
                const problem = localComfyRecipeSupportProblem(recipe);
                return <li key={recipe.id} className="space-y-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><span>{recipe.name || recipe.id}</span><Tag>{problem ? "暂不支持原生生成" : recipe.ready ? "已配置" : "工作流未就绪"}</Tag></div>
                    <p className="text-xs text-foreground/60">{problem || localComfyModelSummary(encodeLocalComfyModel(recipe.id), catalog)}</p>
                </li>;
            })}</ul> : null}
            <p className="text-xs text-foreground/60">“已配置”表示配方声明完整，不代表 GPU 已完成生成验收。提交时再检查设备与队列；首次使用请在项目中生成一张图片或一个镜头并检查结果。</p>
            <a className="text-sm underline underline-offset-4" href="https://github.com/reknottycat/BeefTV/blob/main/docs/content/docs/backend/local-comfy.mdx" target="_blank" rel="noreferrer">查看本地服务与配方配置说明</a>
        </div>
    </section>;
}

import { AudioLines, Check, Film, Image, MessageSquareText } from "lucide-react";
import { App, Alert, Button, Input, Select } from "antd";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { ModelIcon } from "@/components/model-picker";
import { cn } from "@/lib/utils";
import {
    filterModelsByCapability,
    modelDisplayName,
    resolveModelChannel,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { localComfyDefaultProblem, localComfyRecipeMode, localComfySeedProblem, normalizeLocalComfyDefaults, type LocalComfyDefaults, type LocalComfyMode } from "@/lib/local-comfy-defaults";
import { awaitModelConfigSaved, modelConfigSaveLabel } from "@/lib/channel-settings-actions";
import { flushModelConfig, getModelConfigPersistenceState, subscribeModelConfigPersistence } from "@/services/model-config-repository";
import { listLocalComfyRecipes } from "@/services/api/local-comfy";
import { localComfyCanvasPath } from "@/pages/local-comfy/context";

type DefaultModelKey = "imageModel" | "videoModel" | "textModel" | "audioModel";

const groups: Array<{
    capability: ModelCapability;
    modelKey: DefaultModelKey;
    title: string;
    description: string;
    icon: typeof Image;
}> = [
    { capability: "image", modelKey: "imageModel", title: "默认生图模型", description: "图片生成、图像编辑与视觉探索", icon: Image },
    { capability: "video", modelKey: "videoModel", title: "默认视频模型", description: "文生视频、图生视频与镜头延展", icon: Film },
    { capability: "text", modelKey: "textModel", title: "默认文本模型", description: "提示词改写、脚本与结构化文本", icon: MessageSquareText },
    { capability: "audio", modelKey: "audioModel", title: "默认音频模型", description: "语音、音效与音乐生成", icon: AudioLines },
];

export function ModelDefaultGrid({ config, onChange, onOpenChannels, onLocalDefaultsChange }: { config: AiConfig; onChange: (key: DefaultModelKey, model: string) => void; onOpenChannels?: () => void; onLocalDefaultsChange?: (defaults: LocalComfyDefaults) => void }) {
    const localMode = workspaceCapabilities().local;
    return (
        <div className="space-y-1">
            {localMode && onLocalDefaultsChange ? <LocalWorkflowDefaults defaults={config.localComfyDefaults} onChange={onLocalDefaultsChange} /> : null}
            {groups.map((group) => {
                const models = filterModelsByCapability(config.models, group.capability, config.channels);
                const Icon = group.icon;
                return (
                    <section key={group.capability} className="py-5 first:pt-0 last:pb-0" aria-labelledby={`default-${group.capability}-title`}>
                        <div className="mb-3 flex items-center gap-3">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-active text-foreground/65"><Icon className="size-4" /></span>
                            <div className="min-w-0">
                                <h3 id={`default-${group.capability}-title`} className="text-sm font-semibold">{group.title}</h3>
                            </div>
                        </div>
                        {models.length ? (
                            <div role="radiogroup" aria-label={group.title} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {models.map((model) => {
                                    const channel = resolveModelChannel(config, model);
                                    const selected = config[group.modelKey] === model;
                                    return (
                                        <button
                                            key={model}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            className={cn(
                                                "model-default-option group relative overflow-hidden rounded-md px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                                                selected && "is-selected",
                                            )}
                                            onClick={() => onChange(group.modelKey, model)}
                                        >
                                            <span className="flex min-w-0 items-start gap-2.5">
                                                <span className="model-default-option-icon grid size-8 shrink-0 place-items-center rounded-md">
                                                    <ModelIcon config={config} model={model} />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-xs font-semibold">{modelDisplayName(config, model)}</span>
                                                    <span className="mt-1 block max-w-full truncate text-[var(--fs-tiny)] text-foreground/45">{channel.name || "未命名渠道"}</span>
                                                </span>
                                                <span className={cn("model-default-option-check grid size-5 shrink-0 place-items-center rounded-full", selected ? "is-selected" : "text-transparent")}>
                                                    <Check className="size-3" strokeWidth={2.5} />
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="px-1 py-3 text-xs text-foreground/45">
                                <p>{localMode ? `尚未配置${capabilityLabel(group.capability)}模型` : `暂无${capabilityLabel(group.capability)}模型`}</p>
                                {localMode && onOpenChannels ? <Button type="link" size="small" className="mt-1 h-auto p-0 text-xs" onClick={onOpenChannels}>前往添加本地模型渠道</Button> : null}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

function LocalWorkflowDefaults({ defaults, onChange }: { defaults: LocalComfyDefaults | undefined; onChange: (defaults: LocalComfyDefaults) => void }) {
    const { message } = App.useApp();
    const [saveState, setSaveState] = useState(getModelConfigPersistenceState);
    const [saving, setSaving] = useState(false);
    useEffect(() => { const unsubscribe = subscribeModelConfigPersistence(setSaveState); return () => { unsubscribe(); }; }, []);
    const catalog = useQuery({ queryKey: ["local-comfy", "default-recipes"], queryFn: ({ signal }) => listLocalComfyRecipes(signal), retry: false, staleTime: 30_000 });
    const saved = normalizeLocalComfyDefaults(defaults);
    const recipes = catalog.data || [];
    const catalogUsable = catalog.isSuccess && !catalog.isFetching;
    const seedInvalid = (["image", "video"] as const).some((mode) => saved[mode] && localComfySeedProblem(saved[mode]!.seed));
    const save = async () => {
        setSaving(true);
        try { await awaitModelConfigSaved(flushModelConfig, getModelConfigPersistenceState); message.success("本地默认配方已保存，打开工作台后可核对并手动生成"); }
        catch { message.error("本地默认配方尚未保存，请重试保存"); }
        finally { setSaving(false); }
    };
    return <section className="space-y-4 border-b border-foreground/10 py-5" aria-labelledby="local-workflow-defaults-title">
        <div className="space-y-1"><h3 id="local-workflow-defaults-title" className="text-sm font-semibold">本地工作流默认配方</h3><p className="text-xs leading-5 text-foreground/65">本地工作流入口会读取这些配方与种子；打开工作台核对镜头和参考图后，手动提交。原生任务中心的统一调度尚未接入。</p></div>
        {catalog.isPending ? <p role="status" className="text-sm text-foreground/65">正在读取已登记配方…</p> : null}
        {catalog.isError ? <Alert type="error" title="配方读取失败" description="已保存的默认值保留，请重试读取后核对是否可用。" action={<Button size="small" loading={catalog.isFetching} onClick={() => void catalog.refetch()}>重试读取</Button>} /> : null}
        <div className="grid gap-4 lg:grid-cols-2">{(["image", "video"] as LocalComfyMode[]).map((mode) => {
            const selection = saved[mode];
            const filtered = recipes.filter((recipe) => localComfyRecipeMode(recipe) === mode);
            const known = filtered.some((recipe) => recipe.id === selection?.recipeId);
            const options = filtered.map((recipe) => ({ value: recipe.id, label: `${recipe.name} · ${recipe.mode}${recipe.id === "qwen_image_2_1" || recipe.id === "h3_i2v_turbo4" ? " · 推荐固定配方" : ""}${recipe.ready ? "" : "（未就绪）"}`, disabled: !recipe.ready }));
            if (selection && !known) options.unshift({ value: selection.recipeId, label: `${selection.recipeId}（当前未登记或用途不符）`, disabled: true });
            const problem = catalogUsable ? localComfyDefaultProblem(selection, recipes, mode) : "当前无法核验配方，请等待读取完成或重试读取";
            const seedProblem = selection ? localComfySeedProblem(selection.seed) : "";
            return <div key={mode} className="space-y-2">
                <label htmlFor={`local-default-${mode}`} className="block text-sm">默认本地{mode === "image" ? "图片" : "视频"}配方</label>
                <Select id={`local-default-${mode}`} className="w-full" value={selection?.recipeId} options={options} placeholder="未配置，选择已登记配方" disabled={!catalogUsable || saving} allowClear aria-invalid={Boolean(catalogUsable && problem && selection)} aria-describedby={`local-default-${mode}-status`} onChange={(recipeId: string | undefined) => {
                    const next = { ...saved };
                    if (recipeId) next[mode] = { recipeId, seed: selection?.seed ?? "0" }; else delete next[mode];
                    onChange(next);
                }} />
                <p id={`local-default-${mode}-status`} role="status" className="text-xs leading-5 text-foreground/65">{problem || (selection ? "已登记配方；登记状态不代表模型或 GPU 生成已验收。" : "未配置本地默认配方")}</p>
                <label htmlFor={`local-default-${mode}-seed`} className="block text-xs">默认种子（0–4294967295）</label>
                <Input id={`local-default-${mode}-seed`} inputMode="numeric" value={selection?.seed ?? "0"} disabled={!selection || saving} aria-invalid={Boolean(seedProblem)} aria-describedby={seedProblem ? `local-default-${mode}-seed-error` : undefined} onChange={(event) => selection && onChange({ ...saved, [mode]: { ...selection, seed: event.target.value } })} />
                {seedProblem ? <p id={`local-default-${mode}-seed-error`} role="status" className="text-xs text-foreground/65">{seedProblem}</p> : null}
                <Link to={localComfyCanvasPath({ projectId: "", mode })} className="inline-block text-xs underline underline-offset-4">打开本地{mode === "image" ? "图片" : "视频"}工作流</Link>
            </div>;
        })}</div>
        <div className="flex flex-wrap items-center gap-3"><span role="status" className="text-xs text-foreground/65">{modelConfigSaveLabel(saveState)}</span><Button size="small" disabled={seedInvalid} loading={saving || saveState.status === "saving"} onClick={() => void save()}>{saveState.status === "error" ? "重试保存默认配方" : "保存默认配方"}</Button></div>
        <p className="text-xs text-foreground/65">下方渠道默认模型用于原生生成按钮，可独立配置；本地工作流不需要新增云渠道或 API Key。</p>
    </section>;
}

function capabilityLabel(capability: ModelCapability) {
    return { image: "图片", video: "视频", text: "文本", audio: "音频" }[capability];
}

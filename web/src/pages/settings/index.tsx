import { App, Button } from "antd";
import { ArrowLeft, RadioTower } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { isBuiltinBeefAPIChannel, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { awaitModelConfigSaved } from "@/lib/channel-settings-actions";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { useUserStore } from "@/stores/use-user-store";
import { ChannelSettingsPane, channelValidationError, focusInvalidChannelField, isChannelReady } from "./channel-settings-pane";
import { ModelDefaultGrid } from "./model-default-grid";
import { LocalComfySettingsPane } from "./local-comfy-settings-pane";

type ConfigSectionKey = "channels" | "models";

const configSections: Array<{ key: ConfigSectionKey; label: string; description: string; icon: ReactNode }> = [
    { key: "channels", label: "个人渠道", description: "模型服务与个人工作流", icon: <RadioTower className="size-4" /> },
];

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return configSections.some((section) => section.key === value);
}

export default function SettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedSection = searchParams.get("section");
    const customChannelsEnabled = useUserStore((state) => state.features.customChannelsEnabled);
    const initialSection = isConfigSection(requestedSection) ? requestedSection : "channels";
    const [activeTab, setActiveTab] = useState<ConfigSectionKey>(initialSection === "models" ? "channels" : initialSection);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = searchParams.get("continue") === "1";
    const [savingReturn, setSavingReturn] = useState(false);
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    const visibleConfigSections = useMemo(() => customChannelsEnabled ? configSections : configSections.filter((section) => section.key !== "channels"), [customChannelsEnabled]);

    const isVisibleConfigSection = (value: string | null): value is ConfigSectionKey => isConfigSection(value) && visibleConfigSections.some((section) => section.key === value);

    useLayoutEffect(() => {
        document.body.classList.add("app-user-overlays");
        return () => document.body.classList.remove("app-user-overlays");
    }, []);

    useEffect(() => {
        if (isVisibleConfigSection(requestedSection)) {
            setActiveTab(requestedSection);
            return;
        }
        setActiveTab((current) => visibleConfigSections.some((section) => section.key === current) ? current : "channels");
    }, [customChannelsEnabled, requestedSection, visibleConfigSections]);

    const selectSection = (section: ConfigSectionKey) => {
        setActiveTab(section);
        const next = new URLSearchParams(searchParams);
        next.set("section", section);
        setSearchParams(next, { replace: true });
    };

    const returnToCreation = async (requireReady: boolean) => {
        if (savingReturn) return;
        if (requireReady && !effectiveConfig.channels.some((channel) => channel.enabled !== false && isChannelReady(channel))) {
            selectSection("channels");
            const invalidChannel = userChannels.find((channel) => !isBuiltinBeefAPIChannel(channel) && channelValidationError(channel));
            message.error(customChannelsEnabled ? (invalidChannel ? `${invalidChannel.name || "未命名渠道"}：${channelValidationError(invalidChannel)}。请点击该渠道的“编辑”完成配置，或配置其他渠道。` : "请完成至少一个渠道的连接信息和模型配置；其他未完成草稿可继续保留。") : "当前没有可用的系统模型，请联系管理员配置系统渠道");
            if (invalidChannel) focusInvalidChannelField(invalidChannel);
            return;
        }
        setSavingReturn(true);
        try {
            await awaitModelConfigSaved(flushModelConfig, getModelConfigPersistenceState);
            message.success("配置已保存到本地工作区，正在返回创作页面");
            navigate(-1);
        } catch {
            message.error("配置尚未保存，编辑内容已保留。请重试保存后再返回创作。");
        } finally {
            setSavingReturn(false);
        }
    };

    const panes: Record<ConfigSectionKey, ReactNode> = {
        channels: (
            <SettingsPane>
                <LocalComfySettingsPane />
                <ChannelSettingsPane />
                <div className="settings-section mt-4">
                    <div className="settings-pane-header">
                        <div className="min-w-0">
                            <h2>模型选择</h2>
                        </div>
                    </div>
                    <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} />
                </div>
            </SettingsPane>
        ),
        models: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>模型选择</h2>
                        <p>按领域选择默认模型；模型能力与请求协议在渠道“模型与能力”中配置。</p>
                    </div>
                </div>
                <div className="settings-section">
                            <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} onOpenChannels={customChannelsEnabled ? () => selectSection("channels") : undefined} />
                </div>
            </SettingsPane>
        ),
    };

    return (
        <main className="settings-page app-workspace-page app-user-workspace flex h-full min-h-0 flex-col text-foreground">
            {shouldPromptContinue ? (
                <div className="settings-topbar shrink-0">
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        <Button icon={<ArrowLeft className="size-4" />} disabled={savingReturn} onClick={() => void returnToCreation(false)}>返回创作</Button>
                        <Button type="primary" loading={savingReturn} onClick={() => void returnToCreation(true)}>保存并返回</Button>
                    </div>
                </div>
            ) : null}
            <div className="settings-library-frame flex min-h-0 flex-1 flex-col md:flex-row">
                <section className="settings-content flex min-h-0 min-w-0 flex-1 flex-col" inert={savingReturn}>
                    <div className="app-workspace-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6 md:py-5">
                        <div className="settings-pane-root mx-auto w-full max-w-none">
                            {panes[activeTab]}
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}

function SettingsPane({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
    return <div className={fill ? "settings-pane h-full" : "settings-pane"}>{children}</div>;
}

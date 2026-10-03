import { useState, useSyncExternalStore } from "react";
import { App, Button } from "antd";

import { awaitModelConfigSaved, modelConfigSaveLabel } from "@/lib/channel-settings-actions";
import { flushModelConfig, getModelConfigPersistenceState, subscribeModelConfigPersistence } from "@/services/model-config-repository";

export function ModelConfigSaveFeedback() {
    const { message } = App.useApp();
    const state = useSyncExternalStore(subscribeModelConfigPersistence, getModelConfigPersistenceState, getModelConfigPersistenceState);
    const [retrying, setRetrying] = useState(false);
    const retry = async () => {
        if (retrying) return;
        setRetrying(true);
        try {
            await awaitModelConfigSaved(flushModelConfig, getModelConfigPersistenceState);
        } catch {
            message.error("保存失败，编辑内容已保留，请重试保存。");
        } finally {
            setRetrying(false);
        }
    };

    return <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/50">
        <span role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "text-destructive" : undefined}>{modelConfigSaveLabel(state)}</span>
        {state.status === "error" ? <Button size="small" loading={retrying} onClick={() => void retry()}>重试保存</Button> : null}
    </div>;
}

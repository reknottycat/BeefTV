import { useState, useSyncExternalStore } from "react";
import { Button } from "antd";
import { flushModelConfig, getModelConfigPersistenceState, subscribeModelConfigPersistence } from "@/services/model-config-repository";

export function ModelConfigSaveFeedback() {
    const state = useSyncExternalStore(subscribeModelConfigPersistence, getModelConfigPersistenceState, getModelConfigPersistenceState);
    const [retrying, setRetrying] = useState(false);
    const label = state.status === "error" ? "保存失败，当前选择已保留；请重试保存" : state.status === "hydrating" ? "正在读取已保存配置" : state.status === "saving" ? "保存中" : state.dirty ? "待保存" : state.status === "saved" ? "已保存到本地工作区" : "";
    return <div className="flex min-h-6 flex-wrap items-center gap-2 text-xs text-foreground/60">
        <span role={state.status === "error" ? "alert" : "status"}>{label}</span>
        {state.status === "error" ? <Button size="small" loading={retrying} onClick={() => {
            if (retrying) return;
            setRetrying(true);
            void flushModelConfig().finally(() => setRetrying(false));
        }}>重试保存</Button> : null}
    </div>;
}

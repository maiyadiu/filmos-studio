import { App, Select } from "antd";
import type { GenerationTaskKind } from "@filmos/generation-contracts";
import { useEffect } from "react";

import { useBrainGenerationRoutingStore } from "@/stores/use-brain-generation-routing-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { ModelDefaultGrid } from "./model-default-grid";

const tasks: Array<{ id: GenerationTaskKind; label: string }> = [
    { id: "text_to_image", label: "文生图" },
    { id: "reference_to_image", label: "参考生图" },
    { id: "image_to_video", label: "图生视频" },
    { id: "first_last_frame_video", label: "首尾帧视频" },
    { id: "audio", label: "音频" },
    { id: "workflow", label: "工作流" },
];

const engines = [
    { value: "dreamina_cli|dreamina-local", label: "Dreamina CLI" },
    { value: "flova_cli|flova-local", label: "Flova CLI（F0 未验证）", disabled: true },
    { value: "runninghub|runninghub-default", label: "RunningHub" },
    { value: "comfyui|comfyui-default", label: "ComfyUI" },
    { value: "manual_web|manual", label: "Manual Web" },
];

export function ModelRouteSettingsPane() {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const routing = useBrainGenerationRoutingStore((state) => state.config);
    const status = useBrainGenerationRoutingStore((state) => state.status);
    const initialize = useBrainGenerationRoutingStore((state) => state.initialize);
    const setGenerationDefault = useBrainGenerationRoutingStore((state) => state.setGenerationDefault);
    useEffect(() => { void initialize(effectiveConfig); }, [effectiveConfig, initialize]);

    return (
        <>
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>模型与默认路由</h2>
                    <p>普通文本/音频模型沿用现有选择；媒体任务按 Task Kind 选择生成引擎。节点内显式选择优先。</p>
                </div>
            </div>
            <div className="settings-section space-y-6">
                <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} />
                <section className="settings-preference-block p-4">
                    <h3 className="text-sm font-semibold">生成任务默认路由</h3>
                    <p className="mt-1 text-xs text-foreground/55">这里只保存 Engine/Connection ID；正式提交仍需精确 Descriptor Receipt、Catalog Validation 和确认。</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {tasks.map((task) => {
                            const current = routing?.generationDefaults[task.id];
                            const value = current ? `${current.engineId}|${current.connectionId}` : undefined;
                            return (
                                <label key={task.id} className="space-y-1.5 text-xs text-foreground/65">
                                    <span>{task.label}</span>
                                    <Select
                                        className="w-full"
                                        value={value}
                                        placeholder="未设置"
                                        options={engines}
                                        disabled={status !== "ready"}
                                        onChange={(selection) => {
                                            const [engineId, connectionId] = selection.split("|");
                                            void setGenerationDefault(task.id, { engineId, connectionId }).catch((cause) => message.error(cause instanceof Error ? cause.message : "保存失败"));
                                        }}
                                    />
                                </label>
                            );
                        })}
                    </div>
                </section>
            </div>
        </>
    );
}

import { App, Select } from "antd";
import type { GenerationTaskKind } from "@filmos/generation-contracts";
import { useEffect } from "react";
import { useMemo, useState } from "react";

import { useBrainGenerationRoutingStore } from "@/stores/use-brain-generation-routing-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { ModelDefaultGrid } from "./model-default-grid";
import { buildRuntimeGenerationDescriptorOptions, routableGenerationEngineOptions } from "@/film/generation-routing/runtime-catalog";
import { useLocalDreaminaModelStore } from "@/stores/use-local-dreamina-model-store";

const tasks: Array<{ id: GenerationTaskKind; label: string }> = [
    { id: "text_to_image", label: "文生图" },
    { id: "reference_to_image", label: "参考生图" },
    { id: "image_to_video", label: "图生视频" },
    { id: "first_last_frame_video", label: "首尾帧视频" },
    { id: "audio", label: "音频" },
    { id: "workflow", label: "工作流" },
];

export function ModelRouteSettingsPane() {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const routing = useBrainGenerationRoutingStore((state) => state.config);
    const status = useBrainGenerationRoutingStore((state) => state.status);
    const initialize = useBrainGenerationRoutingStore((state) => state.initialize);
    const setGenerationDefault = useBrainGenerationRoutingStore((state) => state.setGenerationDefault);
    const dreaminaModels = useLocalDreaminaModelStore((state) => state.models);
    const [pendingEngines, setPendingEngines] = useState<Partial<Record<GenerationTaskKind, string>>>({});
    const engineOptions = useMemo(() => routableGenerationEngineOptions(routing?.engineConnections || []), [routing?.engineConnections]);
    const descriptors = useMemo(() => buildRuntimeGenerationDescriptorOptions({ dreaminaModels, runningHubWorkflows: effectiveConfig.runningHub.workflows, comfyWorkflows: effectiveConfig.comfyBridge.workflows }), [dreaminaModels, effectiveConfig.comfyBridge.workflows, effectiveConfig.runningHub.workflows]);
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
                    <p className="mt-1 text-xs text-foreground/55">默认路由同时保存 Engine、Connection 与精确 Model / Workflow / Skill；不可路由连接不会进入列表。</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {tasks.map((task) => {
                            const current = routing?.generationDefaults[task.id];
                            const value = pendingEngines[task.id] || (current ? `${current.engineId}|${current.connectionId}` : undefined);
                            const [engineId, connectionId] = value?.split("|") || [];
                            const descriptorOptions = descriptors.filter((item) => item.engineId === engineId && item.connectionId === connectionId && (item.capability === (task.id.includes("video") ? "video" : task.id === "audio" ? "audio" : task.id === "workflow" ? "workflow" : "image") || item.engineId === "manual_web"));
                            const descriptorValue = current?.modelId ? `model|${current.modelId}` : current?.workflowId ? `workflow|${current.workflowId}` : current?.skillId ? `skill|${current.skillId}` : undefined;
                            return (
                                <label key={task.id} className="space-y-1.5 text-xs text-foreground/65">
                                    <span>{task.label}</span>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <Select className="w-full" aria-label={`${task.label}生成引擎`} value={value} placeholder="选择可用引擎" options={engineOptions.map((item) => ({ value: item.value, label: item.label }))} disabled={status !== "ready"} onChange={(selection) => setPendingEngines((currentPending) => ({ ...currentPending, [task.id]: selection }))} />
                                        <Select className="w-full" aria-label={`${task.label}精确描述符`} value={descriptorValue} placeholder={value ? "选择精确描述符" : "先选引擎"} disabled={!value || status !== "ready"} options={descriptorOptions.map((item) => ({ value: `${item.kind}|${item.id}`, label: item.label, disabled: item.disabled }))} onChange={(selection) => {
                                            const [kind, descriptorId] = selection.split("|");
                                            void setGenerationDefault(task.id, { engineId, connectionId, ...(kind === "model" ? { modelId: descriptorId } : kind === "workflow" ? { workflowId: descriptorId } : { skillId: descriptorId }) }).then(() => setPendingEngines((currentPending) => ({ ...currentPending, [task.id]: undefined }))).catch((cause) => message.error(cause instanceof Error ? cause.message : "保存失败"));
                                        }} />
                                    </div>
                                </label>
                            );
                        })}
                    </div>
                </section>
            </div>
        </>
    );
}

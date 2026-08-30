import { App, Alert, Select, Switch, Tag } from "antd";
import type { UserSelectableBrainProfileId } from "@filmos/generation-contracts";
import { useEffect } from "react";

import { BRAIN_PROFILE_PRESENTATIONS } from "@/film/agent/brain-profiles";
import { useBrainGenerationRoutingStore } from "@/stores/use-brain-generation-routing-store";
import { useEffectiveConfig } from "@/stores/use-config-store";

const apiProfiles = new Set<UserSelectableBrainProfileId>(["openai.api", "anthropic.api", "deepseek.api", "local.model"]);

export function BrainSettingsPane() {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const status = useBrainGenerationRoutingStore((state) => state.status);
    const routing = useBrainGenerationRoutingStore((state) => state.config);
    const error = useBrainGenerationRoutingStore((state) => state.error);
    const initialize = useBrainGenerationRoutingStore((state) => state.initialize);
    const updateBinding = useBrainGenerationRoutingStore((state) => state.updateBinding);
    const setGlobalDefault = useBrainGenerationRoutingStore((state) => state.setGlobalDefault);

    useEffect(() => { void initialize(effectiveConfig); }, [effectiveConfig, initialize]);

    const mutate = async (run: () => Promise<void>) => {
        try { await run(); } catch (cause) { message.error(cause instanceof Error ? cause.message : "保存失败"); }
    };

    return (
        <>
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>AI 大脑</h2>
                    <p>选择负责推理与工具调用的大脑。生成图片和视频请在“生成引擎”中配置。</p>
                </div>
            </div>
            <div className="settings-section space-y-4">
                <Alert
                    type={status === "unavailable" || status === "error" ? "warning" : "success"}
                    showIcon
                    message={status === "ready" || status === "saving" ? "本地配置已由 FilmOS 数据目录管理" : "当前仅显示内存投影"}
                    description={status === "unavailable" ? `请使用 FilmOS Studio 桌面版保存配置。${error ? ` ${error}` : ""}` : "无需 FilmOS 登录；Secret 仍由 Keychain、CLI 或既有渠道安全边界管理。"}
                />
                <div className="grid gap-3 xl:grid-cols-2">
                    {BRAIN_PROFILE_PRESENTATIONS.map((profile) => {
                        const binding = routing?.bindings.find((item) => item.profileId === profile.id);
                        const channel = effectiveConfig.channels.find((item) => item.id === binding?.channelId);
                        const exactRequired = apiProfiles.has(profile.id);
                        const ready = Boolean(binding?.enabled && (!exactRequired || (binding.channelId && binding.modelId)));
                        return (
                            <section key={profile.id} className="settings-preference-block p-4" data-brain-profile-id={profile.id}>
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="text-sm font-semibold">{profile.label}</h3>
                                            <Tag color={profile.billing === "API 计费" ? "orange" : profile.billing === "本地" ? "green" : "blue"}>{profile.billing}</Tag>
                                            <Tag>{ready ? "已配置" : "待配置"}</Tag>
                                        </div>
                                        <p className="mt-1 text-xs text-foreground/55">{profile.detail} · 禁止 API 静默兜底</p>
                                    </div>
                                    <Switch checked={binding?.enabled === true} disabled={!binding || status === "saving"} onChange={(enabled) => void mutate(() => updateBinding(profile.id, { enabled }))} />
                                </div>
                                {exactRequired ? (
                                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                        <label className="space-y-1.5 text-xs text-foreground/65">
                                            <span>精确渠道</span>
                                            <Select
                                                className="w-full"
                                                value={binding?.channelId}
                                                placeholder="选择 Channel ID"
                                                options={effectiveConfig.channels.filter((item) => item.enabled !== false).map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))}
                                                onChange={(channelId) => void mutate(() => updateBinding(profile.id, { channelId, modelId: undefined }))}
                                            />
                                        </label>
                                        <label className="space-y-1.5 text-xs text-foreground/65">
                                            <span>精确模型</span>
                                            <Select
                                                className="w-full"
                                                value={binding?.modelId}
                                                disabled={!channel}
                                                placeholder="选择 Model ID"
                                                options={(channel?.models || []).map((modelId) => ({ value: modelId, label: modelId }))}
                                                onChange={(modelId) => void mutate(() => updateBinding(profile.id, { modelId }))}
                                            />
                                        </label>
                                    </div>
                                ) : null}
                                <label className="mt-4 flex items-center justify-between gap-3 text-xs text-foreground/65">
                                    <span>设为全局默认</span>
                                    <Switch checked={routing?.globalDefaultProfileId === profile.id} disabled={!ready || status === "saving"} onChange={(checked) => checked && void mutate(() => setGlobalDefault(profile.id))} />
                                </label>
                            </section>
                        );
                    })}
                </div>
                {routing?.migration.status === "SKIPPED_NEEDS_CONFIGURATION" ? (
                    <Alert type="info" showIcon message="旧配置中存在不可唯一映射项" description={`已保留旧数据且未猜测 Provider。请手动设置：${routing.migration.ambiguousProfileIds.join("、")}`} />
                ) : null}
            </div>
        </>
    );
}

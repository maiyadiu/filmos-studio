import { Alert, Tag } from "antd";
import { useEffect } from "react";

import { ComfyUIBridgeSettingsPane } from "./comfyui-bridge-settings-pane";
import { LocalCliSettings } from "./local-cli-settings";
import { RunningHubSettingsPane } from "./runninghub-settings-pane";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useBrainGenerationRoutingStore } from "@/stores/use-brain-generation-routing-store";
import type { GenerationEngineConnection } from "@filmos/generation-contracts";

const EMPTY_ENGINE_CONNECTIONS: readonly GenerationEngineConnection[] = [];

export type GenerationExternalGateState =
    | "PASS_AUTOMATED"
    | "READY_FOR_USER_SELECTION"
    | "READY_FOR_USER_AUTHORIZATION"
    | "PASS_REAL_EXTERNAL"
    | "BLOCKED_BY_VERIFIED_PROVIDER_CAPABILITY"
    | "FAIL";

export const FLOVA_EXTERNAL_GATE_STATES: ReadonlyArray<{ state: GenerationExternalGateState; label: string }> = [
    { state: "PASS_AUTOMATED", label: "Flova 尚未接入" },
    { state: "READY_FOR_USER_SELECTION", label: "Flova 待选择" },
    { state: "READY_FOR_USER_AUTHORIZATION", label: "Flova 待授权" },
    { state: "PASS_REAL_EXTERNAL", label: "Flova 可用" },
    { state: "BLOCKED_BY_VERIFIED_PROVIDER_CAPABILITY", label: "Flova 能力已验证但被上游阻断" },
];

export function generationEngineExternalGatePresentation(engineId: string): { state: GenerationExternalGateState; label: string; detail: string } | undefined {
    if (engineId !== "flova_cli") return undefined;
    return {
        state: "READY_FOR_USER_SELECTION",
        label: "Flova 待选择",
        detail: "F0/F1 真实只读能力核验已完成；必须先选择现有 Project，当前尚未发生外部写入。",
    };
}

export function GenerationEngineSettingsPane() {
    const effectiveConfig = useEffectiveConfig();
    const initialize = useBrainGenerationRoutingStore((state) => state.initialize);
    const connections = useBrainGenerationRoutingStore((state) => state.config?.engineConnections ?? EMPTY_ENGINE_CONNECTIONS);
    useEffect(() => { void initialize(effectiveConfig); }, [effectiveConfig, initialize]);
    const state = (engineId: string, fallback: string) => {
        const connection = connections.find((item) => item.engineId === engineId);
        return connection ? `${connection.status} · ${connection.connectionId}` : fallback;
    };
    return (
        <>
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>生成引擎</h2>
                    <p>管理实际生图、视频、音频和工作流执行器。它们与 AI 大脑分属不同领域。</p>
                </div>
            </div>
            <div className="settings-section space-y-5">
                <EngineHeader name="Dreamina CLI" transport="CLI" state={state("dreamina_cli", "复用本机 Runtime")} />
                <LocalCliSettings />
                <CatalogContractSummary />
                <EngineHeader name="Flova CLI" transport="Project CLI" state={generationEngineExternalGatePresentation("flova_cli")!.label} />
                <Alert
                    type="info"
                    showIcon
                    message="Flova：READY_FOR_USER_SELECTION"
                    description={generationEngineExternalGatePresentation("flova_cli")!.detail}
                />
                <FlovaStateClosure />
                <EngineHeader name="RunningHub" transport="Workflow API" state={state("runninghub", "复用现有单一配置")} />
                <RunningHubSettingsPane />
                <EngineHeader name="ComfyUI" transport="Bridge" state={state("comfyui", "复用现有 Bridge")} />
                <ComfyUIBridgeSettingsPane />
                <EngineHeader name="Manual Web" transport="Manual" state={state("manual_web", "可用")} />
                <Alert type="warning" showIcon message="人工网页模式" description="只导出生成包并等待人工导入结果，不保存 Cookie、不自动上传、不把人工结果直接标为 Approved。" />
            </div>
        </>
    );
}

function CatalogContractSummary() {
    return (
        <section aria-label="Dreamina Catalog 合同" className="rounded-md border border-border bg-background p-4 text-xs leading-6 text-foreground/65">
            <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm text-foreground">Dreamina Catalog</strong>
                <Tag>Runtime Discovery</Tag>
                <span>登录并发现目录后才允许精确选择 Model。</span>
            </div>
            <p className="mt-2"><strong>Catalog Evidence：</strong>绑定 Runtime Version、Source Locator、Observed At 与 Catalog Hash；目录未加载时不伪造模型。</p>
        </section>
    );
}

function FlovaStateClosure() {
    const current = generationEngineExternalGatePresentation("flova_cli")!;
    return (
        <section aria-label="Flova 外部状态闭包" className="rounded-md border border-border bg-background p-4">
            <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">Flova 外部状态闭包</strong>
                <Tag color="blue">当前：{current.label}</Tag>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                {FLOVA_EXTERNAL_GATE_STATES.map((item) => (
                    <Tag key={item.state} color={item.state === current.state ? "blue" : undefined}>{item.label}</Tag>
                ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-foreground/55">仅允许任务包定义的外部状态；用户未选择 Project 或未授权付费时不得标为失败。</p>
        </section>
    );
}

function EngineHeader({ name, transport, state }: { name: string; transport: string; state: string }) {
    return (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
            <h3 className="text-sm font-semibold">{name}</h3>
            <Tag>{transport}</Tag>
            <span className="text-xs text-foreground/55">{state}</span>
        </div>
    );
}

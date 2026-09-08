import { useEffect, useState } from "react";
import { Button, Select } from "antd";
import type { AgentSessionClient } from "@/film/agent/agent-client";
import type { CodexModelOption, CodexModelSelection, CodexModelReceipt } from "../../../../packages/filmos-agent-contracts/src/codex-models";

const effortNames: Record<string, string> = { none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超高" };
export const codexEffortLabel = (effort: string) => `${effortNames[effort] ?? effort} · ${effort}`;

export function CodexModelPicker({ client, value, onChange, receipt, disabled }: {
    client: AgentSessionClient; value: CodexModelSelection | null; onChange: (value: CodexModelSelection | null) => void;
    receipt: CodexModelReceipt | null; disabled: boolean;
}) {
    const [models, setModels] = useState<CodexModelOption[]>([]);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError(false); setModels([]);
        void client.listCodexModels(controller.signal).then(result => {
            if (!controller.signal.aborted) setModels(result.models);
        }).catch(() => { if (!controller.signal.aborted) setError(true); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [client, refresh]);
    const selected = models.find(model => model.model === value?.model);
    const invalid = Boolean(value && !loading && !error && !selected?.supportedReasoningEfforts.some(effort => effort.reasoningEffort === value.effort));
    return <div className="shrink-0 space-y-1 px-4 pb-2 text-[var(--fs-tiny)]" data-canvas-no-zoom>
        <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Codex 模型" size="small" className="min-w-0 flex-1" style={{ minWidth: 150 }} disabled={disabled || loading || error} loading={loading}
                value={value?.model ?? ""} options={[{ value: "", label: "沿用线程配置" }, ...models.map(model => ({ value: model.model, label: model.displayName }))]}
                onChange={modelId => { const model = models.find(item => item.model === modelId); onChange(model ? { model: model.model, effort: model.defaultReasoningEffort } : null); }} />
            <Select aria-label="Codex 思考强度" size="small" style={{ minWidth: 112 }} disabled={disabled || loading || !selected} value={value?.effort}
                placeholder="沿用" options={selected?.supportedReasoningEfforts.map(effort => ({ value: effort.reasoningEffort, label: codexEffortLabel(effort.reasoningEffort), title: effort.description }))}
                onChange={effort => { if (selected) onChange({ model: selected.model, effort }); }} />
            <Button size="small" disabled={disabled || loading} onClick={() => setRefresh(value => value + 1)}>刷新目录</Button>
        </div>
        <div className="text-muted-foreground">下轮生效，不改全局设置；沿用不代表已知实际模型。</div>
        {error ? <div role="status">模型目录不可用，请检查原生 Runtime 版本/连接后刷新；不自动改走 API。</div> : invalid ? <div role="status">所选组合已不在当前目录，发送前须重新选择。</div> : null}
        {receipt ? <div className="break-words" title={`工作台轮次：${receipt.turnId}；原生轮次：${receipt.providerTurnId}`}>
            <div>本轮请求：{receipt.requested ? `${receipt.requested.model} / ${codexEffortLabel(receipt.requested.effort)}` : "沿用线程配置"}</div>
            <div>服务回报：{receipt.reported.model ?? "模型未知"} / {receipt.reported.effort ? codexEffortLabel(receipt.reported.effort) : "强度未知"}{receipt.source === "thread/read" ? "（启动后线程配置）" : "（未回报）"}</div>
        </div> : <div>本轮服务配置尚未回报。</div>}
    </div>;
}

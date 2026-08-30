import { Alert, Button } from "antd";
import { Clock3, ExternalLink, RefreshCw, Settings2, ShieldCheck, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createFilmChatGPTHandoffClient, resolveFilmChatGPTHandoffConfig } from "@/film/chatgpt/handoff-client";
import type { ChatGPTHandoffStatus } from "@/film/chatgpt/contracts";
import type { FilmOSDesktopChatGPTHostStatus } from "@/film/agent/workbench-context";
import { chatGPTHostReadiness } from "@/film/agent/chatgpt-host-readiness";
import type { CanvasTheme } from "@/lib/canvas-theme";

type HostedState = { state: "loading" } | { state: "ready"; status: ChatGPTHandoffStatus } | { state: "error"; message: string };

export function CanvasChatGPTHostedPanel({ theme, projectId }: { theme: CanvasTheme; projectId: string }) {
    const config = useMemo(() => resolveFilmChatGPTHandoffConfig(), []);
    const client = useMemo(() => createFilmChatGPTHandoffClient({ baseUrl: config.baseUrl, proposalHandoffEnabled: config.proposalHandoffEnabled }), [config.baseUrl, config.proposalHandoffEnabled]);
    const [state, setState] = useState<HostedState>({ state: "loading" });
    const [desktopStatus, setDesktopStatus] = useState<FilmOSDesktopChatGPTHostStatus | null>(() => window.filmOSChatGPTHostStatus ?? null);
    const [refresh, setRefresh] = useState(0);
    const context = typeof window === "undefined" ? null : window.filmOSGetWorkbenchContext?.() ?? null;
    const authorizedProjectId = context?.domainProjectId || "";

    useEffect(() => {
        const update = (event: Event) => setDesktopStatus((event as CustomEvent<FilmOSDesktopChatGPTHostStatus>).detail ?? window.filmOSChatGPTHostStatus ?? null);
        window.addEventListener("filmos:chatgpt-host-status", update);
        return () => window.removeEventListener("filmos:chatgpt-host-status", update);
    }, []);

    useEffect(() => {
        if (desktopStatus) {
            setState({ state: "loading" });
            return;
        }
        if (!config.enabled) {
            setState({ state: "error", message: "ChatGPT Host Feature Flag 尚未开启" });
            return;
        }
        if (!authorizedProjectId) {
            setState({ state: "error", message: "当前画布未绑定 Film Project，不会猜测授权项目" });
            return;
        }
        const controller = new AbortController();
        setState({ state: "loading" });
        void client.getStatus(authorizedProjectId, controller.signal)
            .then((status) => setState({ state: "ready", status }))
            .catch((error) => { if (!controller.signal.aborted) setState({ state: "error", message: error instanceof Error ? error.message : "ChatGPT Host 状态不可用" }); });
        return () => controller.abort();
    }, [authorizedProjectId, client, config.enabled, desktopStatus, refresh]);

    const openConnectionSettings = useCallback(() => {
        const handler = window.webkit?.messageHandlers?.filmosDesktop;
        if (handler) handler.postMessage({ action: "openChatGPTConnection" });
        else window.dispatchEvent(new CustomEvent("filmos:open-chatgpt-connection"));
    }, []);

    const status = state.state === "ready" ? state.status : null;
    const desktopProjectMatches = Boolean(desktopStatus?.authorizedProjectId && desktopStatus.authorizedProjectId === authorizedProjectId);
    const desktopReadiness = chatGPTHostReadiness(desktopStatus, authorizedProjectId);
    const hostConnected = desktopStatus ? desktopReadiness.externalConnected : status?.connection === "connected";
    const timeline = [
        { label: "当前上下文", detail: context ? `${context.title} · ${context.selectedNodeIds.length} 个选中节点` : projectId, done: Boolean(context) },
        { label: "Secure MCP / Grant", detail: desktopStatus ? (desktopProjectMatches && desktopStatus.grantExpiresAt ? `已授权至 ${formatTime(desktopStatus.grantExpiresAt)}` : "当前项目授权待轮换") : status?.authorized_project ? `已授权至 ${formatTime(status.authorized_project.expires_at)}` : status?.status_code || "等待连接", done: desktopStatus ? desktopProjectMatches : Boolean(status?.authorized_project) },
        { label: "ChatGPT 真实读取", detail: desktopStatus?.lastReadAt ? formatTime(desktopStatus.lastReadAt) : status?.last_read_at ? formatTime(status.last_read_at) : "尚无外部读取回执", done: desktopStatus ? hostConnected : Boolean(status?.last_read_at) },
        { label: "MCP 实际清单", detail: desktopStatus ? `${desktopStatus.mcpReadToolCount} 读 / ${desktopStatus.mcpWriteToolCount} 写 / ${desktopStatus.mcpPaidToolCount} 付费 / ${desktopStatus.mcpDestructiveToolCount} 破坏` : "等待本机 Manifest", done: Boolean(desktopStatus?.mcpToolCount) },
        { label: "Proposal / Review Draft", detail: (desktopStatus?.proposalHandoffEnabled || status?.proposal_handoff_enabled) ? "可导入签名提案并停在 Preview" : "当前只读，不直接 Apply", done: false },
    ];

    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4" data-agent-surface="host-handoff">
            <div className="rounded-lg p-4" style={{ background: theme.spatial.surface }}>
                <div className="flex items-start justify-between gap-3">
                    <div><h2 className="text-sm font-semibold">ChatGPT Host 协作</h2><p className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>ChatGPT 在官方 Host 中运行；FilmOS 只显示 Tunnel、Grant、读取回执和 Proposal 时间线，不伪造内嵌流式对话。</p></div>
                    {hostConnected ? <ShieldCheck className="size-5 text-emerald-600" /> : <Unplug className="size-5" style={{ color: theme.node.muted }} />}
                </div>
                {state.state === "error" && !desktopStatus ? <Alert className="mt-3" type="info" showIcon title="连接待就绪" description={state.message} /> : null}
                {desktopStatus && !desktopReadiness.handoffReady ? <Alert className="mt-3" type="warning" showIcon title="Host 尚未就绪" description={desktopReadiness.message} /> : null}
                {desktopStatus && !desktopProjectMatches ? <Alert className="mt-3" type="warning" showIcon title="项目授权待轮换" description="FilmOS 不会沿用旧项目 Grant；请等待当前项目 Host Session 建立。" /> : null}
                <div className="mt-4 space-y-2">
                    {timeline.map((item) => <div key={item.label} className="flex gap-3 rounded-md px-3 py-2.5" style={{ background: theme.node.fill }}><span className="mt-0.5">{item.done ? <ShieldCheck className="size-4 text-emerald-600" /> : <Clock3 className="size-4" style={{ color: theme.node.muted }} />}</span><div className="min-w-0"><div className="text-xs font-medium">{item.label}</div><div className="mt-0.5 truncate text-[var(--fs-tiny)]" style={{ color: theme.node.muted }} title={item.detail}>{item.detail}</div></div></div>)}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="small" icon={<Settings2 className="size-3.5" />} onClick={openConnectionSettings}>打开连接设置</Button>
                    <Button size="small" icon={<ExternalLink className="size-3.5" />} onClick={() => window.open("https://chatgpt.com/", "_blank", "noopener,noreferrer")}>打开 ChatGPT</Button>
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={!desktopStatus && state.state === "loading"} onClick={() => setRefresh((value) => value + 1)}>刷新回执</Button>
                </div>
            </div>
        </div>
    );
}

function formatTime(value: string) {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

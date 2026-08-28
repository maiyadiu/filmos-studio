import { Alert, Button, Modal } from "antd";
import { Bot, Clock3, ExternalLink, FileJson2, FileUp, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useState } from "react";

import { FILMOS_PROPOSAL_MAX_BYTES, type ChatGPTHandoffStatus, type ProposalPreviewReceipt } from "./contracts";

export type ChatGPTHandoffPanelState =
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "ready"; status: ChatGPTHandoffStatus };

export type ChatGPTHandoffPanelProps = {
    project: { id: string; name: string };
    state: ChatGPTHandoffPanelState;
    proposalHandoffEnabled: boolean;
    onRefresh(): void;
    onPreviewProposal(file: File): Promise<ProposalPreviewReceipt>;
    onRevoke(): Promise<void>;
    onOpenChatGPT(): void;
};

export function ChatGPTHandoffPanel({ project, state, proposalHandoffEnabled, onRefresh, onPreviewProposal, onRevoke, onOpenChatGPT }: ChatGPTHandoffPanelProps) {
    const [guideOpen, setGuideOpen] = useState(false);
    const [proposalOpen, setProposalOpen] = useState(false);
    const [proposalFile, setProposalFile] = useState<File | null>(null);
    const [proposalPending, setProposalPending] = useState(false);
    const [proposalError, setProposalError] = useState("");
    const [proposalReceipt, setProposalReceipt] = useState<ProposalPreviewReceipt | null>(null);
    const [revokePending, setRevokePending] = useState(false);
    const [revokeError, setRevokeError] = useState("");
    const status = state.state === "ready" ? state.status : null;
    const grant = status?.authorized_project ?? null;
    const importEnabled = proposalHandoffEnabled && status?.proposal_handoff_enabled === true && grant?.project_id === project.id;

    const previewProposal = async () => {
        if (!proposalFile) return;
        setProposalPending(true);
        setProposalError("");
        setProposalReceipt(null);
        try {
            setProposalReceipt(await onPreviewProposal(proposalFile));
        } catch (error) {
            setProposalError(error instanceof Error ? error.message : "Proposal 本地预览失败");
        } finally {
            setProposalPending(false);
        }
    };
    const revoke = async () => {
        setRevokePending(true);
        setRevokeError("");
        try {
            await onRevoke();
        } catch (error) {
            setRevokeError(error instanceof Error ? error.message : "Project Grant 撤销失败");
        } finally {
            setRevokePending(false);
        }
    };

    return (
        <section data-film-feature="chatgpt-handoff" aria-labelledby="film-chatgpt-handoff-title" className="rounded-lg border border-border/80 bg-background/55 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[var(--fs-tiny)] font-semibold text-foreground/40">
                        <Bot className="size-3.5" />
                        FilmOS 本地交接
                    </div>
                    <h2 id="film-chatgpt-handoff-title" className="mt-1 text-base font-semibold">ChatGPT Handoff</h2>
                    <p className="mt-1 text-xs leading-5 text-foreground/48">Codex 仍承担本机执行；此处只管理单项目短期授权、上下文回执与 Proposal Preview，不模拟 ChatGPT 订阅。</p>
                </div>
                <ConnectionBadge state={state} />
            </div>

            {state.state === "error" ? <Alert className="mt-3" type="warning" showIcon title="本机 ChatGPT 边界不可用" description={state.message} /> : null}
            {status?.status_code === "BLOCKED_EXTERNAL_ACCOUNT" ? <Alert className="mt-3" type="info" showIcon title="本机 MCP 已就绪，等待外部账户配置" description="Secure MCP Tunnel、ChatGPT Developer Mode 与 FilmOS App 尚无外部连接回执；本机服务不会回退成公开 localhost。" /> : null}
            {status?.connection === "disabled" ? <Alert className="mt-3" type="warning" showIcon title="本机 MCP 服务开关仍为关闭" description="Web 入口已开启，但 FilmOS ChatGPT MCP 本机边界未开启。" /> : null}

            <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <Fact label="ChatGPT 连接" value={state.state === "loading" ? "检查中" : status ? connectionLabel(status) : "未连接"} detail={status ? `${status.local_mcp_ready ? "本机 MCP 已就绪" : "本机 MCP 未就绪"} · ${status.status_code}` : "未形成连接回执"} />
                <Fact label="当前授权项目" value={grant ? grant.project_name || grant.project_id : "未授权"} detail={grant ? `${grant.project_id} · 至 ${formatTime(grant.expires_at)}` : `当前项目 ${project.name}`} />
                <Fact label="最近一次读取" value={status?.last_read_at ? formatTime(status.last_read_at) : "无回执"} detail="仅显示本机审计边界返回的时间" />
                <Fact label="Context Snapshot" value={status?.last_context_snapshot ? status.last_context_snapshot.version === null ? "已记录" : `v${status.last_context_snapshot.version}` : "尚未导出"} detail={snapshotDetail(status?.last_context_snapshot ?? null)} />
            </dl>

            <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                <Button size="small" icon={<FileJson2 className="size-3.5" />} onClick={() => setGuideOpen(true)}>导出与打开指引</Button>
                <Button size="small" icon={<FileUp className="size-3.5" />} disabled={!importEnabled} title={importEnabled ? "选择 .filmosproposal" : "Proposal Handoff 本地开关或回执未就绪"} onClick={() => { setProposalOpen(true); setProposalError(""); setProposalReceipt(null); }}>导入 ChatGPT Proposal</Button>
                <Button size="small" icon={<Unplug className="size-3.5" />} danger disabled={!grant} loading={revokePending} onClick={() => void revoke()}>撤销授权</Button>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={state.state === "loading"} onClick={onRefresh}>刷新回执</Button>
            </div>
            {revokeError ? <p role="alert" className="mt-2 text-xs text-red-600">{revokeError}；授权状态未在 Web 中改写。</p> : null}

            <Modal title="交接到 ChatGPT" open={guideOpen} onCancel={() => setGuideOpen(false)} footer={[
                <Button key="cancel" onClick={() => setGuideOpen(false)}>关闭</Button>,
                <Button key="open" type="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => { onOpenChatGPT(); setGuideOpen(false); }}>用户确认后打开 ChatGPT</Button>,
            ]}>
                <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-foreground/65">
                    <li>确认本页显示当前项目的有效 Project Grant 与未过期回执。</li>
                    <li>在 ChatGPT Developer Mode 中选择 FilmOS App；未配置 Secure MCP Tunnel 时不会读取 localhost。</li>
                    <li>请 ChatGPT 读取当前授权项目；Context Snapshot 以本机审计回执为准，不自动上传整个项目。</li>
                    <li>需回传时只导出签名 `.filmosproposal`；FilmOS 导入仅到 Proposal、Candidate 或 Review Draft Preview。</li>
                </ol>
            </Modal>

            <Modal title="导入 ChatGPT Proposal" open={proposalOpen} onCancel={() => { if (!proposalPending) setProposalOpen(false); }} okText="校验并生成 Preview" cancelText="取消" okButtonProps={{ disabled: !proposalFile || proposalPending }} confirmLoading={proposalPending} onOk={() => void previewProposal()}>
                <Alert type="warning" showIcon title="只生成本地 Preview" description="文件必须经本机边界验证签名、内容哈希、项目、过期时间、base state 与版本。本步不会生成 Approved、Locked 或 Formal Apply。" />
                <label className="mt-4 block rounded-md border border-dashed border-border bg-surface-active p-3 text-sm">
                    <span className="block font-medium">.filmosproposal 文件</span>
                    <span className="mt-1 block text-xs text-foreground/45">最大 {Math.round(FILMOS_PROPOSAL_MAX_BYTES / 1024)} KiB；Web 只做文件大小/JSON 预检，所有字段仍是不可信输入。</span>
                    <input className="mt-3 block w-full text-xs" type="file" accept=".filmosproposal,application/json" disabled={proposalPending} onChange={(event) => { const file = event.target.files?.[0] ?? null; setProposalFile(file); setProposalError(""); setProposalReceipt(null); }} />
                </label>
                {proposalError ? <p role="alert" className="mt-3 text-xs text-red-600">{proposalError}；没有应用任何项目变更。</p> : null}
                {proposalReceipt ? <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-5"><div className="flex items-center gap-2 font-medium text-emerald-700"><ShieldCheck className="size-4" />Film Core Preview 回执已验证</div><p className="mt-1 text-foreground/58">{proposalReceipt.preview.outputs.map((output) => output.kind).join(" / ")} · {proposalReceipt.preview.outputs.length} 个 DRAFT{proposalReceipt.untrusted_display_summary ? ` · 文件自述：${proposalReceipt.untrusted_display_summary}` : ""}</p><code className="mt-1 block break-all text-[var(--fs-micro)] text-foreground/42">{proposalReceipt.preview.proposal_id} · formal_write_executed=false · provider_task_created=false · deletion_executed=false</code></div> : null}
            </Modal>
        </section>
    );
}

function ConnectionBadge({ state }: { state: ChatGPTHandoffPanelState }) {
    const status = state.state === "ready" ? state.status : null;
    const connected = status?.connection === "connected" && status.external_account_connected && Boolean(status.authorized_project);
    const localReady = status?.local_mcp_ready === true;
    return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[var(--fs-tiny)] font-medium ${connected ? "bg-emerald-500/10 text-emerald-700" : "bg-foreground/[.055] text-foreground/48"}`}>{connected ? <ShieldCheck className="size-3" /> : state.state === "loading" ? <Clock3 className="size-3" /> : <Unplug className="size-3" />}{connected ? "外部已连接" : state.state === "loading" ? "检查中" : localReady ? "本机 MCP 已就绪" : "未连接"}</span>;
}

function Fact({ label, value, detail }: { label: string; value: string; detail: string }) {
    return <div className="min-w-0 rounded-md bg-surface-active px-3 py-2.5"><dt className="text-[var(--fs-tiny)] text-foreground/42">{label}</dt><dd className="mt-1 truncate text-sm font-semibold text-foreground/78" title={value}>{value}</dd><dd className="mt-0.5 truncate text-[var(--fs-micro)] text-foreground/38" title={detail}>{detail}</dd></div>;
}

function connectionLabel(status: ChatGPTHandoffStatus): string {
    if (status.connection === "connected" && status.authorized_project) return "已连接";
    if (status.connection === "disconnected" && status.local_mcp_ready) return "ChatGPT 外部未连接";
    if (status.connection === "disabled") return "本机服务已关闭";
    if (status.connection === "unavailable") return "本机服务不可用";
    return "未连接";
}

function formatTime(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function shortHash(value: string): string {
    return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function snapshotDetail(snapshot: ChatGPTHandoffStatus["last_context_snapshot"]): string {
    if (!snapshot) return "不从聊天记录推断";
    return [snapshot.uri, snapshot.state_hash ? shortHash(snapshot.state_hash) : null].filter(Boolean).join(" · ") || "本机审计回执未包含实体快照";
}

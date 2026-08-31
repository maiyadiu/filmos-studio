import { Alert, App, Button, Descriptions, Drawer, Empty, List, Space, Spin, Table, Tag, Typography } from "antd";
import { Cable, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { reviewCenterRequest } from "@/film/governance/report-issue";
import { AdminPageFrame } from "@/pages/admin/components/admin-shell";

type ReviewIssue = Record<string, any> & {
    issue_id: string;
    project_id: string;
    lane: string;
    state: string;
    current_round: number;
    updated_at: string;
};
type BridgeClient = { client_id: string; client_name: string; created_at: string; last_seen_at: string; revoked_at: string | null };

export default function ReviewCenterPage() {
    const { message } = App.useApp();
    const [issues, setIssues] = useState<ReviewIssue[]>([]);
    const [selected, setSelected] = useState<ReviewIssue | null>(null);
    const [clients, setClients] = useState<BridgeClient[]>([]);
    const [pairing, setPairing] = useState<{ pairing_code: string; expires_at: string } | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const [issueResult, clientResult] = await Promise.all([
                reviewCenterRequest<{ issues: ReviewIssue[] }>("list_issues"),
                reviewCenterRequest<{ clients: BridgeClient[] }>("list_bridge_clients"),
            ]);
            setIssues(issueResult.issues ?? []);
            setClients(clientResult.clients ?? []);
            if (selected) {
                const detail = await reviewCenterRequest<ReviewIssue>("get_issue", { issue_id: selected.issue_id });
                setSelected(detail);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "Review Center 读取失败");
        } finally { setLoading(false); }
    }, [message, selected?.issue_id]);

    useEffect(() => { void refresh(); }, []);

    const openIssue = async (issue: ReviewIssue) => {
        try { setSelected(await reviewCenterRequest<ReviewIssue>("get_issue", { issue_id: issue.issue_id })); }
        catch (error) { message.error(error instanceof Error ? error.message : "Issue 详情读取失败"); }
    };
    const createPairing = async () => {
        try { setPairing(await reviewCenterRequest<{ pairing_code: string; expires_at: string }>("create_pairing_code")); }
        catch (error) { message.error(error instanceof Error ? error.message : "配对码生成失败"); }
    };
    const revoke = async (clientId: string) => {
        try { await reviewCenterRequest("revoke_bridge_client", { client_id: clientId }); message.success("Chrome 客户端已撤销"); await refresh(); }
        catch (error) { message.error(error instanceof Error ? error.message : "撤销失败"); }
    };
    const severities = (issue: ReviewIssue) => ["P0", "P1", "P2"].map((severity) => `${severity} ${(issue.findings ?? []).filter((item: any) => item.severity === severity && item.status !== "CLOSED").length}`).join(" / ");

    const columns = useMemo(() => [
        { title: "Issue", dataIndex: "issue_id", render: (value: string, issue: ReviewIssue) => <Button type="link" className="!px-0" onClick={() => void openIssue(issue)}>{value}</Button> },
        { title: "项目", dataIndex: "project_id", ellipsis: true },
        { title: "通道", dataIndex: "lane", render: (value: string) => <Tag>{value}</Tag> },
        { title: "状态", dataIndex: "state", render: (value: string) => <Tag color={statusColor(value)}>{value}</Tag> },
        { title: "轮次", dataIndex: "current_round", width: 70 },
        { title: "Findings", render: (_: unknown, issue: ReviewIssue) => severities(issue) },
        { title: "Candidate", render: (_: unknown, issue: ReviewIssue) => issue.active_candidate?.candidate_id ?? "—" },
        { title: "双签", render: (_: unknown, issue: ReviewIssue) => issue.dual_signoff ? <Tag color="green">完成</Tag> : <Tag>未完成</Tag> },
        { title: "更新时间", dataIndex: "updated_at", render: (value: string) => value ? new Date(value).toLocaleString() : "—" },
    ], []);

    return (
        <AdminPageFrame title="Review Center" description="使用反馈、双专家共识、候选轮次、外部验收与 Pilot Gate 的统一事实入口" scroll actions={<Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>刷新</Button>}>
            <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <section className="rounded-lg border border-border bg-[var(--workspace-surface)] p-4">
                    <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Issue 队列</h2><Tag>{issues.length} 条</Tag></div>
                    <Spin spinning={loading}><Table rowKey="issue_id" size="small" columns={columns} dataSource={issues} pagination={{ pageSize: 12 }} scroll={{ x: 1120 }} locale={{ emptyText: <Empty description="尚无 Review Issue" /> }} /></Spin>
                </section>
                <section className="rounded-lg border border-border bg-[var(--workspace-surface)] p-4">
                    <div className="mb-3 flex items-center gap-2"><Cable className="size-4" /><h2 className="font-semibold">Chrome 一次性配对</h2></div>
                    <p className="mb-3 text-xs leading-5 text-foreground/55">在扩展中输入6位码。配对码5分钟有效且只能使用一次；FilmOS 不显示或复制长期 Bridge Token。</p>
                    <Button type="primary" className="w-full" onClick={() => void createPairing()}>生成6位配对码</Button>
                    {pairing ? <div className="my-3 rounded-lg border border-border bg-muted/35 p-4 text-center"><div className="font-mono text-3xl font-semibold tracking-[0.3em]">{pairing.pairing_code}</div><div className="mt-2 text-xs text-foreground/50">有效至 {new Date(pairing.expires_at).toLocaleTimeString()}</div></div> : null}
                    <List className="mt-3" size="small" dataSource={clients} locale={{ emptyText: "暂无已配对客户端" }} renderItem={(client) => <List.Item actions={!client.revoked_at ? [<Button key="revoke" danger type="text" size="small" icon={<Unplug className="size-3.5" />} onClick={() => void revoke(client.client_id)}>撤销</Button>] : []}><List.Item.Meta title={<span className="text-sm">{client.client_name} {client.revoked_at ? <Tag>已撤销</Tag> : <Tag color="green">已连接</Tag>}</span>} description={`最近连接：${new Date(client.last_seen_at).toLocaleString()}`} /></List.Item>} />
                </section>
            </div>
            <Drawer title={selected?.issue_id} width="min(860px, 92vw)" open={Boolean(selected)} onClose={() => setSelected(null)} destroyOnHidden>
                {selected ? <IssueDetail issue={selected} /> : null}
            </Drawer>
        </AdminPageFrame>
    );
}

function IssueDetail({ issue }: { issue: ReviewIssue }) {
    const evidence = issue.evidence?.manifest;
    const candidate = issue.active_candidate;
    const findings = issue.findings ?? [];
    return <div className="space-y-5">
        {issue.state === "OWNER_DECISION_REQUIRED" ? <Alert type="warning" showIcon message="需要项目所有者决策" description="Codex 自动协调已硬停止。请先处理范围扩张、第三轮 P0 或架构选项，再继续候选流程。" /> : null}
        <Section title="使用现场"><Descriptions size="small" column={2} items={[
            { key: "project", label: "项目", children: issue.project_id },
            { key: "lane", label: "Lane", children: <Tag>{issue.lane}</Tag> },
            { key: "state", label: "状态", children: <Tag color={statusColor(issue.state)}>{issue.state}</Tag> },
            { key: "round", label: "Round", children: issue.current_round },
            { key: "happened", label: "发生了什么", span: 2, children: issue.report?.what_happened ?? "—" },
            { key: "expected", label: "期望结果", span: 2, children: issue.report?.expected_result ?? "—" },
        ]} /></Section>
        <Section title="Evidence 完整度"><Space wrap>{Object.entries(evidence?.completeness ?? {}).map(([key, value]) => <Tag key={key} color={value ? "green" : "red"}>{key}: {value ? "PASS" : "缺失"}</Tag>)}</Space><p className="mt-2 text-xs text-foreground/50">Manifest {evidence?.contentHash ?? "未冻结"} · 附件 {issue.attachments?.length ?? 0}</p></Section>
        <Section title="Codex Local Assessment"><ReadableObject value={issue.assessments?.codex} empty="等待 Codex" /></Section>
        <Section title="ChatGPT External Assessment"><ReadableObject value={issue.assessments?.chatgpt} empty="等待 ChatGPT 独立提交" /></Section>
        <Section title="Consensus"><ReadableObject value={{ delta: issue.consensus_delta, proposal: issue.consensus_proposal, record: issue.consensus_record }} empty="尚未形成共识" /></Section>
        <Section title="Findings 与 Codex Responses"><List size="small" dataSource={findings} locale={{ emptyText: "暂无 Finding" }} renderItem={(finding: any) => <List.Item><List.Item.Meta title={<Space><Tag color={finding.severity === "P0" ? "red" : finding.severity === "P1" ? "orange" : "blue"}>{finding.severity}</Tag><span>{finding.title}</span><Tag>{finding.status}</Tag></Space>} description={<div className="space-y-1"><p>{finding.problem}</p><p>要求：{finding.required_change}</p><p>Codex：{(issue.finding_responses ?? []).find((item: any) => item.finding_id === finding.finding_id)?.disposition ?? "等待响应"}</p></div>} /></List.Item>} /></Section>
        <Section title="Candidate A→B History"><List size="small" dataSource={issue.candidate_history ?? []} locale={{ emptyText: "尚无 Candidate" }} renderItem={(entry: any) => <List.Item><List.Item.Meta title={`${entry.candidate?.candidate_id} · Round ${entry.round} · ${entry.status}`} description={<div className="space-y-1 text-xs"><p className="break-all">Commit {entry.candidate?.candidate_commit ?? "—"}</p><p>Run {entry.candidate?.github_run?.id ?? "—"} · Artifact {entry.candidate?.artifact_id ?? "—"}</p><p>GitHub 远程核验：{entry.candidate?.github_remote_verification?.status ?? "未核验"} · Receipt {entry.candidate?.github_remote_verification?.content_hash ?? "—"}</p>{entry.superseded_by_candidate_id ? <p>已由 {entry.superseded_by_candidate_id} 替代</p> : null}</div>} /></List.Item>} /></Section>
        <Section title="CI / Artifact / GitHub Remote Receipt"><ReadableObject value={candidate ? { github_run: candidate.github_run, artifact_id: candidate.artifact_id, artifact_digest: candidate.artifact_digest, evidence_index_hash: candidate.evidence_index_hash, remote_repository: candidate.github_remote_verification?.repository, remote_status: candidate.github_remote_verification?.status, remote_receipt_hash: candidate.github_remote_verification?.content_hash, remote_checks: candidate.github_remote_verification?.checks } : null} empty="尚无活动 Candidate" /></Section>
        <Section title="Codex 协调与重启恢复"><ReadableObject value={{ codex_status: issue.codex_coordination?.status, codex_last_action: issue.codex_coordination?.last_action, codex_last_error: issue.codex_coordination?.last_error_code, observed_runtime_starts: issue.runtime_recovery?.observed_start_ids?.length ?? 0, event_chain_verified: issue.event_chain_verified }} empty="尚无运行闭环证据" /></Section>
        <Section title="Owner Decision"><ReadableObject value={{ requirement_delta: issue.requirement_delta, architecture_options: issue.architecture_options, accepted_option: issue.accepted_architecture_option, decision_history: issue.decision_history }} empty="当前无需 Owner Decision" /></Section>
        <Section title="Dual Signoff / Pilot Gate">{issue.dual_signoff ? <Alert type="success" showIcon icon={<ShieldCheck className="size-4" />} message="Codex + ChatGPT + Machine 已绑定当前 Candidate 双签" description={issue.dual_signoff.content_hash} /> : <Alert type="info" showIcon message="Pilot Gate 尚未满足" description={`Codex ${issue.verdicts?.codex ?? "等待"} · ChatGPT ${issue.verdicts?.chatgpt ?? "等待"} · Machine ${issue.verdicts?.machine ?? "等待"}`} />}</Section>
        <Section title="Timeline"><List size="small" dataSource={issue.candidate_history ?? []} renderItem={(entry: any) => <List.Item>{entry.candidate?.submitted_at} · Candidate {entry.candidate?.candidate_id} · {entry.status}</List.Item>} /></Section>
    </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="rounded-lg border border-border p-4"><h3 className="mb-3 font-semibold">{title}</h3>{children}</section>; }
function ReadableObject({ value, empty }: { value: unknown; empty: string }) {
    if (!value || (typeof value === "object" && Object.values(value as object).every((item) => item == null))) return <Typography.Text type="secondary">{empty}</Typography.Text>;
    return <dl className="grid gap-2 text-sm">{Object.entries(value as Record<string, unknown>).filter(([, item]) => item != null).map(([key, item]) => <div key={key} className="grid gap-1 md:grid-cols-[180px_1fr]"><dt className="text-foreground/48">{key}</dt><dd className="break-words">{typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : JSON.stringify(item)}</dd></div>)}</dl>;
}
function statusColor(value: string) { return /APPROVED|PASS|DEPLOYED|FROZEN/.test(value) ? "green" : /REQUIRED|FAILED|OWNER/.test(value) ? "red" : /WAITING|ASSESSING|FIXING|PROPOSED/.test(value) ? "gold" : "default"; }

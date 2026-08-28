export const FILMOS_PROPOSAL_MAX_BYTES = 1024 * 1024;

export type ChatGPTConnectionState = "connected" | "disconnected" | "unavailable" | "disabled";

export type ChatGPTAuthorizedProject = {
    project_id: string;
    project_name?: string;
    grant_id: string;
    expires_at: string;
};

export type ContextSnapshotSummary = {
    uri: string | null;
    version: number | null;
    state_hash: string | null;
};

export type ChatGPTHandoffStatus = {
    connection: ChatGPTConnectionState;
    local_mcp_ready: boolean;
    external_account_connected: boolean;
    authorized_project: ChatGPTAuthorizedProject | null;
    last_read_at: string | null;
    last_context_snapshot: ContextSnapshotSummary | null;
    proposal_handoff_enabled: boolean;
    status_code: string;
};

export type FilmOSProposalType = "Proposal" | "Candidate" | "Review Draft";

export type UntrustedProposalPackage = {
    raw: Record<string, unknown>;
    display: {
        proposal_id: string;
        host_project_id: string;
        proposal_type: string;
        summary: string;
    };
};

export type ProposalPreviewReceipt = {
    ok: true;
    kind: "FILMOS_PROPOSAL_IMPORT_PREVIEW";
    preview: {
        proposal_id: string;
        content_hash: string;
        host_project_id: string;
        base_state_hash: string;
        status: "PREVIEW_REQUIRES_HUMAN_APPROVAL";
        outputs: Array<{
            kind: FilmOSProposalType;
            status: "DRAFT";
            source_index: number;
            payload: unknown;
        }>;
        audit_action: "external_brain.proposal.previewed";
        formal_write_executed: false;
        provider_task_created: false;
        deletion_executed: false;
        idempotent_replay: boolean;
    };
    untrusted_display_summary: string;
};

const proposalTypes = new Set<FilmOSProposalType>(["Proposal", "Candidate", "Review Draft"]);

export function parseUntrustedProposalPackage(text: string): UntrustedProposalPackage {
    if (new TextEncoder().encode(text).byteLength > FILMOS_PROPOSAL_MAX_BYTES) throw new Error("Proposal 文件超过 1 MiB 本地导入上限");
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("Proposal 不是有效 JSON");
    }
    const value = requireRecord(parsed, "Proposal");
    return {
        raw: value,
        display: {
            proposal_id: optionalDisplayText(value.proposal_id),
            host_project_id: optionalDisplayText(value.host_project_id),
            proposal_type: optionalDisplayText(value.proposal_type),
            summary: optionalDisplayText(value.summary),
        },
    };
}

export function parseProposalPreviewReceipt(value: unknown, expectedProjectId: string, untrustedPackage: UntrustedProposalPackage): ProposalPreviewReceipt {
    const receipt = requireRecord(value, "Film Core Proposal Preview receipt");
    const preview = requireRecord(receipt.preview, "preview");
    if (receipt.ok !== true || receipt.kind !== "FILMOS_PROPOSAL_IMPORT_PREVIEW") throw new Error("本地边界未返回 Film Core Proposal Preview 回执");
    if (preview.status !== "PREVIEW_REQUIRES_HUMAN_APPROVAL") throw new Error("Proposal 未停在 Human Approval Preview 边界");
    if (preview.host_project_id !== expectedProjectId) throw new Error("权威回执不属于当前 Host 项目");
    if (preview.formal_write_executed !== false || preview.provider_task_created !== false || preview.deletion_executed !== false) throw new Error("权威回执越过 Preview 安全边界");
    if (preview.audit_action !== "external_brain.proposal.previewed") throw new Error("权威回执缺少 Proposal Preview 审计动作");
    const outputs = parsePreviewOutputs(preview.outputs);
    return {
        ok: true,
        kind: "FILMOS_PROPOSAL_IMPORT_PREVIEW",
        preview: {
            proposal_id: requireString(preview.proposal_id, "proposal_id"),
            content_hash: requireSha256(preview.content_hash, "content_hash"),
            host_project_id: expectedProjectId,
            base_state_hash: requireSha256(preview.base_state_hash, "base_state_hash"),
            status: "PREVIEW_REQUIRES_HUMAN_APPROVAL",
            outputs,
            audit_action: "external_brain.proposal.previewed",
            formal_write_executed: false,
            provider_task_created: false,
            deletion_executed: false,
            idempotent_replay: preview.idempotent_replay === true,
        },
        untrusted_display_summary: untrustedPackage.display.summary,
    };
}

function parsePreviewOutputs(value: unknown): ProposalPreviewReceipt["preview"]["outputs"] {
    if (!Array.isArray(value) || !value.length) throw new Error("权威回执没有 Draft 输出");
    return value.map((candidate, index) => {
        const output = requireRecord(candidate, `outputs[${index}]`);
        if (!proposalTypes.has(output.kind as FilmOSProposalType) || output.status !== "DRAFT" || output.source_index !== index) throw new Error("权威回执的输出不是有序 Proposal/Candidate/Review Draft");
        return { kind: output.kind as FilmOSProposalType, status: "DRAFT", source_index: index, payload: output.payload };
    });
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${name} 必须是 JSON object`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
    return value;
}

function requireSha256(value: unknown, name: string): string {
    const result = requireString(value, name);
    if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${name} 必须是 SHA-256`);
    return result;
}

function optionalDisplayText(value: unknown): string {
    return typeof value === "string" ? value.slice(0, 500) : "";
}

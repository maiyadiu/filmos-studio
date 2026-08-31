import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { BrainSession } from "./contracts.js";

type PendingIssue = { issue_id: string; project_id: string; state: string; coordination_key: string };
type ProjectContext = { projectId?: string; canvasId?: string };
type SessionDriver = {
    ensure(input: { issueId: string; projectId: string; canvasId: string; workspacePath: string }): Promise<BrainSession>;
    run(sessionId: string, prompt: string): Promise<string>;
};
export type ReviewWorktreePort = {
    prepare(issueId: string, baseCommit: string): Promise<{ workspacePath: string; branch: string; baseCommit: string }>;
};

export type ReviewBusCoordinatorPort = {
    pendingAll(signal?: AbortSignal): Promise<PendingIssue[]>;
    pending(projectId: string, signal?: AbortSignal): Promise<PendingIssue[]>;
    fullContext(issueId: string, projectId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
    post(issueId: string, action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
};

export class ReviewCodexCoordinator {
    private readonly handled = new Set<string>();
    private readonly inFlight = new Set<string>();

    constructor(
        private readonly bus: ReviewBusCoordinatorPort,
        private readonly sessions: SessionDriver,
        private readonly worktrees: ReviewWorktreePort,
        private readonly projectContext: () => ProjectContext,
    ) {}

    async tick(signal?: AbortSignal) {
        const context = this.projectContext();
        const issues = [...new Map((await this.bus.pendingAll(signal)).map((issue) => [issue.issue_id, issue])).values()];
        for (const issue of issues) {
            const fingerprint = `${issue.issue_id}:${issue.coordination_key}`;
            if (this.handled.has(fingerprint) || this.inFlight.has(issue.issue_id)) continue;
            this.inFlight.add(issue.issue_id);
            try {
                await this.handle(issue, context, signal);
                this.handled.add(fingerprint);
            } finally {
                this.inFlight.delete(issue.issue_id);
            }
        }
    }

    async watch(signal: AbortSignal, intervalMs = 2_000) {
        while (!signal.aborted) {
            try { await this.tick(signal); }
            catch (error) { if (signal.aborted) throw error; }
            await delay(Math.max(500, intervalMs), signal);
        }
    }

    private async handle(issue: PendingIssue, context: ProjectContext, signal?: AbortSignal) {
        if (issue.state === "OWNER_DECISION_REQUIRED") {
            await this.coordination(issue.issue_id, { status: "STOPPED_OWNER_GATE", session_id: null, last_action: "OWNER_DECISION_REQUIRED", last_error_code: null }, signal);
            return;
        }
        if (["WAITING_FOR_CHATGPT_REVIEW", "CHATGPT_ASSESSING", "CHATGPT_ARCHITECTURE_ASSESSMENT", "CONSENSUS_REVIEW"].includes(issue.state)) {
            await this.coordination(issue.issue_id, { status: "WAITING_EXTERNAL", session_id: null, last_action: issue.state, last_error_code: null }, signal);
            return;
        }
        if (["DUAL_APPROVED", "PILOT_DEPLOYED", "OBSERVING_IN_USE"].includes(issue.state)) {
            await this.coordination(issue.issue_id, { status: "COMPLETED", session_id: null, last_action: issue.state, last_error_code: null }, signal);
            return;
        }
        const full = await this.bus.fullContext(issue.issue_id, issue.project_id, signal);
        const baseCommit = String(full.base_commit || "");
        const workspace = await this.worktrees.prepare(issue.issue_id, baseCommit);
        const canvasId = context.projectId === issue.project_id && context.canvasId
            ? context.canvasId
            : `review-${issue.project_id}`;
        const session = await this.sessions.ensure({ issueId: issue.issue_id, projectId: issue.project_id, canvasId, workspacePath: workspace.workspacePath });
        const executionContext = {
            ...full,
            codex_workspace: {
                workspace_path: workspace.workspacePath,
                branch: workspace.branch,
                base_commit: workspace.baseCommit,
            },
        };
        await this.coordination(issue.issue_id, { status: "RUNNING", session_id: session.id, last_action: issue.state, last_error_code: null }, signal);
        try {
            if (issue.state === "EVIDENCE_FROZEN") await this.runAssessment(issue, executionContext, session.id, signal);
            else if (issue.state === "EVIDENCE_REQUIRED") await this.runEvidence(issue, executionContext, session.id, signal);
            else if (issue.state === "CONSENSUS_PROPOSED") await this.runConsensus(issue, executionContext, session.id, signal);
            else if (["TASK_PACKAGE_FROZEN", "CHANGES_REQUIRED", "CODEX_FIXING"].includes(issue.state)) await this.runCandidate(issue, executionContext, session.id, signal);
            else if (["EXTERNAL_APPROVED", "MACHINE_PASS"].includes(issue.state)) await this.runLocalAcceptance(issue, executionContext, session.id, signal);
            else await this.coordination(issue.issue_id, { status: "IDLE", session_id: session.id, last_action: `NO_AUTOMATION:${issue.state}`, last_error_code: null }, signal);
        } catch (error) {
            await this.coordination(issue.issue_id, { status: "FAILED", session_id: session.id, last_action: issue.state, last_error_code: errorCode(error) }, signal).catch(() => undefined);
            throw error;
        }
    }

    private async runAssessment(issue: PendingIssue, full: Record<string, unknown>, sessionId: string, signal?: AbortSignal) {
        const result = await this.runJson(sessionId, prompt("LOCAL_ASSESSMENT", full, ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"]));
        await this.bus.post(issue.issue_id, "assessments/codex", result, signal);
    }

    private async runEvidence(issue: PendingIssue, full: Record<string, unknown>, sessionId: string, signal?: AbortSignal) {
        const result = await this.runJson(sessionId, prompt("LOCAL_EVIDENCE_CAPTURE", full, ["source_commit", "items"]));
        await this.bus.post(issue.issue_id, "evidence/freeze", result, signal);
    }

    private async runConsensus(issue: PendingIssue, full: Record<string, unknown>, sessionId: string, signal?: AbortSignal) {
        const result = await this.runJson(sessionId, prompt("CONSENSUS_RESPONSE", full, ["proposal_content_hash", "position", "requested_changes"]));
        await this.bus.post(issue.issue_id, "consensus/responses/codex", result, signal);
    }

    private async runCandidate(issue: PendingIssue, full: Record<string, unknown>, sessionId: string, signal?: AbortSignal) {
        if ((full.lane === "core" || full.lane === "architecture") && !full.consensus_record) throw new Error("CONSENSUS_RECORD_REQUIRED");
        if (!full.issue_task_package) throw new Error("ISSUE_TASK_PACKAGE_REQUIRED");
        if (full.state === "OWNER_DECISION_REQUIRED") throw new Error("OWNER_DECISION_REQUIRED");
        const result = await this.runJson(sessionId, prompt("IMPLEMENT_TEST_COMMIT_PUSH_CANDIDATE", full, ["finding_responses", "candidate"]));
        const responses = Array.isArray(result.finding_responses) ? result.finding_responses : [];
        const alreadyResponded = new Set((Array.isArray(full.finding_responses) ? full.finding_responses : []).map((item) => asRecord(item).finding_id));
        for (const response of responses) {
            const value = asRecord(response);
            if (alreadyResponded.has(value.finding_id)) continue;
            await this.bus.post(issue.issue_id, "finding-responses", value, signal);
        }
        if (full.state === "CHANGES_REQUIRED") await this.bus.post(issue.issue_id, "rounds/next", {}, signal);
        await this.bus.post(issue.issue_id, "candidates", asRecord(result.candidate), signal);
    }

    private async runLocalAcceptance(issue: PendingIssue, full: Record<string, unknown>, sessionId: string, signal?: AbortSignal) {
        const result = await this.runJson(sessionId, prompt("LOCAL_CANDIDATE_ACCEPTANCE", full, ["verdict", "binding"]));
        if (result.verdict !== "LOCAL_ACCEPTED") throw new Error("CODEX_LOCAL_ACCEPTANCE_REQUIRED");
        await this.bus.post(issue.issue_id, "verdicts/codex", result, signal);
    }

    private async runJson(sessionId: string, value: string) {
        return parseStrictJson(await this.sessions.run(sessionId, value));
    }

    private async coordination(issueId: string, value: Record<string, unknown>, signal?: AbortSignal) {
        await this.bus.post(issueId, "codex-coordination", value, signal);
    }
}

export class HttpReviewBusCoordinator implements ReviewBusCoordinatorPort {
    constructor(private readonly baseUrl: string, private readonly tokenFile: string, private readonly fetchImpl: typeof fetch = fetch) {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("REVIEW_BUS_LOOPBACK_REQUIRED");
    }

    pendingAll(signal?: AbortSignal) { return this.request("GET", "/v1/review/internal/pending", undefined, signal).then((value) => value.issues as PendingIssue[]); }
    pending(projectId: string, signal?: AbortSignal) { return this.request("GET", `/v1/review/pending?project_id=${encodeURIComponent(projectId)}`, undefined, signal).then((value) => value.issues as PendingIssue[]); }
    fullContext(issueId: string, projectId: string, signal?: AbortSignal) { return this.request("GET", `/v1/review/internal/issues/${encodeURIComponent(issueId)}/full-context?project_id=${encodeURIComponent(projectId)}`, undefined, signal); }
    post(issueId: string, action: string, body: Record<string, unknown>, signal?: AbortSignal) { return this.request("POST", `/v1/issues/${encodeURIComponent(issueId)}/${action}`, body, signal); }

    private async request(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal) {
        const token = readFileSync(this.tokenFile, "utf8").trim();
        if (token.length < 24) throw new Error("REVIEW_BUS_TOKEN_REQUIRED");
        const response = await this.fetchImpl(new URL(path, this.baseUrl), { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
        const value = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new Error(String(value.code ?? "REVIEW_BUS_REQUEST_FAILED"));
        return value;
    }
}

function prompt(action: string, context: Record<string, unknown>, fields: string[]) {
    return [
        `You are the FilmOS Review Codex Coordinator. Action: ${action}.`,
        "Use only the signed-in Codex ChatGPT subscription through codex app-server. Never use any model API or model API credential.",
        "Operate only inside codex_workspace.workspace_path on codex_workspace.branch, which is an isolated worktree rooted at the frozen base commit.",
        "When the action requests implementation, run the scoped tests, create a real Git commit, push the review branch, wait for formal CI, and return only evidence that can be independently verified.",
        "Do not perform paid generation, upload media, create external projects, merge main, or exceed the frozen Issue Task Package scope.",
        "OWNER_DECISION_REQUIRED is a hard stop. Preserve immutable candidate and evidence history.",
        `Return exactly one JSON object with fields: ${fields.join(", ")}. No Markdown fences or prose.`,
        JSON.stringify(context),
    ].join("\n");
}

function parseStrictJson(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    const candidate = trimmed.startsWith("{") ? trimmed : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) throw new Error("CODEX_STRUCTURED_OUTPUT_REQUIRED");
    return asRecord(JSON.parse(candidate));
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODEX_STRUCTURED_OUTPUT_INVALID");
    return value as Record<string, unknown>;
}

function errorCode(error: unknown) { return error instanceof Error ? error.message.slice(0, 160) : "CODEX_COORDINATOR_FAILED"; }
function delay(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("ABORTED")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
}); }
export function reviewConversationId(issueId: string) { return `review:${issueId}`; }
export function reviewTurnId(issueId: string) { return `review-turn:${issueId}:${randomUUID()}`; }

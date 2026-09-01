import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { BrainSession } from "./contracts.js";

type CoordinationRecord = {
    status: string;
    session_id: string | null;
    last_action: string | null;
    last_error_code: string | null;
    coordination_key: string | null;
    attempt_id: string | null;
    retry_count: number;
    next_retry_at: string | null;
    stop_reason: string | null;
    result_available: boolean;
};
type PendingIssue = { issue_id: string; project_id: string; lane?: string; state: string; coordination_key: string; codex_coordination?: CoordinationRecord | null };
type ProjectContext = { projectId?: string; canvasId?: string };
type SessionDriver = {
    ensure(input: { issueId: string; projectId: string; canvasId: string; workspacePath: string }): Promise<BrainSession>;
    run(sessionId: string, prompt: string): Promise<string>;
    recover?(sessionId: string, attemptId: string): Promise<string | null>;
};
export type ReviewWorktreePort = {
    prepare(issueId: string, baseCommit: string): Promise<{ workspacePath: string; branch: string; baseCommit: string }>;
};

export type ReviewBusCoordinatorPort = {
    pendingAll(signal?: AbortSignal): Promise<PendingIssue[]>;
    pending(projectId: string, signal?: AbortSignal): Promise<PendingIssue[]>;
    fullContext(issueId: string, projectId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
    coordinationResult(issueId: string, projectId: string, coordinationKey: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
    post(issueId: string, action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
};

export class ReviewCodexCoordinator {
    private readonly handled = new Set<string>();
    private readonly inFlight = new Set<string>();

    async tick(signal?: AbortSignal) {
        const context = this.projectContext();
        const issues = [...new Map((await this.bus.pendingAll(signal)).map((issue) => [issue.issue_id, issue])).values()]
            .sort((left, right) => issuePriority(left.state) - issuePriority(right.state));
        for (const issue of issues) {
            const fingerprint = `${issue.issue_id}:${issue.coordination_key}`;
            if (this.handled.has(fingerprint) || persistentlyHandled(issue, this.now()) || this.inFlight.has(issue.issue_id)) continue;
            this.inFlight.add(issue.issue_id);
            try {
                await this.handle(issue, context, signal);
                this.handled.add(fingerprint);
            } finally {
                this.inFlight.delete(issue.issue_id);
            }
            // A single subscription turn can take minutes. Re-read the queue after
            // every issue so a newly proposed consensus or candidate verdict is not
            // starved behind unrelated evidence-capture work.
            break;
        }
    }

    async watch(signal: AbortSignal, intervalMs = 2_000) {
        while (!signal.aborted) {
            try { await this.tick(signal); }
            catch (error) { if (signal.aborted) throw error; }
            await delay(Math.max(500, intervalMs), signal);
        }
    }

    constructor(
        private readonly bus: ReviewBusCoordinatorPort,
        private readonly sessions: SessionDriver,
        private readonly worktrees: ReviewWorktreePort,
        private readonly projectContext: () => ProjectContext,
        private readonly now: () => Date = () => new Date(),
    ) {}

    private async handle(issue: PendingIssue, context: ProjectContext, signal?: AbortSignal) {
        let sessionId: string | null = null;
        let activeAttemptId = issue.codex_coordination?.coordination_key === issue.coordination_key
            ? issue.codex_coordination.attempt_id
            : null;
        let activeAction = issue.codex_coordination?.coordination_key === issue.coordination_key
            ? issue.codex_coordination.last_action ?? issue.state
            : issue.state;
        try {
            const terminal = terminalCoordination(issue);
            if (terminal) {
                await this.coordination(issue, { ...terminal, session_id: null, attempt_id: null }, signal);
                return;
            }
            if (issue.state === "ARCHITECTURE_EVIDENCE_FROZEN") {
                await this.bus.post(issue.issue_id, "architecture/assessments/begin", {}, signal);
                return;
            }
            if (issue.state === "ARCHITECTURE_OPTION_ACCEPTED") {
                await this.bus.post(issue.issue_id, "architecture/consensus/propose", {}, signal);
                return;
            }
            if (issue.state === "TASK_PACKAGE_FROZEN" && issue.lane === "architecture") {
                await this.bus.post(issue.issue_id, "architecture/implementation/start", {}, signal);
                return;
            }
            const full = await this.bus.fullContext(issue.issue_id, issue.project_id, signal);
            if (issue.state === "REQUIREMENT_DELTA_FROZEN") {
                const evidence = asRecordOrEmpty(full.evidence);
                const items = Array.isArray(evidence.local_items) ? evidence.local_items : [];
                if (items.length === 0) throw new Error("ARCHITECTURE_INTAKE_EVIDENCE_UNAVAILABLE");
                await this.bus.post(issue.issue_id, "evidence/freeze", {
                    source_commit: asRecordOrEmpty(evidence.manifest).sourceCommit ?? full.base_commit,
                    items,
                }, signal);
                return;
            }
            const workflow = modelWorkflow(issue, full);
            if (!workflow) {
                await this.coordination(issue, { status: "IDLE", session_id: null, attempt_id: null, last_action: `NO_AUTOMATION:${issue.state}`, last_error_code: null }, signal);
                return;
            }
            if (workflow.waiting) {
                await this.coordination(issue, { status: "WAITING_EXTERNAL", session_id: null, attempt_id: null, last_action: workflow.action, last_error_code: null }, signal);
                return;
            }
            activeAction = workflow.action;
            if (issue.codex_coordination?.result_available) {
                const stored = await this.bus.coordinationResult(issue.issue_id, issue.project_id, issue.coordination_key, signal);
                if (stored.action !== workflow.action) throw new Error("CODEX_COORDINATION_RESULT_ACTION_MISMATCH");
                await this.applyWorkflow(issue, full, workflow.action, asRecord(stored.result), signal);
                return;
            }
            const existingAttempt = issue.codex_coordination?.coordination_key === issue.coordination_key
                ? issue.codex_coordination.attempt_id
                : null;
            if (issue.codex_coordination?.status === "RUNNING" && existingAttempt && issue.codex_coordination.session_id) {
                sessionId = issue.codex_coordination.session_id;
                activeAttemptId = existingAttempt;
                const recovered = await this.sessions.recover?.(issue.codex_coordination.session_id, existingAttempt);
                if (!recovered) throw new Error("COORDINATOR_IN_FLIGHT_RESULT_UNAVAILABLE");
                const result = parseAttemptResult(recovered, existingAttempt);
                await this.persistResult(issue, existingAttempt, workflow.action, result, signal);
                await this.applyWorkflow(issue, full, workflow.action, result, signal);
                return;
            }
            const baseCommit = String(full.base_commit || "");
            const workspace = await this.worktrees.prepare(issue.issue_id, baseCommit);
            const canvasId = context.projectId === issue.project_id && context.canvasId
                ? context.canvasId
                : `review-${issue.project_id}`;
            const session = await this.sessions.ensure({ issueId: issue.issue_id, projectId: issue.project_id, canvasId, workspacePath: workspace.workspacePath });
            sessionId = session.id;
            const attemptId = `review-attempt-${randomUUID()}`;
            activeAttemptId = attemptId;
            const executionContext = {
                ...full,
                codex_workspace: {
                    workspace_path: workspace.workspacePath,
                    branch: workspace.branch,
                    base_commit: workspace.baseCommit,
                },
            };
            await this.coordination(issue, { status: "RUNNING", session_id: session.id, attempt_id: attemptId, last_action: workflow.action, last_error_code: null }, signal);
            const result = parseAttemptResult(await this.sessions.run(session.id, prompt(workflow.action, executionContext, ["coordination_attempt_id", ...workflow.fields], attemptId)), attemptId);
            await this.persistResult(issue, attemptId, workflow.action, result, signal);
            await this.applyWorkflow(issue, full, workflow.action, result, signal);
        } catch (error) {
            const code = errorCode(error);
            const prior = issue.codex_coordination?.coordination_key === issue.coordination_key ? issue.codex_coordination.retry_count : 0;
            const retryCount = Math.min(3, prior + 1);
            const retryable = retryableCoordinatorError(code) && retryCount < 3;
            await this.coordination(issue, {
                status: retryable ? "FAILED" : "STOPPED_ERROR",
                session_id: sessionId ?? issue.codex_coordination?.session_id ?? null,
                attempt_id: activeAttemptId,
                last_action: activeAction,
                last_error_code: code,
                retry_count: retryCount,
                next_retry_at: retryable ? new Date(this.now().getTime() + 2 ** retryCount * 1_000).toISOString() : null,
                stop_reason: retryable ? null : code,
            }, signal).catch(() => undefined);
            throw error;
        }
    }

    private async applyWorkflow(issue: PendingIssue, full: Record<string, unknown>, action: string, resultWithAttempt: Record<string, unknown>, signal?: AbortSignal) {
        const result = { ...resultWithAttempt };
        delete result.coordination_attempt_id;
        if (action === "LOCAL_ASSESSMENT") return await this.bus.post(issue.issue_id, "assessments/codex", result, signal);
        if (action === "LOCAL_EVIDENCE_CAPTURE") return await this.bus.post(issue.issue_id, "evidence/freeze", result, signal);
        if (action === "CONSENSUS_RESPONSE") return await this.bus.post(issue.issue_id, "consensus/responses/codex", result, signal);
        if (action === "ARCHITECTURE_OPTIONS") return await this.bus.post(issue.issue_id, "architecture/options", { options: result.options }, signal);
        if (action === "ARCHITECTURE_TASK_PACKAGE") return await this.bus.post(issue.issue_id, "architecture/task-package/freeze", result, signal);
        if (action === "LOCAL_CANDIDATE_ACCEPTANCE") {
            if (result.verdict !== "LOCAL_ACCEPTED") throw new Error("CODEX_LOCAL_ACCEPTANCE_REQUIRED");
            return await this.bus.post(issue.issue_id, "verdicts/codex", result, signal);
        }
        if (action !== "IMPLEMENT_TEST_COMMIT_PUSH_CANDIDATE") throw new Error("CODEX_COORDINATOR_ACTION_UNSUPPORTED");
        if ((full.lane === "core" || full.lane === "architecture") && !full.consensus_record) throw new Error("CONSENSUS_RECORD_REQUIRED");
        if (!full.issue_task_package) throw new Error("ISSUE_TASK_PACKAGE_REQUIRED");
        if (full.state === "OWNER_DECISION_REQUIRED") throw new Error("OWNER_DECISION_REQUIRED");
        const responses = Array.isArray(result.finding_responses) ? result.finding_responses : [];
        const alreadyResponded = new Set((Array.isArray(full.finding_responses) ? full.finding_responses : []).map((item) => asRecord(item).finding_id));
        for (const response of responses) {
            const value = asRecord(response);
            if (alreadyResponded.has(value.finding_id)) continue;
            await this.bus.post(issue.issue_id, "finding-responses", value, signal);
        }
        if (full.state === "CHANGES_REQUIRED") await this.bus.post(issue.issue_id, "rounds/next", {}, signal);
        return await this.bus.post(issue.issue_id, "candidates", asRecord(result.candidate), signal);
    }

    private async persistResult(issue: PendingIssue, attemptId: string, action: string, result: Record<string, unknown>, signal?: AbortSignal) {
        await this.bus.post(issue.issue_id, "codex-coordination/result", { coordination_key: issue.coordination_key, attempt_id: attemptId, action, result }, signal);
    }

    private async coordination(issue: PendingIssue, value: Record<string, unknown>, signal?: AbortSignal) {
        await this.bus.post(issue.issue_id, "codex-coordination", {
            status: value.status,
            session_id: value.session_id ?? null,
            last_action: value.last_action ?? null,
            last_error_code: value.last_error_code ?? null,
            coordination_key: issue.coordination_key,
            attempt_id: value.attempt_id ?? null,
            retry_count: value.retry_count ?? 0,
            next_retry_at: value.next_retry_at ?? null,
            stop_reason: value.stop_reason ?? null,
        }, signal);
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
    coordinationResult(issueId: string, projectId: string, coordinationKey: string, signal?: AbortSignal) { return this.request("GET", `/v1/review/internal/issues/${encodeURIComponent(issueId)}/codex-coordination/results/${encodeURIComponent(coordinationKey)}?project_id=${encodeURIComponent(projectId)}`, undefined, signal); }
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

function prompt(action: string, context: Record<string, unknown>, fields: string[], attemptId: string) {
    return [
        `You are the FilmOS Review Codex Coordinator. Action: ${action}.`,
        "Use only the signed-in Codex ChatGPT subscription through codex app-server. Never use any model API or model API credential.",
        "Operate only inside codex_workspace.workspace_path on codex_workspace.branch, which is an isolated worktree rooted at the frozen base commit.",
        "When the action requests implementation, run the scoped tests, create a real Git commit, push the review branch, wait for formal CI, and return only evidence that can be independently verified.",
        "Do not perform paid generation, upload media, create external projects, merge main, or exceed the frozen Issue Task Package scope.",
        "OWNER_DECISION_REQUIRED is a hard stop. Preserve immutable candidate and evidence history.",
        `Coordination attempt: ${attemptId}. Echo this exact value in coordination_attempt_id.`,
        `Return exactly one JSON object with fields: ${fields.join(", ")}. No Markdown fences or prose.`,
        JSON.stringify(context),
    ].join("\n");
}

function parseAttemptResult(text: string, attemptId: string) {
    const result = parseStrictJson(text);
    if (result.coordination_attempt_id !== attemptId) throw new Error("CODEX_COORDINATION_ATTEMPT_MISMATCH");
    return result;
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
function persistentlyHandled(issue: PendingIssue, now: Date) {
    const value = issue.codex_coordination;
    if (!value || value.coordination_key !== issue.coordination_key) return false;
    if (["WAITING_EXTERNAL", "STOPPED_OWNER_GATE", "COMPLETED", "IDLE", "STOPPED_ERROR"].includes(value.status)) return true;
    return value.status === "FAILED" && value.next_retry_at !== null && Date.parse(value.next_retry_at) > now.getTime();
}
function terminalCoordination(issue: PendingIssue) {
    if (["REQUIREMENT_OBSERVED", "OWNER_DECISION_REQUIRED"].includes(issue.state)) return { status: "STOPPED_OWNER_GATE", last_action: issue.state, last_error_code: null, stop_reason: issue.state };
    if (["WAITING_FOR_CHATGPT_REVIEW", "CHATGPT_ASSESSING", "CHATGPT_ARCHITECTURE_ASSESSMENT", "CONSENSUS_REVIEW"].includes(issue.state)) return { status: "WAITING_EXTERNAL", last_action: issue.state, last_error_code: null };
    if (["DUAL_APPROVED", "PILOT_DEPLOYED", "OBSERVING_IN_USE", "ARCHITECTURE_ADOPTED"].includes(issue.state)) return { status: "COMPLETED", last_action: issue.state, last_error_code: null };
    return null;
}
function modelWorkflow(issue: PendingIssue, full: Record<string, unknown>) {
    if (issue.state === "EVIDENCE_FROZEN") return { action: "LOCAL_ASSESSMENT", fields: ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"] };
    if (issue.state === "EVIDENCE_REQUIRED") return { action: "LOCAL_EVIDENCE_CAPTURE", fields: ["source_commit", "items"] };
    if (issue.state === "ARCHITECTURE_ASSESSMENTS_PENDING") {
        if (asRecordOrEmpty(full.assessment_receipts).codex) return { action: "WAITING_CHATGPT_ARCHITECTURE_ASSESSMENT", fields: [], waiting: true };
        return { action: "LOCAL_ASSESSMENT", fields: ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"] };
    }
    if (issue.state === "OPTION_COMPARISON") return { action: "ARCHITECTURE_OPTIONS", fields: ["options"] };
    if (issue.state === "CONSENSUS_PROPOSED") {
        const responded = Array.isArray(full.consensus_responses) && full.consensus_responses.some((item) => asRecordOrEmpty(item).actor === "codex");
        return responded ? { action: "WAITING_CHATGPT_CONSENSUS", fields: [], waiting: true } : { action: "CONSENSUS_RESPONSE", fields: ["proposal_content_hash", "position", "requested_changes"] };
    }
    if (issue.state === "CONSENSUS_REACHED") return { action: "ARCHITECTURE_TASK_PACKAGE", fields: ["allowedChangeScope", "explicitNonGoals", "implementationPlan", "acceptanceGates", "rollbackPlan"] };
    if (["CODEX_IMPLEMENTING", "CHANGES_REQUIRED", "CODEX_FIXING"].includes(issue.state)) return { action: "IMPLEMENT_TEST_COMMIT_PUSH_CANDIDATE", fields: ["finding_responses", "candidate"] };
    if (["CANDIDATE_UNDER_REVIEW", "EXTERNAL_APPROVED", "MACHINE_PASS"].includes(issue.state)) {
        if (asRecordOrEmpty(full.verdicts).codex === "LOCAL_ACCEPTED") return { action: "WAITING_OTHER_VERDICTS", fields: [], waiting: true };
        return { action: "LOCAL_CANDIDATE_ACCEPTANCE", fields: ["verdict", "binding"] };
    }
    return null;
}
function retryableCoordinatorError(code: string) {
    return ["REVIEW_BUS_REQUEST_FAILED", "fetch failed", "ECONN", "CODEX_ROLLOUT_UNAVAILABLE", "CODEX_TURN_ERROR", "BRAIN_CONNECTION_", "ABORTED"].some((value) => code.includes(value));
}
function asRecordOrEmpty(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function issuePriority(state: string) {
    const order: Record<string, number> = {
        OWNER_DECISION_REQUIRED: 0,
        CONSENSUS_PROPOSED: 1,
        EXTERNAL_APPROVED: 2,
        MACHINE_PASS: 2,
        TASK_PACKAGE_FROZEN: 3,
        CHANGES_REQUIRED: 3,
        CODEX_FIXING: 3,
        EVIDENCE_FROZEN: 4,
        EVIDENCE_REQUIRED: 5,
    };
    return order[state] ?? 10;
}
function delay(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("ABORTED")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
}); }
export function reviewConversationId(issueId: string) { return `review:${issueId}`; }
export function reviewTurnId(issueId: string) { return `review-turn:${issueId}:${randomUUID()}`; }

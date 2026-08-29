import type { AgentConfirmation } from "./contracts.js";
import { AgentConfirmationStore } from "./confirmations.js";
import type { CodexServerRequest } from "./adapters/codex-app-server-client.js";

type PendingDecision = {
    sessionId: string;
    contextReceiptId: string;
    resolve: (value: { approved: boolean; content?: Record<string, unknown> }) => void;
    timer: NodeJS.Timeout;
};

export class CodexApprovalCoordinator {
    private readonly pending = new Map<string, PendingDecision>();

    constructor(
        private readonly confirmations = new AgentConfirmationStore(),
        private readonly emit: (type: string, payload: unknown) => void = () => undefined,
        private readonly timeoutMs = 2 * 60_000,
    ) {}

    request(input: { sessionId: string; request: CodexServerRequest; contextReceiptId: string }) {
        const confirmation = this.confirmations.create({
            sessionId: input.sessionId,
            turnId: input.request.turnId || "unknown",
            requestId: String(input.request.id),
            toolName: requestToolName(input.request),
            risk: requestRisk(input.request),
            title: requestTitle(input.request),
            summary: requestSummary(input.request),
            impact: requestImpact(input.request),
            contextReceiptId: input.contextReceiptId,
            expiresInMs: this.timeoutMs,
        });
        this.emit("agent_event", { agent: "codex", type: "confirmation.required", sessionId: input.sessionId, turnId: confirmation.turnId, confirmation });
        return new Promise<{ approved: boolean; content?: Record<string, unknown> }>((resolve) => {
            // Keep the process alive until the approval resolves fail-closed; unref would strand this Promise.
            const timer = setTimeout(() => this.finish(confirmation.id, false), this.timeoutMs);
            this.pending.set(confirmation.id, { sessionId: input.sessionId, contextReceiptId: input.contextReceiptId, resolve, timer });
        });
    }

    decide(input: { confirmationId: string; sessionId: string; actorId: string; approved: boolean; content?: Record<string, unknown> }) {
        const pending = this.pending.get(input.confirmationId);
        if (!pending || pending.sessionId !== input.sessionId) throw new Error("AGENT_CONFIRMATION_SESSION_MISMATCH");
        const confirmation = this.confirmations.decide(input.confirmationId, {
            sessionId: input.sessionId,
            actorId: input.actorId,
            approved: input.approved,
        });
        if (input.approved) this.confirmations.consume(input.confirmationId, { sessionId: input.sessionId, contextReceiptId: pending.contextReceiptId });
        this.finish(input.confirmationId, input.approved, input.content);
        return confirmation;
    }

    cancelSession(sessionId: string) {
        this.confirmations.cancelSession(sessionId);
        for (const [confirmationId, pending] of this.pending) if (pending.sessionId === sessionId) this.finish(confirmationId, false);
    }

    dispose() {
        for (const confirmationId of [...this.pending.keys()]) this.finish(confirmationId, false);
    }

    private finish(confirmationId: string, approved: boolean, content?: Record<string, unknown>) {
        const pending = this.pending.get(confirmationId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(confirmationId);
        pending.resolve({ approved, ...(approved && content ? { content } : {}) });
    }
}

function requestToolName(request: CodexServerRequest) {
    const params = request.params;
    return String(params.toolName || params.tool || params.command || request.method);
}

function requestTitle(request: CodexServerRequest) {
    if (request.method === "mcpServer/elicitation/request") return "Codex 请求提交表单";
    if (/file|patch/i.test(request.method)) return "Codex 请求修改文件";
    if (/command|exec/i.test(request.method)) return "Codex 请求执行命令";
    return "Codex 请求额外权限";
}

function requestSummary(request: CodexServerRequest) {
    const reason = request.params.reason || request.params.command || request.params.toolName || request.params.tool;
    return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 2_000) : requestTitle(request);
}

function requestImpact(request: CodexServerRequest) {
    if (/command|exec/i.test(request.method)) return ["可能执行本机命令", "可能改变项目文件"];
    if (/file|patch/i.test(request.method)) return ["可能修改项目文件"];
    return ["将向 Codex 返回用户确认的输入"];
}

function requestRisk(request: CodexServerRequest): AgentConfirmation["risk"] {
    return /command|exec|file|patch/i.test(request.method) ? "write" : "approval";
}

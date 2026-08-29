import type {
    AgentEventSink,
    AgentPermissionGrant,
    AgentRuntimeAdapter,
    AgentTurnInput,
    BrainRuntimeStatus,
    BrainSession,
    CreateBrainSessionInput,
    ResumeBrainSessionInput,
} from "../contracts.js";
import type { AgentEmit } from "../../types.js";
import { CodexAppServerProcessManager } from "./codex-app-server-process-manager.js";
import { acceptServerRequest, declineServerRequest, type CodexAppServerClient, type CodexServerRequest } from "./codex-app-server-client.js";

type CodexConfirmationDecision = { approved: boolean; content?: Record<string, unknown> };
type CodexConfigFactory = (grant: AgentPermissionGrant) => Record<string, unknown>;

export class CodexSubscriptionAdapter implements AgentRuntimeAdapter {
    readonly connectionId = "codex.subscription";
    readonly profileId = "codex.subscription";

    private readonly threadsBySession = new Map<string, string>();
    private readonly queuesByThread = new Map<string, Promise<unknown>>();
    private readonly clientsBySession = new Map<string, CodexAppServerClient>();
    private readonly grantsBySession = new Map<string, AgentPermissionGrant>();
    private readonly activeTurnsBySession = new Map<string, { client: CodexAppServerClient; threadId: string; turnId: string }>();

    constructor(
        private readonly processManager: CodexAppServerProcessManager,
        private readonly workspaceForCanvas: (canvasId: string) => string,
        private readonly configForGrant: CodexConfigFactory,
        private readonly requestConfirmation?: (input: { sessionId: string; turnId: string; request: CodexServerRequest }) => Promise<CodexConfirmationDecision>,
    ) {}

    async probe(): Promise<BrainRuntimeStatus> {
        const checkedAt = new Date().toISOString();
        try {
            const probe = await this.processManager.probe();
            const account = record(record(probe.account).account);
            if (account.type !== "chatgpt") {
                return { profileId: this.profileId, status: "needs_auth", statusReason: "Codex app-server 没有已登录的 ChatGPT 订阅账号", checkedAt };
            }
            const limits = record(record(probe.limits).rateLimits);
            const usedPercent = numberValue(record(limits.primary).usedPercent);
            const quotaLimited = Boolean(limits.rateLimitReachedType) || usedPercent >= 100;
            return {
                profileId: this.profileId,
                status: quotaLimited ? "quota_limited" : "ready",
                ...(quotaLimited ? { statusReason: String(limits.rateLimitReachedType || "subscription quota exhausted") } : {}),
                checkedAt,
                accountLabel: typeof account.email === "string" ? account.email : "ChatGPT account",
                ...(typeof account.planType === "string" ? { version: account.planType } : {}),
                ...(usedPercent >= 0 ? { quota: { remainingPercent: Math.max(0, 100 - usedPercent), ...(numberValue(record(limits.primary).resetsAt) > 0 ? { resetsAt: new Date(numberValue(record(limits.primary).resetsAt) * 1000).toISOString() } : {}) } } : {}),
            };
        } catch (error) {
            return { profileId: this.profileId, status: "unavailable", statusReason: error instanceof Error ? error.message : String(error), checkedAt };
        }
    }

    async createSession(input: CreateBrainSessionInput, grant: AgentPermissionGrant): Promise<Partial<BrainSession>> {
        const client = await this.processManager.client();
        const workspace = this.workspaceForCanvas(input.canvasId);
        const binding = this.binding(input.brainProfileId, grant.sessionId, () => undefined);
        const thread = await client.startThread(workspace, this.configForGrant(grant), binding);
        const threadId = requiredThreadId(thread);
        this.threadsBySession.set(grant.sessionId, threadId);
        this.clientsBySession.set(grant.sessionId, client);
        this.grantsBySession.set(grant.sessionId, structuredClone(grant));
        return { providerThreadId: threadId };
    }

    async resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> {
        const threadId = input.providerThreadId || this.threadsBySession.get(input.sessionId);
        const grant = this.grantsBySession.get(input.sessionId);
        if (!threadId || !grant) throw new Error("CODEX_SESSION_RESUME_CONTEXT_MISSING");
        const client = await this.processManager.client();
        await client.resumeThread(threadId, undefined, this.configForGrant(grant), this.binding(this.profileId, input.sessionId, () => undefined));
        this.threadsBySession.set(input.sessionId, threadId);
        this.clientsBySession.set(input.sessionId, client);
        return { providerThreadId: threadId };
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        const sessionId = input.session.id;
        const threadId = input.session.providerThreadId || this.threadsBySession.get(sessionId);
        const grant = this.grantsBySession.get(sessionId);
        if (!threadId || !grant) throw new Error("CODEX_SESSION_THREAD_MISSING");
        const run = async () => {
            const client = await this.ensureClient(input.session, grant, sink);
            await sink({ type: "turn.started", sessionId, turnId: input.turnId, at: new Date().toISOString() });
            try {
                await client.startTurn(
                    threadId,
                    turnPrompt(input),
                    input.localImagePaths || [],
                    [],
                    this.binding(this.profileId, sessionId, normalizedEmit(sessionId, input.turnId, sink)),
                    (turnId) => this.activeTurnsBySession.set(sessionId, { client, threadId, turnId }),
                );
            } finally {
                this.activeTurnsBySession.delete(sessionId);
            }
            await sink({ type: "turn.completed", sessionId, turnId: input.turnId, at: new Date().toISOString() });
            return { sessionId, turnId: input.turnId, providerThreadId: threadId, status: "completed" as const };
        };
        const previous = this.queuesByThread.get(threadId) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(run);
        this.queuesByThread.set(threadId, queued);
        try {
            return await queued;
        } finally {
            if (this.queuesByThread.get(threadId) === queued) this.queuesByThread.delete(threadId);
        }
    }

    async cancelTurn(sessionId: string) {
        const active = this.activeTurnsBySession.get(sessionId);
        if (!active) return;
        await active.client.interruptTurn(active.threadId, active.turnId);
    }

    async closeSession(sessionId: string) {
        const threadId = this.threadsBySession.get(sessionId);
        const client = this.clientsBySession.get(sessionId);
        if (threadId) client?.unbindThread(threadId);
        this.threadsBySession.delete(sessionId);
        this.clientsBySession.delete(sessionId);
        this.grantsBySession.delete(sessionId);
        this.activeTurnsBySession.delete(sessionId);
    }

    private async ensureClient(session: BrainSession, grant: AgentPermissionGrant, sink: AgentEventSink) {
        const client = await this.processManager.client();
        if (this.clientsBySession.get(session.id) === client) return client;
        const threadId = session.providerThreadId || this.threadsBySession.get(session.id);
        if (!threadId) throw new Error("CODEX_SESSION_THREAD_MISSING");
        await client.resumeThread(threadId, this.workspaceForCanvas(session.canvasId), this.configForGrant(grant), this.binding(this.profileId, session.id, normalizedEmit(session.id, "recovery", sink)));
        this.clientsBySession.set(session.id, client);
        return client;
    }

    private binding(_profileId: string, sessionId: string, emit: AgentEmit) {
        return {
            emit,
            handleServerRequest: async (request: CodexServerRequest) => {
                const decision = this.requestConfirmation
                    ? await this.requestConfirmation({ sessionId, turnId: request.turnId || "unknown", request })
                    : { approved: false };
                return decision.approved ? acceptServerRequest(request.method, decision.content) : declineServerRequest(request.method);
            },
        };
    }
}

function turnPrompt(input: AgentTurnInput) {
    return [
        "FilmOS 当前上下文由系统生成；不得猜测 ID、版本或哈希。需要更多事实时先调用 workbench_get_context 或精确读取工具。",
        `Context Receipt: ${input.context.contextReceiptId}`,
        JSON.stringify(input.context),
        "",
        `用户请求：${input.prompt}`,
    ].join("\n");
}

function normalizedEmit(sessionId: string, turnId: string, sink: AgentEventSink): AgentEmit {
    return (type, payload) => {
        if (type !== "agent_event") return;
        const value = record(payload);
        const eventType = String(value.type || "");
        const now = new Date().toISOString();
        if (eventType === "item.updated") {
            const text = String(record(value.item).text || "");
            if (text) void sink({ type: "message.delta", sessionId, turnId, delta: text, at: now });
        }
        if (eventType === "error") void sink({ type: "turn.failed", sessionId, turnId, code: "CODEX_TURN_ERROR", message: String(value.message || "Codex turn failed"), at: now });
    };
}

function requiredThreadId(value: unknown) {
    const id = String(record(value).id || "");
    if (!id) throw new Error("Codex app-server 没有返回 thread id");
    return id;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

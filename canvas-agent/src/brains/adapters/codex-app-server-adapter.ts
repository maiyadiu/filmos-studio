import { summarizeShotImageMcpResult } from "@filmos/agent-contracts";
import type {
    AgentEventSink,
    AgentHistoryMessage,
    AgentPermissionGrant,
    AgentRuntimeAdapter,
    AgentTurnInput,
    AgentTurnPlan,
    BrainRuntimeStatus,
    BrainSession,
    CreateBrainSessionInput,
    ResumeBrainSessionInput,
} from "../contracts.js";
import type { AgentEmit } from "../../types.js";
import { isUnmaterializedCodexThreadError } from "../../codex-thread.js";
import { CodexAppServerProcessManager } from "./codex-app-server-process-manager.js";
import { acceptServerRequest, declineServerRequest, type CodexAppServerClient, type CodexExecutionPolicy, type CodexServerRequest } from "./codex-app-server-client.js";

type CodexConfirmationDecision = { approved: boolean; content?: Record<string, unknown> };
type CodexConfigFactory = (grant: AgentPermissionGrant) => Record<string, unknown>;

export class CodexSubscriptionAdapter implements AgentRuntimeAdapter {
    readonly connectionId = "codex.subscription";
    readonly profileId = "codex.subscription";

    private readonly threadsBySession = new Map<string, string>();
    private readonly queuesByThread = new Map<string, Promise<unknown>>();
    private readonly clientsBySession = new Map<string, CodexAppServerClient>();
    private readonly grantsBySession = new Map<string, AgentPermissionGrant>();
    private readonly activeTurnsBySession = new Map<string, { client: CodexAppServerClient; threadId: string; turnId: string; cancelRequested: boolean }>();

    constructor(
        private readonly processManager: CodexAppServerProcessManager,
        private readonly workspaceForScope: (id: string, kind: "canvas" | "project") => string,
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
        const client = await this.processManager.client(grant.sessionId);
        const workspace = input.workspacePath ?? this.workspaceForScope(input.canvasId ?? input.projectId, input.canvasId === null ? "project" : "canvas");
        const policy = executionPolicy(input.executionProfile);
        const binding = this.binding(input.brainProfileId, grant.sessionId, () => undefined);
        const thread = await client.startThread(workspace, executionConfig(this.configForGrant(grant), input.executionProfile), binding, policy);
        const threadId = requiredThreadId(thread);
        if (input.executionProfile !== "review_coordinator") await preflightWorkbenchMcp(client, threadId);
        this.threadsBySession.set(grant.sessionId, threadId);
        this.clientsBySession.set(grant.sessionId, client);
        this.grantsBySession.set(grant.sessionId, structuredClone(grant));
        return { providerThreadId: threadId };
    }

    async resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> {
        if (this.activeTurnsBySession.has(input.sessionId)) throw new Error("AGENT_SESSION_TURN_ALREADY_RUNNING");
        const threadId = input.providerThreadId || this.threadsBySession.get(input.sessionId);
        const grant = input.grant || this.grantsBySession.get(input.sessionId);
        if (!threadId || !grant) throw new Error("CODEX_SESSION_RESUME_CONTEXT_MISSING");
        const client = await this.processManager.client(input.sessionId, true);
        const scopeId = input.canvasId ?? input.projectId;
        const workspace = input.workspacePath ?? (scopeId ? this.workspaceForScope(scopeId, input.canvasId === null ? "project" : "canvas") : undefined);
        const config = executionConfig(this.configForGrant(grant), input.executionProfile);
        const binding = this.binding(this.profileId, input.sessionId, () => undefined);
        const policy = executionPolicy(input.executionProfile);
        let activeThreadId = threadId;
        try {
            await client.resumeThread(threadId, workspace, config, binding, policy);
        } catch (error) {
            if (input.executionProfile !== "review_coordinator" || !isUnmaterializedCodexThreadError(error)) throw error;
            activeThreadId = requiredThreadId(await client.startThread(workspace, config, binding, policy));
        }
        if (input.executionProfile !== "review_coordinator") await preflightWorkbenchMcp(client, activeThreadId);
        this.threadsBySession.set(input.sessionId, activeThreadId);
        this.clientsBySession.set(input.sessionId, client);
        this.grantsBySession.set(input.sessionId, structuredClone(grant));
        return { providerThreadId: activeThreadId };
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        const sessionId = input.session.id;
        const threadId = input.session.providerThreadId || this.threadsBySession.get(sessionId);
        const grant = this.grantsBySession.get(sessionId);
        if (!threadId || !grant) throw new Error("CODEX_SESSION_THREAD_MISSING");
        const run = async () => {
            input.signal?.throwIfAborted();
            const client = await this.ensureClient(input.session, grant, sink);
            input.signal?.throwIfAborted();
            const active = { client, threadId, turnId: "", cancelRequested: false };
            this.activeTurnsBySession.set(sessionId, active);
            const interrupt = () => {
                void this.cancelTurn(sessionId).catch(error => sink({ type: "turn.failed", sessionId, turnId: input.turnId, code: "CODEX_INTERRUPT_FAILED", message: String(error), at: new Date().toISOString() }));
            };
            input.signal?.addEventListener("abort", interrupt, { once: true });
            try {
                await sink({ type: "turn.started", sessionId, turnId: input.turnId, at: new Date().toISOString() });
                input.signal?.throwIfAborted();
                await client.startTurn(
                    threadId,
                    turnPrompt(input),
                    input.localImagePaths || [],
                    input.localSkills || [],
                    this.binding(this.profileId, sessionId, normalizedEmit(sessionId, input.turnId, sink)),
                    (turnId) => {
                        active.turnId = turnId;
                        if (active.cancelRequested) interrupt();
                    },
                    executionPolicy(input.session.executionProfile),
                );
                if (active.cancelRequested) throw new Error("AGENT_TURN_CANCELLED");
            } finally {
                input.signal?.removeEventListener("abort", interrupt);
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
        active.cancelRequested = true;
        if (active.turnId) await active.client.interruptTurn(active.threadId, active.turnId);
    }

    async readHistory(session: BrainSession): Promise<AgentHistoryMessage[]> {
        const threadId = session.providerThreadId || this.threadsBySession.get(session.id);
        if (!threadId) throw new Error("CODEX_SESSION_THREAD_MISSING");
        const client = await this.processManager.client(session.id);
        const result = await client.readThread(threadId, true);
        return codexThreadHistory(field(result, "thread") || result);
    }

    async closeSession(sessionId: string) {
        const threadId = this.threadsBySession.get(sessionId);
        const client = this.clientsBySession.get(sessionId);
        if (threadId) client?.unbindThread(threadId);
        this.threadsBySession.delete(sessionId);
        this.clientsBySession.delete(sessionId);
        this.grantsBySession.delete(sessionId);
        this.activeTurnsBySession.delete(sessionId);
        await this.processManager.releaseSession(sessionId);
    }

    private async ensureClient(session: BrainSession, grant: AgentPermissionGrant, sink: AgentEventSink) {
        const client = await this.processManager.client(session.id);
        if (this.clientsBySession.get(session.id) === client) return client;
        const threadId = session.providerThreadId || this.threadsBySession.get(session.id);
        if (!threadId) throw new Error("CODEX_SESSION_THREAD_MISSING");
        const workspace = session.workspacePath ?? this.workspaceForScope(session.canvasId ?? session.projectId, session.canvasId === null ? "project" : "canvas");
        await client.resumeThread(threadId, workspace, executionConfig(this.configForGrant(grant), session.executionProfile), this.binding(this.profileId, session.id, normalizedEmit(session.id, "recovery", sink)), executionPolicy(session.executionProfile));
        if (session.executionProfile !== "review_coordinator") await preflightWorkbenchMcp(client, threadId);
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

function executionPolicy(profile?: BrainSession["executionProfile"]): CodexExecutionPolicy {
    return profile === "review_coordinator"
        ? { approvalPolicy: "never", sandbox: "workspace-write" }
        : { approvalPolicy: "on-request", sandbox: "read-only", isolateWorkbenchTools: true };
}

function executionConfig(config: Record<string, unknown>, profile?: BrainSession["executionProfile"]) {
    return profile === "review_coordinator"
        ? { ...config, "sandbox_workspace_write.network_access": true }
        : { ...config, "features.memories": false, "features.shell_tool": false,
            "features.apps": false, "features.plugins": false, "features.remote_plugin": false,
            "web_search": "disabled", "mcp_servers.yingce.enabled": true, "mcp_servers.yingce.required": true };
}

async function preflightWorkbenchMcp(client: CodexAppServerClient, threadId: string) {
    await client.callMcpTool(threadId, "yingce", "workbench_get_context");
    let cursor: string | undefined;
    const seen = new Set<string>();
    let workbenchListed = false;
    do {
        const inventory = record(await client.listMcpServerStatus(threadId, cursor));
        if (!Array.isArray(inventory.data)) throw new Error("CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED");
        for (const value of inventory.data) {
            const server = record(value);
            if (server.name === "yingce") workbenchListed = true;
            if (server.name !== "yingce" && (server.runtimeStatus !== "disabled" || Object.keys(record(server.tools)).length > 0)) {
                throw new Error(`CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED:${String(server.name)}:${String(server.runtimeStatus)}`);
            }
        }
        cursor = typeof inventory.nextCursor === "string" && inventory.nextCursor ? inventory.nextCursor : undefined;
        if (cursor && seen.has(cursor)) throw new Error("CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED");
        if (cursor) seen.add(cursor);
    } while (cursor);
    if (!workbenchListed) throw new Error("CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED");
}

function turnPrompt(input: AgentTurnInput) {
    return [
        input.session.executionProfile === "review_coordinator"
            ? "FilmOS Review Coordinator 上下文由冻结的 Issue、Evidence 与隔离工作区生成，不依赖活动画布；不得调用 workbench_get_context 猜测或替换冻结事实。"
            : "FilmOS 当前上下文由系统生成；不得猜测 ID、版本或哈希。需要更多事实时先调用 workbench_get_context 或精确读取工具。",
        `Context Receipt: ${input.context.contextReceiptId}`,
        JSON.stringify(input.context),
        "项目业务工具 project_* 的 projectId 使用 project.domainProjectId（workbench_get_context 中的 domainProjectId），不是画布 projectId/canvasId；也可省略 projectId 由当前授权绑定提供。章节使用当前 contentUnitId 或读取到的真实 unitId。",
        "多步骤创作要求先列出有序步骤，说明修改范围、依赖和回读成功标准，并随实际进展更新。原生 update_plan 可用时使用该工具；不可用则用文字明确标注进度，不声称已写入结构化计划。工具失败时先回读已有成果；不得把依赖失败的后续步骤标为完成。计划是进度说明，不是保存凭证；最终只报告已回读匹配的业务结果和仍未完成项。简单单步要求不必建计划。",
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
        const item = record(value.item);
        const streamId = codexMessageStreamId(String(value.providerTurnId || turnId), String(item.id || "message"));
        if (eventType === "turn.plan.updated") {
            const steps = providerPlanSteps(value.plan);
            if (steps) void sink({ type: "turn.plan.updated", sessionId, turnId, plan: { source: "provider", turnId, steps, ...(typeof value.explanation === "string" ? { explanation: value.explanation } : {}), updatedAt: now }, at: now });
        }
        if (eventType === "item.updated" && item.type === "agent_message") {
            const delta = typeof value.delta === "string" ? value.delta : "";
            if (delta || typeof item.text === "string") void sink({ type: "message.delta", sessionId, turnId, delta, streamId, ...(typeof item.text === "string" ? { text: item.text } : {}), at: now });
        }
        if (eventType === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
            void sink({ type: "message.completed", sessionId, turnId, streamId, text: item.text, at: now });
        }
        if (eventType === "item.completed" && String(record(value.item).type || "") === "mcp_tool_call") {
            const item = record(value.item);
            const toolName = String(item.tool || item.name || "unknown_mcp_tool");
            const failed = Boolean(item.error) || String(item.status || "").toLowerCase() === "failed";
            void sink({
                type: "tool.completed",
                sessionId,
                turnId,
                result: {
                    requestId: String(item.id || `${sessionId}:${turnId}:${toolName}`),
                    sessionId,
                    toolName,
                    outcome: failed ? "failed" : "succeeded",
                    ...(item.result !== undefined ? { output: toolName === "project_read_shot_image" ? summarizeShotImageMcpResult(item.result) : item.result } : {}),
                    ...(failed ? { errorCode: "CODEX_MCP_TOOL_FAILED", errorMessage: String(record(item.error).message || item.error || "MCP tool failed") } : {}),
                    completedAt: now,
                },
                at: now,
            });
        }
        if (eventType === "error") void sink({ type: "turn.failed", sessionId, turnId, code: "CODEX_TURN_ERROR", message: String(value.message || "Codex turn failed"), at: now });
    };
}

function requiredThreadId(value: unknown) {
    const id = String(record(value).id || "");
    if (!id) throw new Error("Codex app-server 没有返回 thread id");
    return id;
}

function codexMessageStreamId(providerTurnId: string, itemId: string) {
    return JSON.stringify([providerTurnId, itemId]);
}

function providerPlanSteps(value: unknown): AgentTurnPlan["steps"] | null {
    if (!Array.isArray(value) || value.length > 100) return null;
    const steps: AgentTurnPlan["steps"] = [];
    for (const entry of value) {
        const { step, status } = record(entry);
        if (typeof step !== "string" || !step.trim() || step.length > 2000 || !["pending", "inProgress", "completed"].includes(String(status))) return null;
        steps.push({ step, status: status as AgentTurnPlan["steps"][number]["status"] });
    }
    return steps;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

export function codexThreadHistory(thread: unknown): AgentHistoryMessage[] {
    const messages: AgentHistoryMessage[] = [];
    arrayValue(field(thread, "turns")).forEach((turn, turnIndex) => {
        arrayValue(field(turn, "items")).forEach((item, itemIndex) => {
            const type = String(field(item, "type") || "");
            const id = String(field(item, "id") || `${turnIndex}-${itemIndex}`);
            if (type === "userMessage") {
                const text = displayUserText(userInputText(field(item, "content")));
                if (text) messages.push({ id, role: "user", text, source: "provider" });
            }
            if (type === "agentMessage") {
                const text = String(field(item, "text") || "");
                if (text) messages.push({ id, role: "assistant", title: "Codex", text, streamId: codexMessageStreamId(String(field(turn, "id") || turnIndex), id), source: "provider" });
            }
            if (type === "mcpToolCall") {
                const tool = String(field(item, "tool") || "工具调用");
                const error = field(field(item, "error"), "message");
                const detail = tool === "project_read_shot_image" ? { ...record(item), result: summarizeShotImageMcpResult(field(item, "result")) } : item;
                messages.push({ id, role: error ? "error" : "tool", title: tool, text: error ? String(error) : `${tool} ${String(field(item, "status") || "完成")}`, detail, source: "provider" });
            }
            if (type === "commandExecution") {
                const command = String(field(item, "command") || "").trim();
                if (command) messages.push({ id, role: "tool", title: "命令", text: command, detail: { cwd: field(item, "cwd"), status: field(item, "status"), exitCode: field(item, "exitCode") }, source: "provider" });
            }
            if (type === "fileChange") messages.push({ id, role: "tool", title: "文件变更", text: "Codex 修改了文件", detail: item, source: "provider" });
        });
    });
    return messages.filter((item) => item.text).slice(-120);
}

function userInputText(content: unknown) {
    return arrayValue(content).map((item) => {
        const type = String(field(item, "type") || "");
        if (type === "text") return String(field(item, "text") || "");
        if (type === "image" || type === "localImage") return "图片附件";
        if (type === "mention") return `@${String(field(item, "name") || "文件")}`;
        return "";
    }).filter(Boolean).join("\n");
}

function displayUserText(text: string) {
    const value = text.trim();
    const marker = "用户请求：";
    const index = value.lastIndexOf(marker);
    return (index >= 0 ? value.slice(index + marker.length) : value).trim();
}

function field(value: unknown, key: string): unknown {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

import { spawn, type ChildProcess } from "node:child_process";

import type { AgentEmit } from "../../types.js";

type Json = Record<string, unknown>;
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
export type CodexSkillInput = { type: "skill"; name: string; path: string };
export type CodexServerRequest = { id: string | number; method: string; params: Json; threadId?: string; turnId?: string };
export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;
export type CodexThreadBinding = { emit: AgentEmit; handleServerRequest?: CodexServerRequestHandler };
export type CodexExecutionPolicy = { approvalPolicy: "on-request" | "never"; sandbox: "read-only" | "workspace-write" };

type ActiveTurn = PendingRequest & { emit: AgentEmit; threadId: string };

export class CodexAppServerClient {
    private nextId = 1;
    private buffer = "";
    private textByItem = new Map<string, string>();
    private deltaCountByTurn = new Map<string, number>();
    private lastUsageByThread = new Map<string, unknown>();
    private pending = new Map<number, PendingRequest>();
    private activeTurns = new Map<string, ActiveTurn>();
    private completedTurns = new Map<string, Error | null>();
    private threadBindings = new Map<string, CodexThreadBinding>();
    private disposed = false;

    private constructor(
        private readonly child: ChildProcess,
        private readonly processEmit: AgentEmit,
        private readonly onExit: () => void,
    ) {}

    static async start(options: {
        command: string;
        args: string[];
        emit: AgentEmit;
        version: string;
        spawnProcess?: typeof spawn;
        onExit?: () => void;
    }) {
        const child = (options.spawnProcess ?? spawn)(options.command, options.args, {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        const client = new CodexAppServerClient(child, options.emit, options.onExit ?? (() => undefined));
        child.stdout?.on("data", (chunk) => client.read(chunk.toString()));
        child.stderr?.on("data", (chunk) => client.emitProcess("agent_log", { text: chunk.toString() }));
        child.on("error", (error) => client.emitProcess("agent_error", { message: error.message }));
        child.on("exit", (code) => {
            client.failAll(`Codex app-server exited: ${code ?? 0}`);
            client.emitProcess("agent_log", { text: `Codex app-server exited: ${code ?? 0}` });
            client.onExit();
        });
        await client.request("initialize", { clientInfo: { name: "filmos-studio", title: "FilmOS Studio Agent", version: options.version }, capabilities: { experimentalApi: true, requestAttestation: false } });
        client.notify("initialized");
        return client;
    }

    bindThread(threadId: string, binding: CodexThreadBinding) {
        if (!threadId) throw new Error("Cannot bind an empty Codex thread id");
        this.threadBindings.set(threadId, binding);
    }

    unbindThread(threadId: string) {
        this.threadBindings.delete(threadId);
    }

    async readAccount() {
        return await this.request("account/read", { refreshToken: false });
    }

    async readRateLimits() {
        return await this.request("account/rateLimits/read", undefined);
    }

    async startChatGPTLogin() {
        return await this.request("account/login/start", {
            type: "chatgpt",
            codexStreamlinedLogin: true,
            useHostedLoginSuccessPage: true,
            appBrand: "codex",
        });
    }

    async logoutAccount() {
        return await this.request("account/logout", undefined);
    }

    async startThread(cwd: string | undefined, config: Json, binding?: CodexThreadBinding, policy: CodexExecutionPolicy = interactivePolicy) {
        const result = await this.request("thread/start", {
            ...policyParams(policy),
            config,
            ...(cwd ? { cwd } : {}),
            threadSource: "user",
        });
        const thread = field(result, "thread") as Json | undefined;
        const id = String(field(thread, "id") || "");
        if (!id) throw new Error("Codex app-server 没有返回 thread id");
        if (binding) this.bindThread(id, binding);
        return thread || {};
    }

    async resumeThread(threadId: string, cwd: string | undefined, config: Json, binding?: CodexThreadBinding, policy: CodexExecutionPolicy = interactivePolicy) {
        if (binding) this.bindThread(threadId, binding);
        const result = await this.request("thread/resume", {
            threadId,
            ...policyParams(policy),
            config,
            ...(cwd ? { cwd } : {}),
        });
        const thread = field(result, "thread") as Json | undefined;
        const id = String(field(thread, "id") || "");
        if (!id) throw new Error("Codex app-server 没有返回 thread id");
        if (binding && id !== threadId) {
            this.unbindThread(threadId);
            this.bindThread(id, binding);
        }
        return thread || {};
    }

    listThreads(params: Json) {
        return this.request("thread/list", params);
    }

    readThread(threadId: string, includeTurns = true) {
        return this.request("thread/read", { threadId, includeTurns });
    }

    listMcpServerStatus(threadId: string) {
        return this.request("mcpServerStatus/list", { threadId, detail: "full" });
    }

    callMcpTool(threadId: string, server: string, tool: string, args: Record<string, unknown> = {}) {
        return this.request("mcpServer/tool/call", { threadId, server, tool, arguments: args });
    }

    archiveThread(threadId: string) {
        this.unbindThread(threadId);
        return this.request("thread/archive", { threadId });
    }

    async startTurn(threadId: string, prompt: string, images: string[], skills: CodexSkillInput[] = [], binding?: CodexThreadBinding, onTurnStarted?: (turnId: string) => void, policy: CodexExecutionPolicy = interactivePolicy) {
        if (binding) this.bindThread(threadId, binding);
        const result = await this.request("turn/start", {
            threadId,
            input: codexInput(prompt, images, skills),
            ...policyParams(policy),
        });
        const turnId = String(field(field(result, "turn"), "id") || "");
        if (!turnId) throw new Error("Codex app-server 没有返回 turn id");
        onTurnStarted?.(turnId);
        const completed = this.completedTurns.get(turnId);
        if (this.completedTurns.has(turnId)) {
            this.completedTurns.delete(turnId);
            if (completed) throw completed;
            return { turnId };
        }
        const emit = binding?.emit ?? this.threadBindings.get(threadId)?.emit ?? this.processEmit;
        await new Promise((resolve, reject) => this.activeTurns.set(turnId, { resolve, reject, emit, threadId }));
        return { turnId };
    }

    interruptTurn(threadId: string, turnId: string) {
        return this.request("turn/interrupt", { threadId, turnId });
    }

    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.failAll("Codex app-server disposed");
        await terminateProcessTree(this.child);
    }

    private request(method: string, params: unknown) {
        if (this.disposed) return Promise.reject(new Error("Codex app-server is disposed"));
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    private notify(method: string, params?: unknown) {
        this.write(params === undefined ? { method } : { method, params });
    }

    private write(value: unknown) {
        this.child.stdin?.write(`${JSON.stringify(value)}\n`);
    }

    private read(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                this.handle(JSON.parse(line) as Json);
            } catch {
                this.emitProcess("agent_log", { text: line });
            }
        });
    }

    private handle(message: Json) {
        const id = Number(message.id);
        if (message.error && this.pending.has(id)) return this.reject(id, String(field(message.error, "message") || "Codex request failed"));
        if (this.pending.has(id)) return this.resolve(id, message.result);
        if (typeof message.method === "string" && "id" in message) {
            void this.answerServerRequest(message);
            return;
        }
        if (typeof message.method === "string") this.handleNotification(message.method, (message.params || {}) as Json);
    }

    private handleNotification(method: string, params: Json) {
        const threadId = String(field(params, "threadId") || field(field(params, "thread"), "id") || "");
        const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
        const active = turnId ? this.activeTurns.get(turnId) : undefined;
        const emit = active?.emit ?? this.threadBindings.get(threadId)?.emit ?? this.processEmit;
        if (method === "item/agentMessage/delta") return this.emitDelta(params, emit, turnId);
        if (method === "thread/tokenUsage/updated") this.lastUsageByThread.set(threadId, normalizeUsage(params));
        const event = normalizeCodexNotification(method, params);
        if (!event) return;
        if (event.type === "turn.completed") event.usage = this.lastUsageByThread.get(threadId) ?? null;
        emit("agent_event", { agent: "codex", ...event });
        if (event.type === "turn.completed") {
            const pending = this.activeTurns.get(turnId);
            const error = field(field(params, "turn"), "error");
            if (pending) {
                this.activeTurns.delete(turnId);
                error ? pending.reject(new Error(String(field(error, "message") || "Codex turn failed"))) : pending.resolve(event);
            } else if (turnId) {
                this.completedTurns.set(turnId, error ? new Error(String(field(error, "message") || "Codex turn failed")) : null);
            }
            emit("agent_event", { agent: "codex", type: "stream.summary", delta_count: this.deltaCountByTurn.get(turnId) || 0 });
            this.deltaCountByTurn.delete(turnId);
            emit("agent_done", { agent: "codex", usage: event.usage });
        }
    }

    private emitDelta(params: Json, emit: AgentEmit, turnId: string) {
        const id = String(field(params, "itemId") || "");
        const itemKey = `${turnId}\u0000${id}`;
        const text = `${this.textByItem.get(itemKey) || ""}${String(field(params, "delta") || "")}`;
        this.deltaCountByTurn.set(turnId, (this.deltaCountByTurn.get(turnId) || 0) + 1);
        this.textByItem.set(itemKey, text);
        emit("agent_event", { agent: "codex", type: "item.updated", delta: String(field(params, "delta") || ""), item: { id, type: "agent_message", text } });
    }

    private async answerServerRequest(message: Json) {
        const method = String(message.method);
        const params = (message.params || {}) as Json;
        const threadId = String(field(params, "threadId") || "");
        const turnId = String(field(params, "turnId") || "");
        const binding = this.threadBindings.get(threadId);
        const emit = binding?.emit ?? this.processEmit;
        let result: unknown;
        try {
            result = binding?.handleServerRequest
                ? await binding.handleServerRequest({ id: message.id as string | number, method, params, ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) })
                : declineServerRequest(method);
        } catch (error) {
            result = declineServerRequest(method);
            emit("agent_error", { message: error instanceof Error ? error.message : String(error) });
        }
        this.write({ id: message.id, result });
        emit("agent_event", { agent: "codex", type: "server.request", method, params, result });
    }

    private emitProcess(type: string, payload: unknown) {
        this.processEmit(type, payload);
        for (const binding of new Set(this.threadBindings.values())) binding.emit(type, payload);
    }

    private resolve(id: number, result: unknown) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.resolve(result));
    }

    private reject(id: number, message: string) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.reject(new Error(message)));
    }

    failAll(message: string) {
        [...this.pending.values(), ...this.activeTurns.values()].forEach((item) => item.reject(new Error(message)));
        this.pending.clear();
        this.activeTurns.clear();
    }
}

const interactivePolicy: CodexExecutionPolicy = { approvalPolicy: "on-request", sandbox: "read-only" };
function policyParams(policy: CodexExecutionPolicy) {
    return {
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(policy.approvalPolicy === "on-request" ? { approvalsReviewer: "user" } : {}),
    };
}

async function terminateProcessTree(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signalProcessTree(child, "SIGTERM");
    if (await settledWithin(exited, 5_000)) return;
    signalProcessTree(child, "SIGKILL");
    await settledWithin(exited, 2_000);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
    if (process.platform !== "win32" && child.pid) {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {
            // The process may have exited between the status check and signal.
        }
    }
    try {
        child.kill(signal);
    } catch {
        // Already exited.
    }
}

async function settledWithin(promise: Promise<void>, timeoutMs: number) {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
    });
    const settled = await Promise.race([promise.then(() => true as const), timedOut]);
    if (timeout) clearTimeout(timeout);
    return settled;
}

export function declineServerRequest(method: string) {
    if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn", strictAutoReview: true };
    if (method === "applyPatchApproval" || method === "execCommandApproval") return { decision: { denied: { rejection: "FilmOS confirmation was not approved" } } };
    return { decision: "decline" };
}

export function acceptServerRequest(method: string, content: Record<string, unknown> = {}) {
    if (method === "mcpServer/elicitation/request") return { action: "accept", content, _meta: null };
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn", strictAutoReview: true };
    if (method === "applyPatchApproval" || method === "execCommandApproval") return { decision: "approved" };
    return { decision: "accept" };
}

export function codexInput(prompt: string, images: string[], skills: CodexSkillInput[]) {
    return [
        { type: "text", text: prompt, text_elements: [] },
        ...images.map((file) => ({ type: "localImage", path: file })),
        ...skills,
    ];
}

function normalizeCodexNotification(method: string, params: Json) {
    if (method === "thread/started") return { type: "thread.started", thread_id: field(field(params, "thread"), "id") };
    if (method === "turn/started") return { type: "turn.started" };
    if (method === "turn/completed") return { type: "turn.completed", usage: null as unknown };
    if (method === "item/started") return { type: "item.started", item: normalizeItem(field(params, "item")) };
    if (method === "item/completed") return { type: "item.completed", item: normalizeItem(field(params, "item")) };
    if (method === "error") return { type: "error", message: field(params, "message") };
    return null;
}

function normalizeItem(item: unknown) {
    const value = item && typeof item === "object" ? { ...(item as Json) } : {};
    if (value.type === "agentMessage") value.type = "agent_message";
    if (value.type === "mcpToolCall") value.type = "mcp_tool_call";
    if (value.type === "agent_message" && typeof value.id === "string") value.text = String(value.text || "");
    if ("arguments" in value) value.arguments = parseMaybeJson(value.arguments);
    return value;
}

function normalizeUsage(params: Json) {
    const total = field(field(params, "tokenUsage"), "total") as Json | undefined;
    return {
        input_tokens: field(total, "inputTokens"),
        cached_input_tokens: field(total, "cachedInputTokens"),
        output_tokens: field(total, "outputTokens"),
        reasoning_output_tokens: field(total, "reasoningOutputTokens"),
    };
}

function parseMaybeJson(value: unknown) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function field(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Json)[key] : undefined;
}

import { CONFIG_DIR, ensureCanvasWorkspace, type LocalRuntimeConfig } from "../config.js";
import { codexConfig, codexProcessManager } from "../agents.js";
import type { AgentEmit } from "../types.js";
import { MemoryAgentAuditSink } from "./agent-audit.js";
import { CodexSubscriptionAdapter } from "./adapters/codex-app-server-adapter.js";
import { AgentConfirmationStore } from "./confirmations.js";
import { AgentContextBroker, type WorkbenchContextSnapshot } from "./context-broker.js";
import { AgentPermissionGrantStore } from "./permission-grants.js";
import { registerBuiltinBrainProfiles } from "./profiles.js";
import { BrainProfileRegistry } from "./registry.js";
import { AgentSessionManager } from "./session-manager.js";
import { MemoryBrainSessionStore } from "./session-store.js";
import { CanonicalAgentToolManifest } from "./tool-manifest.js";

export class GenericAgentRuntime {
    readonly registry = new BrainProfileRegistry();
    readonly store = new MemoryBrainSessionStore();
    readonly grants = new AgentPermissionGrantStore();
    readonly confirmations = new AgentConfirmationStore();
    readonly contexts = new AgentContextBroker();
    readonly tools = new CanonicalAgentToolManifest();
    readonly audit = new MemoryAgentAuditSink();
    readonly manager: AgentSessionManager;

    constructor(
        config: LocalRuntimeConfig,
        emit: AgentEmit,
        private readonly snapshot: () => WorkbenchContextSnapshot,
        requestConfirmation: ConstructorParameters<typeof CodexSubscriptionAdapter>[3],
    ) {
        registerBuiltinBrainProfiles(this.registry);
        this.registry.registerAdapter(new CodexSubscriptionAdapter(
            codexProcessManager,
            (canvasId) => ensureCanvasWorkspace(config, canvasId).workspacePath,
            (grant) => codexConfig(CONFIG_DIR, grant),
            requestConfirmation,
        ));
        this.manager = new AgentSessionManager(this.registry, this.store, this.grants, this.confirmations, this.contexts, () => new Date(), this.tools, this.audit);
        void emit;
    }

    async listConnections() {
        return await Promise.all(this.registry.listProfiles().map(async (profile) => ({
            profile,
            status: this.registry.hasAdapter(profile.id)
                ? await this.registry.probe(profile.id)
                : {
                    profileId: profile.id,
                    status: profile.id === "chatgpt.subscription.host" ? "unavailable" as const : profile.availability === "disabled" ? "unavailable" as const : "unknown" as const,
                    statusReason: profile.id === "chatgpt.subscription.host" ? "ChatGPT Host 状态由 Desktop Project Grant/Tunnel 控制面提供" : "该 Profile 使用独立显式 Adapter",
                    checkedAt: new Date().toISOString(),
                },
        })));
    }

    async createSession(input: Parameters<AgentSessionManager["createSession"]>[0]) {
        if (!this.registry.hasAdapter(input.brainProfileId)) throw new Error(`BRAIN_ADAPTER_UNAVAILABLE:${input.brainProfileId}`);
        const session = await this.manager.createSession(input);
        return await this.captureContext(session.id);
    }

    async captureContext(sessionId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error(`Unknown brain session: ${sessionId}`);
        const captured = this.contexts.capture(session, this.snapshot());
        const next = await this.manager.bindContextReceipt(sessionId, captured.receipt.receiptId);
        return { session: next, context: captured.pack, receipt: captured.receipt };
    }

    async sendTurn(sessionId: string, input: { turnId: string; prompt: string }, emit: AgentEmit) {
        const captured = await this.captureContext(sessionId);
        const result = await this.manager.sendTurn(sessionId, {
            turnId: input.turnId,
            prompt: input.prompt,
            context: captured.context,
        }, async (event) => emit("agent_event", event));
        return { session: await this.store.getSession(sessionId), contextReceiptId: captured.receipt.receiptId, result };
    }

    async dispose() {
        const sessions = await this.store.listSessions();
        await Promise.all(sessions.filter((session) => session.status !== "closed").map((session) => this.manager.closeSession(session.id).catch(() => undefined)));
    }
}

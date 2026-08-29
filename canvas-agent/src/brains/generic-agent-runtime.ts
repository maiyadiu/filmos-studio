import path from "node:path";

import { CONFIG_DIR, ensureCanvasWorkspace, type LocalRuntimeConfig } from "../config.js";
import { codexConfig, codexProcessManager } from "../agents.js";
import type { AgentEmit } from "../types.js";
import { CompositeAgentAuditSink, JsonlAgentAuditSink, MemoryAgentAuditSink } from "./agent-audit.js";
import { CodexSubscriptionAdapter } from "./adapters/codex-app-server-adapter.js";
import { AgentConfirmationStore } from "./confirmations.js";
import { AgentContextBroker, type WorkbenchContextSnapshot } from "./context-broker.js";
import { AgentPermissionGrantStore } from "./permission-grants.js";
import { registerBuiltinBrainProfiles } from "./profiles.js";
import { BrainProfileRegistry } from "./registry.js";
import { AgentSessionManager } from "./session-manager.js";
import { JsonBrainSessionStore, type BrainSessionStore } from "./session-store.js";
import { CanonicalAgentToolManifest } from "./tool-manifest.js";
import { enabledAgentProfileIds, type AgentFeatureFlags } from "./feature-flags.js";

type GenericAgentRuntimeOptions = {
    store?: BrainSessionStore;
    featureFlags: AgentFeatureFlags;
    grants?: AgentPermissionGrantStore;
    tools?: CanonicalAgentToolManifest;
};

export class GenericAgentRuntime {
    readonly registry = new BrainProfileRegistry();
    readonly store: BrainSessionStore;
    readonly grants: AgentPermissionGrantStore;
    readonly confirmations = new AgentConfirmationStore();
    readonly contexts = new AgentContextBroker();
    readonly tools: CanonicalAgentToolManifest;
    readonly audit = new MemoryAgentAuditSink();
    readonly manager: AgentSessionManager;
    private readonly hydratedSessions = new Set<string>();
    private readonly actorId: string;

    constructor(
        config: LocalRuntimeConfig,
        emit: AgentEmit,
        private readonly snapshot: () => WorkbenchContextSnapshot,
        requestConfirmation: ConstructorParameters<typeof CodexSubscriptionAdapter>[3],
        options: GenericAgentRuntimeOptions,
    ) {
        this.actorId = config.ownerId || "local-owner";
        this.store = options.store ?? new JsonBrainSessionStore(path.join(CONFIG_DIR, "brain-sessions.v1.json"), config.canvases);
        this.grants = options.grants ?? new AgentPermissionGrantStore();
        this.tools = options.tools ?? new CanonicalAgentToolManifest();
        registerBuiltinBrainProfiles(this.registry, enabledAgentProfileIds(options.featureFlags));
        if (options.featureFlags["film.agent_codex_subscription"]) {
            this.registry.registerAdapter(new CodexSubscriptionAdapter(
                codexProcessManager,
                (canvasId) => ensureCanvasWorkspace(config, canvasId).workspacePath,
                (grant) => codexConfig(CONFIG_DIR, grant),
                requestConfirmation,
            ));
        }
        const audit = new CompositeAgentAuditSink([
            this.audit,
            new JsonlAgentAuditSink(path.join(CONFIG_DIR, "agent-audit.v1.jsonl")),
        ]);
        this.manager = new AgentSessionManager(this.registry, this.store, this.grants, this.confirmations, this.contexts, () => new Date(), this.tools, audit);
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
        this.hydratedSessions.add(session.id);
        return await this.captureContext(session.id);
    }

    async resumeSession(sessionId: string, actorId: string) {
        const session = await this.manager.resumeSession(sessionId, actorId);
        this.hydratedSessions.add(sessionId);
        return await this.captureContext(sessionId);
    }

    async captureContext(sessionId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error(`Unknown brain session: ${sessionId}`);
        const captured = this.contexts.capture(session, this.snapshot());
        const next = await this.manager.bindContextReceipt(sessionId, captured.receipt.receiptId);
        return { session: next, context: captured.pack, receipt: captured.receipt };
    }

    async sendTurn(sessionId: string, input: { turnId: string; prompt: string; localImagePaths?: string[]; localSkills?: Array<{ type: "skill"; name: string; path: string }> }, emit: AgentEmit) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error(`Unknown brain session: ${sessionId}`);
        if (!this.hydratedSessions.has(sessionId)) {
            await this.manager.resumeSession(sessionId, this.actorId);
            this.hydratedSessions.add(sessionId);
        }
        const captured = await this.captureContext(sessionId);
        const result = await this.manager.sendTurn(sessionId, {
            turnId: input.turnId,
            prompt: input.prompt,
            context: captured.context,
            ...(input.localImagePaths?.length ? { localImagePaths: [...input.localImagePaths] } : {}),
            ...(input.localSkills?.length ? { localSkills: input.localSkills.map((skill) => ({ ...skill })) } : {}),
        }, async (event) => emit("agent_event", event));
        return { session: await this.store.getSession(sessionId), contextReceiptId: captured.receipt.receiptId, result };
    }

    async dispose() {
        this.hydratedSessions.clear();
    }
}

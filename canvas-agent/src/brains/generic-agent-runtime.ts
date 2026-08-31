import path from "node:path";

import { CONFIG_DIR, ensureCanvasWorkspace, type LocalRuntimeConfig } from "../config.js";
import { codexConfig, codexProcessManager } from "../agents.js";
import type { AgentEmit } from "../types.js";
import { CompositeAgentAuditSink, JsonlAgentAuditSink, MemoryAgentAuditSink } from "./agent-audit.js";
import { CodexSubscriptionAdapter } from "./adapters/codex-app-server-adapter.js";
import { AgentConfirmationStore } from "./confirmations.js";
import { AgentContextBroker, type WorkbenchContextSnapshot } from "./context-broker.js";
import { AgentPermissionGrantStore } from "./permission-grants.js";
import { BrainProfileRegistry } from "./registry.js";
import { AgentSessionManager } from "./session-manager.js";
import { JsonBrainSessionStore, type BrainSessionStore } from "./session-store.js";
import { CanonicalAgentToolManifest } from "./tool-manifest.js";
import { agentRuntimeProfileStatus, enabledAgentProfileIds, type AgentFeatureFlags } from "./feature-flags.js";
import { BrainAdapterFactory } from "./adapter-factory.js";
import { BrainRuntimeCompositionRoot } from "./runtime-composition-root.js";
import {
    BrowserChatGPTHostBridgeClient,
    BrowserModelRuntimePort,
    type BrowserRuntimeTransport,
} from "./browser-runtime-port.js";
import { AgentPolicyGateway } from "./policy-gateway.js";
import { CanonicalAgentToolBroker, type AgentBrokerOutcome } from "./tool-broker.js";
import { AgentRuntimeInstrumentation } from "./instrumentation.js";
import { registerProductionToolProviders, type CanonicalCanvasToolExecutor } from "./tool-providers.js";
import type { BrainSession } from "./contracts.js";

type GenericAgentRuntimeOptions = {
    store?: BrainSessionStore;
    featureFlags: AgentFeatureFlags;
    grants?: AgentPermissionGrantStore;
    tools?: CanonicalAgentToolManifest;
    browserRuntime: BrowserRuntimeTransport;
    canvasToolExecutor: CanonicalCanvasToolExecutor;
    persistentAudit?: false;
};

type ConfirmationWaiter = {
    sessionId: string;
    resolve(outcome: AgentBrokerOutcome): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
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
    readonly composition: { enabledProfileIds: string[]; adapterProfileIds: string[] };
    readonly instrumentation = new AgentRuntimeInstrumentation();
    readonly policy: AgentPolicyGateway;
    readonly broker: CanonicalAgentToolBroker;
    private readonly hydratedSessions = new Set<string>();
    private readonly activeTurns = new Map<string, string>();
    private readonly confirmationWaiters = new Map<string, ConfirmationWaiter>();
    private readonly actorId: string;
    private readonly featureFlags: AgentFeatureFlags;

    constructor(
        config: LocalRuntimeConfig,
        emit: AgentEmit,
        private readonly snapshot: () => WorkbenchContextSnapshot,
        requestConfirmation: ConstructorParameters<typeof CodexSubscriptionAdapter>[3],
        options: GenericAgentRuntimeOptions,
    ) {
        this.actorId = config.ownerId || "local-owner";
        this.featureFlags = structuredClone(options.featureFlags);
        this.store = options.store ?? new JsonBrainSessionStore(path.join(CONFIG_DIR, "brain-sessions.v1.json"), config.canvases);
        this.grants = options.grants ?? new AgentPermissionGrantStore();
        this.tools = options.tools ?? new CanonicalAgentToolManifest();
        const enabledProfiles = enabledAgentProfileIds(options.featureFlags);
        const browserModelRuntime = new BrowserModelRuntimePort(options.browserRuntime);
        const adapterFactory = new BrainAdapterFactory({
            codex: new CodexSubscriptionAdapter(
                codexProcessManager,
                (canvasId) => ensureCanvasWorkspace(config, canvasId).workspacePath,
                (grant) => codexConfig(CONFIG_DIR, grant),
                requestConfirmation,
            ),
            chatgptHost: new BrowserChatGPTHostBridgeClient(options.browserRuntime),
            browserModelRuntime,
            explicitlyEnabled: (profileId) => enabledProfiles.has(profileId),
        });
        this.composition = new BrainRuntimeCompositionRoot(this.registry, adapterFactory, options.featureFlags).compose();
        const audit = new CompositeAgentAuditSink([
            this.audit,
            ...(options.persistentAudit === false ? [] : [new JsonlAgentAuditSink(path.join(CONFIG_DIR, "agent-audit.v1.jsonl"))]),
        ]);
        this.policy = new AgentPolicyGateway(this.grants, this.contexts);
        this.broker = new CanonicalAgentToolBroker(this.tools, this.grants, this.confirmations, this.policy, audit, this.instrumentation);
        registerProductionToolProviders({
            broker: this.broker,
            manifest: this.tools,
            canvas: options.canvasToolExecutor,
            snapshot: this.snapshot,
            browserRuntime: options.browserRuntime,
        });
        this.manager = new AgentSessionManager(this.registry, this.store, this.grants, this.confirmations, this.contexts, () => new Date(), this.tools, audit);
        this.emit = emit;
    }

    async listConnections() {
        return await probeConnectionList(this.registry);
    }

    async createSession(input: Parameters<AgentSessionManager["createSession"]>[0]) {
        if (!this.registry.hasAdapter(input.brainProfileId)) throw new Error(`BRAIN_ADAPTER_UNAVAILABLE:${input.brainProfileId}`);
        const session = await this.manager.createSession(input);
        this.hydratedSessions.add(session.id);
        return await this.captureContext(session.id);
    }

    async resumeSession(sessionId: string, actorId: string) {
        const previous = await this.store.getSession(sessionId);
        if (!previous) throw new Error(`Unknown brain session: ${sessionId}`);
        const session = await this.manager.resumeSession(sessionId, actorId);
        this.hydratedSessions.add(sessionId);
        const captured = await this.captureContext(sessionId);
        this.emitRecoveredHostState(previous, captured.session);
        const adapter = this.registry.getAdapter(captured.session.brainProfileId);
        const history = adapter.readHistory ? await adapter.readHistory(captured.session) : [];
        return {
            ...captured,
            history,
            historyStatus: historyStatus(captured.session.brainProfileId, Boolean(adapter.readHistory)),
        };
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
        this.activeTurns.set(sessionId, input.turnId);
        try {
            const result = await this.manager.sendTurn(sessionId, {
                turnId: input.turnId,
                prompt: input.prompt,
                context: captured.context,
                ...(input.localImagePaths?.length ? { localImagePaths: [...input.localImagePaths] } : {}),
                ...(input.localSkills?.length ? { localSkills: input.localSkills.map((skill) => ({ ...skill })) } : {}),
            }, async (event) => emit("agent_event", event));
            return { session: await this.store.getSession(sessionId), contextReceiptId: captured.receipt.receiptId, result };
        } finally {
            this.activeTurns.delete(sessionId);
        }
    }

    async requestTool(input: { sessionId: string; turnId?: string; toolName: string; toolInput: Record<string, unknown>; ordinaryConfirmationEnabled?: boolean }) {
        const outcome = await this.proposeTool(input);
        if (outcome.status === "completed") return outcome;
        const session = await this.store.getSession(input.sessionId);
        if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
        return await new Promise<AgentBrokerOutcome>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.confirmationWaiters.delete(outcome.confirmation.id);
                reject(new Error("AGENT_CONFIRMATION_EXPIRED"));
            }, 5 * 60_000);
            timer.unref();
            this.confirmationWaiters.set(outcome.confirmation.id, { sessionId: session.id, resolve, reject, timer });
        });
    }

    async proposeTool(input: { sessionId: string; turnId?: string; toolName: string; toolInput: Record<string, unknown>; ordinaryConfirmationEnabled?: boolean }) {
        const session = await this.store.getSession(input.sessionId);
        if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
        const contextReceiptId = session.lastContextReceiptId;
        if (!contextReceiptId) throw new Error("AGENT_CONTEXT_NOT_BOUND_TO_SESSION");
        const profile = this.registry.getProfile(session.brainProfileId);
        const turnId = input.turnId || this.activeTurns.get(session.id);
        if (!turnId) throw new Error("AGENT_ACTIVE_TURN_REQUIRED");
        const outcome = await this.broker.request({
            profile,
            session,
            turnId,
            toolName: input.toolName,
            input: input.toolInput,
            contextReceiptId,
            currentContext: this.snapshot(),
            ordinaryConfirmationEnabled: input.ordinaryConfirmationEnabled,
        });
        await this.emitBrokerOutcome(outcome, session.id, turnId);
        if (outcome.status === "completed") return outcome;
        await this.store.updateSession(session.id, { status: "awaiting_confirmation", updatedAt: new Date().toISOString() });
        return outcome;
    }

    async decideConfirmation(input: { confirmationId: string; sessionId: string; actorId: string; approved: boolean }) {
        const waiter = this.confirmationWaiters.get(input.confirmationId);
        if (waiter && waiter.sessionId !== input.sessionId) throw new Error("AGENT_CONFIRMATION_WAITER_SCOPE_MISMATCH");
        const session = await this.store.getSession(input.sessionId);
        if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
        const profile = this.registry.getProfile(session.brainProfileId);
        this.confirmations.decide(input.confirmationId, {
            sessionId: input.sessionId,
            actorId: input.actorId,
            approved: input.approved,
        });
        try {
            const outcome = await this.broker.executeConfirmed({
                confirmationId: input.confirmationId,
                profile,
                session,
                currentContext: this.snapshot(),
            });
            await this.emitBrokerOutcome(outcome, session.id, this.activeTurns.get(session.id) || "confirmation");
            waiter?.resolve(outcome);
            await this.store.updateSession(session.id, { status: "running", updatedAt: new Date().toISOString() });
            return outcome;
        } catch (error) {
            const failure = input.approved ? error : new Error("AGENT_TOOL_REJECTED_BY_HUMAN");
            waiter?.reject(failure instanceof Error ? failure : new Error(String(failure)));
            await this.store.updateSession(session.id, { status: "running", updatedAt: new Date().toISOString() });
            if (input.approved) throw error;
            return { status: "rejected", confirmationId: input.confirmationId } as const;
        } finally {
            if (waiter) clearTimeout(waiter.timer);
            this.confirmationWaiters.delete(input.confirmationId);
        }
    }

    diagnostics() {
        return {
            composition: this.composition,
            counters: this.instrumentation.snapshot(),
            featureFlags: structuredClone(this.featureFlags),
            activation: agentRuntimeProfileStatus(this.featureFlags),
        };
    }

    private readonly emit: AgentEmit;

    private emitRecoveredHostState(previous: BrainSession, current: BrainSession) {
        const before = previous.hostHandoff;
        const after = current.hostHandoff;
        if (!after || (before?.handoffId === after.handoffId && before.status === after.status)) return;
        const at = new Date().toISOString();
        if (after.status === "host_observed") this.emit("agent_event", { type: "host.observed", sessionId: current.id, handoff: after, at });
        if (after.status === "proposal_received") this.emit("agent_event", { type: "host.proposal.received", sessionId: current.id, handoff: after, at });
        if (after.status === "expired") this.emit("agent_event", { type: "host.handoff.expired", sessionId: current.id, handoff: after, at });
    }

    private async emitBrokerOutcome(outcome: AgentBrokerOutcome, sessionId: string, turnId: string) {
        const at = new Date().toISOString();
        if (outcome.status === "confirmation_required") {
            this.emit("agent_event", { type: "tool.proposed", sessionId, turnId, request: outcome.request, at });
            this.emit("agent_event", { type: "confirmation.required", sessionId, turnId, confirmation: outcome.confirmation, at });
            return;
        }
        this.emit("agent_event", { type: "tool.completed", sessionId, turnId, result: outcome.result, at });
    }

    async dispose() {
        for (const waiter of this.confirmationWaiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("AGENT_RUNTIME_DISPOSED"));
        }
        this.confirmationWaiters.clear();
        this.activeTurns.clear();
        this.hydratedSessions.clear();
    }
}

export async function probeConnectionList(registry: BrainProfileRegistry) {
    return await Promise.all(registry.listProfiles().map(async (profile) => {
        try {
            const status = registry.hasAdapter(profile.id)
                ? await registry.probe(profile.id)
                : {
                    profileId: profile.id,
                    status: "unavailable" as const,
                    statusReason: profile.availability === "disabled" ? "该 Profile 未启用" : "该 Profile 使用独立显式 Adapter",
                    checkedAt: new Date().toISOString(),
                };
            return { profile, status };
        } catch (error) {
            return {
                profile,
                status: {
                    profileId: profile.id,
                    status: "error" as const,
                    statusReason: error instanceof Error ? error.message : String(error),
                    checkedAt: new Date().toISOString(),
                },
            };
        }
    }));
}

function historyStatus(profileId: string, supported: boolean) {
    if (profileId === "codex.subscription") return { source: "provider" as const, complete: true };
    if (profileId === "chatgpt.subscription.host") return { source: "handoff_timeline" as const, complete: true };
    return {
        source: "not_persisted" as const,
        complete: false,
        limitation: supported ? "该 Profile 未返回可恢复历史" : "API / Local Profile 当前不持久化 Provider 对话历史",
    };
}

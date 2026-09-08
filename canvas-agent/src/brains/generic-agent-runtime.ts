import { createHash } from "node:crypto";
import path from "node:path";
import { summarizeShotImage, parseCodexModelSelection } from "@filmos/agent-contracts";

import { CONFIG_DIR, ensureCanvasWorkspace, ensureProjectAgentWorkspace, ensureRuntimeAgentWorkspace, type LocalRuntimeConfig } from "../config.js";
import { codexConfig, codexProcessManager } from "../agents.js";
import type { AgentEmit } from "../types.js";
import { CompositeAgentAuditSink, JsonlAgentAuditSink, MemoryAgentAuditSink } from "./agent-audit.js";
import { CodexSubscriptionAdapter } from "./adapters/codex-app-server-adapter.js";
import { AgentConfirmationStore } from "./confirmations.js";
import type { CodexApprovalCoordinator } from "./codex-approval-coordinator.js";
import { AgentContextBroker, assertSessionContextScope, type WorkbenchContextSnapshot } from "./context-broker.js";
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
import type { AgentTurnReceipt, BrainSession } from "./contracts.js";
import { ScriptCreationScope } from "./script-creation-scope.js";
import { HttpReviewBusCoordinator, ReviewCodexCoordinator, reviewConversationId, reviewTurnId } from "./review-codex-coordinator.js";
import { ReviewWorktreeManager } from "./review-worktree-manager.js";
import { SourceMaintenanceTasks } from "./source-maintenance-tasks.js";

type GenericAgentRuntimeOptions = {
    store?: BrainSessionStore;
    featureFlags: AgentFeatureFlags;
    grants?: AgentPermissionGrantStore;
    tools?: CanonicalAgentToolManifest;
    browserRuntime: BrowserRuntimeTransport;
    canvasToolExecutor: CanonicalCanvasToolExecutor;
    persistentAudit?: false;
    nativeConfirmations?: Pick<CodexApprovalCoordinator, "pendingForSession" | "cancelSession">;
    sourceMaintenance?: SourceMaintenanceTasks;
    codexAdapter?: import("./contracts.js").AgentRuntimeAdapter;
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
    private readonly sessionHydrations = new Map<string, Promise<BrainSession>>();
    private readonly resumingSessions = new Set<string>();
    private readonly activeTurns = new Map<string, string>();
    private readonly turnReceipts = new Map<string, AgentTurnReceipt>();
    private readonly scriptCreationScopes = new Map<string, ScriptCreationScope>();
    private readonly turnControllers = new Map<string, AbortController>();
    private readonly cancelledTurns = new Set<string>();
    private readonly confirmationWaiters = new Map<string, ConfirmationWaiter>();
    private readonly actorId: string;
    private readonly featureFlags: AgentFeatureFlags;
    private reviewCoordinatorAbort?: AbortController;

    constructor(
        config: LocalRuntimeConfig,
        emit: AgentEmit,
        private readonly snapshot: () => WorkbenchContextSnapshot,
        requestConfirmation: ConstructorParameters<typeof CodexSubscriptionAdapter>[3],
        private readonly options: GenericAgentRuntimeOptions,
    ) {
        this.actorId = config.ownerId || "local-owner";
        this.featureFlags = structuredClone(options.featureFlags);
        this.store = options.store ?? new JsonBrainSessionStore(path.join(CONFIG_DIR, "brain-sessions.v1.json"), config.canvases);
        this.grants = options.grants ?? new AgentPermissionGrantStore();
        this.tools = options.tools ?? new CanonicalAgentToolManifest();
        const enabledProfiles = enabledAgentProfileIds(options.featureFlags);
        const browserModelRuntime = new BrowserModelRuntimePort(options.browserRuntime);
        const adapterFactory = new BrainAdapterFactory({
            codex: options.codexAdapter ?? new CodexSubscriptionAdapter(
                codexProcessManager,
                (id, kind) => kind === "workspace" ? ensureRuntimeAgentWorkspace(config, id) : kind === "project" ? ensureProjectAgentWorkspace(id) : ensureCanvasWorkspace(config, id).workspacePath,
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
            bindContextRead: async (session, snapshot) => {
                const captured = this.contexts.capture(session, snapshot);
                await this.manager.bindContextReceipt(session.id, captured.receipt.receiptId);
                return { contextReceiptId: captured.receipt.receiptId, contextExpiresAt: captured.receipt.expiresAt };
            },
            browserRuntime: options.browserRuntime,
        });
        for (const tool of this.tools.list().filter(tool => tool.provider === "source_maintenance")) this.broker.register(tool.name, {
            execute: async ({ session, request, manifest }) => {
                if (!options.sourceMaintenance) throw new Error("AGENT_SOURCE_UNAVAILABLE");
                const grant = this.grants.get(session.permissionGrantId);
                const signal = this.turnControllers.get(session.id)?.signal;
                const output = await options.sourceMaintenance.execute(session, grant?.sourceTaskId, request.toolName, request.input, () => {
                    signal?.throwIfAborted();
                    if (this.cancelledTurns.has(`${session.id}:${request.turnId}`)) throw new Error("AGENT_TURN_CANCELLED");
                });
                return { output, ...(manifest.risk === "write" ? { postcondition: { provider: "source_maintenance", verified: "verified" in output && output.verified === true } } : {}) };
            },
            verifyPostcondition: async ({ postcondition }) => postcondition.provider === "source_maintenance" && postcondition.verified === true,
        });
        this.manager = new AgentSessionManager(this.registry, this.store, this.grants, this.confirmations, this.contexts, () => new Date(), this.tools, audit, session => options.sourceMaintenance?.grant(session));
        this.emit = emit;
        this.startReviewCoordinator();
    }

    async listConnections() {
        return await probeConnectionList(this.registry);
    }

    async changeSourceTask(sessionId: string, operation: "open" | "close" | "reconcile", input: unknown, authorize: () => void) {
        if (!this.options.sourceMaintenance) throw new Error("AGENT_SOURCE_UNAVAILABLE");
        if (this.activeTurns.has(sessionId) || this.resumingSessions.has(sessionId)) throw new Error("AGENT_SESSION_TURN_ALREADY_RUNNING");
        this.resumingSessions.add(sessionId);
        try {
            authorize();
            const session = await this.store.getSession(sessionId);
            if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
            contextSnapshotForSession(session, this.snapshot);
            if (operation === "reconcile") return { source: await this.options.sourceMaintenance.reconcile(session, authorize) };
            if (["closed", "creating", "running", "awaiting_confirmation"].includes(session.status) || this.sessionView(session).execution.pendingConfirmations.length) throw new Error("AGENT_SESSION_TURN_ALREADY_RUNNING");
            if (operation === "open") await this.options.sourceMaintenance.open(session, input, authorize);
            else await this.options.sourceMaintenance.close(session, authorize);
            this.grants.revokeSession(sessionId);
            authorize();
            // Replace only this idle session's MCP grant/process, then resume
            // its original provider thread. Never create or send a model turn.
            await this.manager.resumeSession(sessionId, this.actorId);
            this.hydratedSessions.add(sessionId);
            const result = await this.captureContext(sessionId);
            authorize();
            return { ...result, source: this.options.sourceMaintenance.view(result.session) };
        } finally { this.resumingSessions.delete(sessionId); }
    }

    async closeSession(sessionId: string) {
        if (this.activeTurns.has(sessionId) || this.resumingSessions.has(sessionId)) throw new Error("AGENT_SESSION_TURN_ALREADY_RUNNING");
        this.resumingSessions.add(sessionId);
        try { return await this.manager.closeSession(sessionId); }
        finally { this.resumingSessions.delete(sessionId); }
    }

    // Persisted status can outlive a process. Observe the existing live turn and
    // confirmation maps; this read never resumes a provider or renews a grant.
    sessionView(session: BrainSession) {
        return { ...session, execution: {
            activeTurnId: this.activeTurns.get(session.id) ?? null,
            resuming: this.resumingSessions.has(session.id),
            pendingConfirmations: [...this.confirmations.pendingForSession(session.id), ...(this.options.nativeConfirmations?.pendingForSession(session.id) ?? [])],
        } };
    }

    async readSessionHistory(sessionId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
        contextSnapshotForSession(session, this.snapshot);
        const adapter = this.registry.getAdapter(session.brainProfileId);
        const available = this.hydratedSessions.has(sessionId) && Boolean(adapter.readHistory);
        const history = available ? await adapter.readHistory!(session) : [];
        return { session: this.sessionView(session), history, historyStatus: available
            ? historyStatus(session.brainProfileId, true)
            : { source: "not_persisted" as const, complete: false, limitation: "本机尚未载入该会话历史；空结果不表示没有历史，请在空闲时恢复原会话。" } };
    }

    async createSession(input: Parameters<AgentSessionManager["createSession"]>[0]) {
        if (!this.registry.hasAdapter(input.brainProfileId)) throw new Error(`BRAIN_ADAPTER_UNAVAILABLE:${input.brainProfileId}`);
        if (input.executionProfile !== "review_coordinator") assertSessionContextScope(input, this.snapshot());
        const session = await this.manager.createSession(input);
        this.hydratedSessions.add(session.id);
        return await this.captureContext(session.id);
    }

    async resumeSession(sessionId: string, actorId: string) {
        if (this.activeTurns.has(sessionId) || this.resumingSessions.has(sessionId)) throw new Error("AGENT_SESSION_TURN_ALREADY_RUNNING");
        this.resumingSessions.add(sessionId);
        try {
            const previous = await this.store.getSession(sessionId);
            if (!previous) throw new Error(`Unknown brain session: ${sessionId}`);
            contextSnapshotForSession(previous, this.snapshot);
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
        } finally { this.resumingSessions.delete(sessionId); }
    }

    async captureContext(sessionId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error(`Unknown brain session: ${sessionId}`);
        const captured = this.contexts.capture(session, contextSnapshotForSession(session, this.snapshot));
        const next = await this.manager.bindContextReceipt(sessionId, captured.receipt.receiptId);
        return { session: next, context: captured.pack, receipt: captured.receipt };
    }

    async sendTurn(sessionId: string, input: { turnId: string; prompt: string; localImagePaths?: string[]; localSkills?: Array<{ type: "skill"; name: string; path: string }>; scriptCreation?: unknown; codexModel?: unknown }, emit: AgentEmit) {
        if (this.activeTurns.has(sessionId) || this.resumingSessions.has(sessionId)) throw new Error("AGENT_SESSION_TURN_ALREADY_RUNNING");
        if (this.cancelledTurns.has(`${sessionId}:${input.turnId}`)) throw new Error("AGENT_TURN_CANCELLED");
        const controller = new AbortController();
        this.activeTurns.set(sessionId, input.turnId);
        this.turnControllers.set(sessionId, controller);
        let receipt: AgentTurnReceipt | undefined;
        try {
            const current = await this.store.getSession(sessionId);
            if (!current) throw new Error("BRAIN_SESSION_NOT_FOUND");
            if (current.latestTurnReceipt?.turnId === input.turnId) throw new Error("AGENT_TURN_ALREADY_SUBMITTED");
            receipt = { turnId: input.turnId, status: "running", startedAt: new Date().toISOString(), writeAttempted: false };
            this.turnReceipts.set(sessionId, receipt);
            await this.store.updateSession(sessionId, { latestTurnReceipt: structuredClone(receipt) });
            const codexModel = parseCodexModelSelection(input.codexModel);
            if (codexModel && (await this.store.getSession(sessionId))?.brainProfileId !== "codex.subscription") throw new Error("CODEX_MODEL_SELECTION_INVALID");
            await this.ensureSessionHydrated(sessionId);
            const captured = await this.captureContext(sessionId);
            if (input.scriptCreation !== undefined) {
                if (captured.session.brainProfileId !== "codex.subscription") throw new Error("SCRIPT_CREATION_CODEX_SUBSCRIPTION_REQUIRED");
                this.scriptCreationScopes.set(sessionId, new ScriptCreationScope(captured.session.domainProjectId || "", input.scriptCreation));
            }
            controller.signal.throwIfAborted();
            const result = await this.manager.sendTurn(sessionId, {
                turnId: input.turnId,
                prompt: input.prompt,
                context: captured.context,
                signal: controller.signal,
                ...(codexModel ? { codexModel } : {}),
                ...(input.localImagePaths?.length ? { localImagePaths: [...input.localImagePaths] } : {}),
                ...(input.localSkills?.length ? { localSkills: input.localSkills.map((skill) => ({ ...skill })) } : {}),
            }, async (event) => emit("agent_event", event));
            controller.signal.throwIfAborted();
            receipt.status = result.status === "handoff_pending" ? "waiting_host" : result.status === "completed" ? "completed" : "failed";
            if (receipt.status !== "waiting_host") receipt.finishedAt = new Date().toISOString();
            const session = await this.store.getSession(sessionId);
            return { session: session ? { ...session, latestTurnReceipt: structuredClone(receipt) } : undefined, contextReceiptId: captured.receipt.receiptId, result };
        } catch (error) {
            if (receipt) receipt.status = controller.signal.aborted ? "cancelled" : "failed";
            if (controller.signal.aborted) {
                const current = await this.store.getSession(sessionId);
                if (current && ["running", "awaiting_confirmation"].includes(current.status)) await this.store.updateSession(sessionId, { status: "interrupted", updatedAt: new Date().toISOString() });
                throw new Error("AGENT_TURN_CANCELLED");
            }
            throw error;
        } finally {
            try {
                if (receipt) {
                    if (receipt.status !== "waiting_host") receipt.finishedAt ??= new Date().toISOString();
                    await this.store.updateSession(sessionId, { latestTurnReceipt: structuredClone(receipt) });
                }
            } finally {
                this.options.nativeConfirmations?.cancelSession(sessionId);
                this.turnReceipts.delete(sessionId);
                this.turnControllers.delete(sessionId);
                this.activeTurns.delete(sessionId);
                this.scriptCreationScopes.delete(sessionId);
            }
        }
    }

    async cancelTurn(sessionId: string, turnId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
        if (this.activeTurns.get(sessionId) !== turnId) throw new Error("AGENT_ACTIVE_TURN_MISMATCH");
        this.cancelledTurns.add(`${sessionId}:${turnId}`);
        this.turnControllers.get(sessionId)?.abort(new Error("AGENT_TURN_CANCELLED"));
        this.options.nativeConfirmations?.cancelSession(sessionId);
        this.confirmations.cancelTurn(sessionId, turnId);
        for (const [id, waiter] of this.confirmationWaiters) {
            if (waiter.sessionId !== sessionId || this.confirmations.get(id)?.turnId !== turnId) continue;
            clearTimeout(waiter.timer);
            this.confirmationWaiters.delete(id);
            waiter.reject(new Error("AGENT_TURN_CANCELLED"));
        }
        await this.registry.getAdapter(session.brainProfileId).cancelTurn(sessionId);
        return { sessionId, turnId, alreadyDispatchedWrites: "READBACK_REQUIRED" as const };
    }

    async requestTool(input: { sessionId: string; turnId?: string; toolName: string; toolInput: Record<string, unknown>; ordinaryConfirmationEnabled?: boolean }) {
        const outcome = await this.proposeTool(input);
        if (outcome.status === "completed") return outcome;
        const session = await this.store.getSession(input.sessionId);
        if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
        this.turnControllers.get(session.id)?.signal.throwIfAborted();
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
        if (this.cancelledTurns.has(`${session.id}:${turnId}`)) throw new Error("AGENT_TURN_CANCELLED");
        if (this.activeTurns.has(session.id) && this.activeTurns.get(session.id) !== turnId) throw new Error("AGENT_ACTIVE_TURN_MISMATCH");
        if (!this.activeTurns.has(session.id) && session.latestTurnReceipt?.turnId === turnId) throw new Error("AGENT_TURN_ALREADY_SUBMITTED");
        const signal = this.turnControllers.get(session.id)?.signal;
        signal?.throwIfAborted();
        const receipt = this.turnReceipts.get(session.id);
        // Persist intent before any non-read tool reaches its provider. A failed
        // or cancelled write is still uncertain and must not unlock a retry.
        if (receipt && this.tools.get(input.toolName).risk !== "read" && !receipt.writeAttempted) {
            receipt.writeAttempted = true;
            await this.store.updateSession(session.id, { latestTurnReceipt: structuredClone(receipt) });
        }
        const outcome = await this.broker.request({
            profile,
            session,
            turnId,
            toolName: input.toolName,
            input: input.toolInput,
            contextReceiptId,
            currentContext: this.snapshot(),
            ordinaryConfirmationEnabled: this.scriptCreationScopes.has(session.id)
                ? !this.scriptCreationScopes.get(session.id)!.allows(input.toolName, input.toolInput)
                : input.ordinaryConfirmationEnabled,
            signal,
        });
        if (signal?.aborted && outcome.status === "confirmation_required") {
            this.confirmations.cancelTurn(session.id, turnId);
            signal.throwIfAborted();
        }
        await this.emitBrokerOutcome(outcome, session.id, turnId);
        if (outcome.status === "completed" && input.toolName === "project_create_script" && outcome.result.outcome === "succeeded") {
            this.scriptCreationScopes.get(session.id)?.observeCreation(outcome.result.output);
        }
        if (outcome.status === "completed") return outcome;
        if (this.activeTurns.has(session.id)) await this.store.updateSession(session.id, { status: "awaiting_confirmation", updatedAt: new Date().toISOString() });
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
            if (this.activeTurns.has(session.id)) await this.store.updateSession(session.id, { status: "running", updatedAt: new Date().toISOString() });
            return outcome;
        } catch (error) {
            const failure = input.approved ? error : new Error("AGENT_TOOL_REJECTED_BY_HUMAN");
            waiter?.reject(failure instanceof Error ? failure : new Error(String(failure)));
            if (this.activeTurns.has(session.id)) await this.store.updateSession(session.id, { status: "running", updatedAt: new Date().toISOString() });
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

    private startReviewCoordinator() {
        if (process.env.FILMOS_REVIEW_CODEX_COORDINATOR_ENABLED !== "true" || !process.env.FILMOS_REVIEW_BUS_AUTH_FILE) return;
        const worktrees = ReviewWorktreeManager.fromEnvironment();
        if (!worktrees) {
            this.emit("agent_event", { type: "review.coordinator.failed", code: "REVIEW_SOURCE_REPOSITORY_NOT_CONFIGURED", at: new Date().toISOString() });
            return;
        }
        const bus = new HttpReviewBusCoordinator(process.env.FILMOS_REVIEW_BUS_BASE_URL ?? "http://127.0.0.1:17920", process.env.FILMOS_REVIEW_BUS_AUTH_FILE);
        const coordinator = new ReviewCodexCoordinator(bus, {
            ensure: async ({ issueId, projectId, canvasId, workspacePath }) => {
                const existing = (await this.store.listSessions({ projectId, brainProfileId: "codex.subscription" }))
                    .find((item) => item.conversationId === reviewConversationId(issueId) && !["closed", "failed"].includes(item.status));
                if (existing) {
                    if (existing.executionProfile !== "review_coordinator" || existing.workspacePath !== workspacePath) throw new Error("REVIEW_CODEX_SESSION_WORKSPACE_MISMATCH");
                    await this.ensureSessionHydrated(existing.id);
                    return (await this.store.getSession(existing.id)) ?? existing;
                }
                return (await this.createSession({
                    conversationId: reviewConversationId(issueId),
                    brainProfileId: "codex.subscription",
                    projectId,
                    canvasId,
                    actorId: this.actorId,
                    workspacePath,
                    executionProfile: "review_coordinator",
                })).session;
            },
            run: async (sessionId, prompt) => {
                let output = "";
                const session = await this.store.getSession(sessionId);
                if (!session) throw new Error("BRAIN_SESSION_NOT_FOUND");
                await this.sendTurn(sessionId, { turnId: reviewTurnId(session.conversationId), prompt }, (type, payload) => {
                    const event = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
                    if (type === "agent_event" && event.type === "message.delta") output += String(event.delta ?? "");
                });
                if (!output.trim()) {
                    const current = await this.store.getSession(sessionId);
                    const history = current ? await this.registry.getAdapter(current.brainProfileId).readHistory?.(current) : [];
                    output = history?.filter((item) => item.role === "assistant").at(-1)?.text ?? "";
                }
                return output;
            },
            recover: async (sessionId, attemptId) => {
                const session = await this.store.getSession(sessionId);
                if (!session) return null;
                await this.ensureSessionHydrated(sessionId);
                const current = (await this.store.getSession(sessionId)) ?? session;
                const history = await this.registry.getAdapter(current.brainProfileId).readHistory?.(current) ?? [];
                return history
                    .filter((item) => item.role === "assistant" && item.text.includes(attemptId))
                    .at(-1)?.text ?? null;
            },
        }, worktrees, () => {
            try {
                const current = this.snapshot();
                return { projectId: current.domainProjectId || current.projectId, ...(current.canvasId ? { canvasId: current.canvasId } : {}) };
            } catch {
                return {};
            }
        }, process.env.FILMOS_REVIEW_CODEX_MODEL_TURNS_ENABLED !== "false");
        const controller = new AbortController();
        this.reviewCoordinatorAbort = controller;
        void coordinator.watch(controller.signal).catch((error) => {
            if (!controller.signal.aborted) this.emit("agent_event", { type: "review.coordinator.failed", code: error instanceof Error ? error.message : "REVIEW_COORDINATOR_FAILED", at: new Date().toISOString() });
        });
    }

    private emitRecoveredHostState(previous: BrainSession, current: BrainSession) {
        const before = previous.hostHandoff;
        const after = current.hostHandoff;
        if (!after || (before?.handoffId === after.handoffId && before.status === after.status)) return;
        const at = new Date().toISOString();
        if (after.status === "host_observed") this.emit("agent_event", { type: "host.observed", sessionId: current.id, handoff: after, at });
        if (after.status === "proposal_received") this.emit("agent_event", { type: "host.proposal.received", sessionId: current.id, handoff: after, at });
        if (after.status === "expired") this.emit("agent_event", { type: "host.handoff.expired", sessionId: current.id, handoff: after, at });
    }

    private async ensureSessionHydrated(sessionId: string) {
        const active = this.sessionHydrations.get(sessionId);
        if (active) return await active;
        const hydration = this.hydrateSessionIfRequired(sessionId);
        this.sessionHydrations.set(sessionId, hydration);
        try {
            return await hydration;
        } finally {
            if (this.sessionHydrations.get(sessionId) === hydration) this.sessionHydrations.delete(sessionId);
        }
    }

    private async hydrateSessionIfRequired(sessionId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error(`Unknown brain session: ${sessionId}`);
        contextSnapshotForSession(session, this.snapshot);
        const failedNativeSession = session.brainProfileId === "codex.subscription" && session.status === "failed";
        if (failedNativeSession && !session.providerThreadId) throw new Error("AGENT_SESSION_RECOVERY_REQUIRED");
        let requiresResume = !this.hydratedSessions.has(sessionId) || failedNativeSession;
        if (!requiresResume) {
            try {
                this.grants.validate(session.permissionGrantId, {
                    sessionId,
                    connectionId: session.connectionId,
                    projectId: session.projectId,
                    workspaceId: session.workspaceId,
                });
            } catch (error) {
                if (!isRecoverableGrantLoss(error)) throw error;
                requiresResume = true;
                this.hydratedSessions.delete(sessionId);
            }
        }
        if (!requiresResume) return session;
        const resumed = await this.manager.resumeSession(sessionId, this.actorId);
        this.hydratedSessions.add(sessionId);
        return resumed;
    }

    private async emitBrokerOutcome(outcome: AgentBrokerOutcome, sessionId: string, turnId: string) {
        const at = new Date().toISOString();
        if (outcome.status === "confirmation_required") {
            this.emit("agent_event", { type: "tool.proposed", sessionId, turnId, request: outcome.request, at });
            this.emit("agent_event", { type: "confirmation.required", sessionId, turnId, confirmation: outcome.confirmation, at });
            return;
        }
        const result = outcome.result.toolName === "project_read_shot_image" ? { ...outcome.result, output: summarizeShotImage(outcome.result.output) } : outcome.result;
        this.emit("agent_event", { type: "tool.completed", sessionId, turnId, result, at });
    }

    async dispose() {
        this.reviewCoordinatorAbort?.abort(new Error("AGENT_RUNTIME_DISPOSED"));
        this.reviewCoordinatorAbort = undefined;
        for (const waiter of this.confirmationWaiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("AGENT_RUNTIME_DISPOSED"));
        }
        this.confirmationWaiters.clear();
        for (const sessionId of this.activeTurns.keys()) this.options.nativeConfirmations?.cancelSession(sessionId);
        this.activeTurns.clear();
        for (const controller of this.turnControllers.values()) controller.abort(new Error("AGENT_RUNTIME_DISPOSED"));
        this.turnControllers.clear();
        this.cancelledTurns.clear();
        this.hydratedSessions.clear();
        this.sessionHydrations.clear();
    }
}

function isRecoverableGrantLoss(error: unknown) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : String(error);
    return code === "AGENT_GRANT_NOT_FOUND" || code === "AGENT_GRANT_EXPIRED";
}

export function contextSnapshotForSession(session: BrainSession, liveSnapshot: () => WorkbenchContextSnapshot): WorkbenchContextSnapshot {
    if (session.executionProfile !== "review_coordinator") {
        const snapshot = liveSnapshot();
        assertSessionContextScope(session, snapshot);
        return snapshot;
    }
    if (session.projectId === null) throw new Error("AGENT_WORKSPACE_PROFILE_DENIED");
    const canvasStateHash = createHash("sha256")
        .update(["filmos-review-context-v1", session.projectId, session.canvasId, session.workspacePath ?? ""].join("\n"))
        .digest("hex");
    return {
        workspace: session.workspacePath,
        projectId: session.projectId,
        domainProjectId: session.projectId,
        projectTitle: `FilmOS Review ${session.projectId}`,
        projectStatus: "review_coordinator",
        canvasId: session.canvasId,
        canvasRevision: 0,
        canvasStateHash,
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        visibleNodeIds: [],
        assets: [],
        blockers: ["NO_ACTIVE_CANVAS_REQUIRED_FOR_REVIEW_COORDINATOR"],
        activePanel: "review-coordinator",
    };
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

import crypto from "node:crypto";

import type { AgentConversation, AgentEventSink, AgentTurnInput, BrainSession, CreateBrainSessionInput } from "./contracts.js";
import { AgentContextBroker } from "./context-broker.js";
import { AgentConfirmationStore } from "./confirmations.js";
import { AgentPermissionGrantStore } from "./permission-grants.js";
import { BrainProfileRegistry } from "./registry.js";
import type { BrainSessionStore } from "./session-store.js";

export class AgentSessionManager {
    constructor(
        private readonly registry: BrainProfileRegistry,
        private readonly store: BrainSessionStore,
        private readonly grants: AgentPermissionGrantStore,
        private readonly confirmations: AgentConfirmationStore,
        private readonly contexts: AgentContextBroker,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async createSession(input: CreateBrainSessionInput) {
        const profile = this.registry.getProfile(input.brainProfileId);
        if (profile.availability === "disabled") throw new Error(`BRAIN_PROFILE_DISABLED:${profile.id}`);
        const status = await this.registry.probe(profile.id);
        if (status.status !== "ready") throw new Error(`BRAIN_CONNECTION_${status.status.toUpperCase()}:${status.statusReason ?? profile.id}`);
        const createdAt = this.now().toISOString();
        const sessionId = crypto.randomUUID();
        const grant = this.grants.issue({
            sessionId,
            connectionId: profile.id,
            actorId: input.actorId,
            projectId: input.projectId,
            ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
            toolSurface: profile.toolSurface,
            allowedTools: [],
        });
        let session: BrainSession = {
            id: sessionId,
            conversationId: input.conversationId,
            brainProfileId: profile.id,
            connectionId: profile.id,
            projectId: input.projectId,
            ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
            canvasId: input.canvasId,
            ...(input.contentUnitId ? { contentUnitId: input.contentUnitId } : {}),
            ...(input.sceneId ? { sceneId: input.sceneId } : {}),
            ...(input.directorUnitId ? { directorUnitId: input.directorUnitId } : {}),
            ...(input.shotId ? { shotId: input.shotId } : {}),
            permissionGrantId: grant.id,
            status: "creating",
            createdAt,
            updatedAt: createdAt,
        };
        await this.store.saveSession(session);
        try {
            const adapterPatch = await this.registry.getAdapter(profile.id).createSession(input, grant);
            assertAdapterPatchScope(session, adapterPatch);
            session = { ...session, ...adapterPatch, id: session.id, conversationId: session.conversationId, brainProfileId: session.brainProfileId, connectionId: session.connectionId, projectId: session.projectId, canvasId: session.canvasId, permissionGrantId: session.permissionGrantId, status: "ready", updatedAt: this.now().toISOString() };
            await this.store.saveSession(session);
            await this.linkConversation(session);
            return structuredClone(session);
        } catch (error) {
            await this.store.updateSession(session.id, { status: "failed", updatedAt: this.now().toISOString() });
            this.grants.revoke(grant.id);
            throw error;
        }
    }

    async sendTurn(sessionId: string, input: Omit<AgentTurnInput, "session">, sink: AgentEventSink) {
        let session = await this.requireSession(sessionId);
        if (["closed", "creating", "failed"].includes(session.status)) throw new Error(`BRAIN_SESSION_NOT_RUNNABLE:${session.status}`);
        if (input.context.contextReceiptId !== session.lastContextReceiptId) throw new Error("AGENT_CONTEXT_NOT_BOUND_TO_SESSION");
        this.grants.validate(session.permissionGrantId, { sessionId, connectionId: session.connectionId, projectId: session.projectId });
        session = await this.store.updateSession(sessionId, { status: "running", updatedAt: this.now().toISOString() });
        try {
            const result = await this.registry.getAdapter(session.brainProfileId).sendTurn({ ...input, session }, sink);
            const status = result.status === "completed" || result.status === "handoff_pending" ? "completed" : result.status;
            await this.store.updateSession(sessionId, { status, ...(result.providerThreadId ? { providerThreadId: result.providerThreadId } : {}), updatedAt: this.now().toISOString() });
            return result;
        } catch (error) {
            await this.store.updateSession(sessionId, { status: "failed", updatedAt: this.now().toISOString() });
            throw error;
        }
    }

    async bindContextReceipt(sessionId: string, receiptId: string) {
        return await this.store.updateSession(sessionId, { lastContextReceiptId: receiptId, updatedAt: this.now().toISOString() });
    }

    async closeSession(sessionId: string) {
        const session = await this.requireSession(sessionId);
        await this.registry.getAdapter(session.brainProfileId).closeSession(sessionId);
        this.confirmations.cancelSession(sessionId);
        this.contexts.revokeSession(sessionId);
        this.grants.revokeSession(sessionId);
        return await this.store.updateSession(sessionId, { status: "closed", closedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
    }

    private async requireSession(sessionId: string) {
        const session = await this.store.getSession(sessionId);
        if (!session) throw new Error(`Unknown brain session: ${sessionId}`);
        return session;
    }

    private async linkConversation(session: BrainSession) {
        const existing = await this.store.getConversation(session.conversationId);
        const now = this.now().toISOString();
        const conversation: AgentConversation = existing ?? {
            id: session.conversationId,
            projectId: session.projectId,
            canvasId: session.canvasId,
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
        };
        if (conversation.projectId !== session.projectId || conversation.canvasId !== session.canvasId) throw new Error("AGENT_CONVERSATION_SCOPE_MISMATCH");
        if (!conversation.sessionIds.includes(session.id)) conversation.sessionIds.push(session.id);
        conversation.activeSessionId = session.id;
        conversation.updatedAt = now;
        await this.store.saveConversation(conversation);
    }
}

function assertAdapterPatchScope(session: BrainSession, patch: Partial<BrainSession>) {
    const immutable: Array<keyof BrainSession> = ["id", "conversationId", "brainProfileId", "connectionId", "projectId", "canvasId", "permissionGrantId"];
    for (const key of immutable) {
        if (patch[key] !== undefined && patch[key] !== session[key]) throw new Error(`Adapter attempted to change immutable session field: ${String(key)}`);
    }
}

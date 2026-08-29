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

export type ChatGPTHostBridgeProbe = {
    ready: boolean;
    reason?: string;
    profileId: "chatgpt.subscription.host";
    billingMode: "subscription_host_no_extra_model_api";
    modelApiAdapterAvailable: false;
    fallbackEnabled: false;
};

export type ChatGPTHostBridgeSession = {
    hostSessionId: string;
    projectGrantId: string;
    projectId: string;
    status: "waiting_for_host" | "observed" | "proposal_received" | "blocked_external_account";
    proposalHandoffEnabled: boolean;
    directApplyAvailable: false;
    externalConversationUrl?: string;
};

export type ChatGPTHostHandoff = {
    handoffId: string;
    hostSessionId: string;
    projectId: string;
    contextReceiptId: string;
    status: "waiting_for_host";
    directApplyAvailable: false;
    externalConversationUrl?: string;
};

/**
 * Narrow port owned by the existing Track 14 transport foundation. It carries
 * project-scoped grants and handoff receipts only; it is intentionally not a
 * model API client and cannot produce ChatGPT message deltas.
 */
export interface ChatGPTHostBridgeClient {
    probe(): Promise<ChatGPTHostBridgeProbe>;
    prepareSession(input: {
        brainSessionId: string;
        projectId: string;
        domainProjectId?: string;
        canvasId: string;
        contextReceiptId?: string;
        permissionGrant: AgentPermissionGrant;
    }): Promise<ChatGPTHostBridgeSession>;
    refreshSession(input: { brainSessionId: string; hostSessionId: string; projectId: string }): Promise<ChatGPTHostBridgeSession>;
    prepareHandoff(input: {
        brainSessionId: string;
        hostSessionId: string;
        projectId: string;
        contextReceiptId: string;
        prompt: string;
    }): Promise<ChatGPTHostHandoff>;
    closeSession(input: { brainSessionId: string; hostSessionId: string; projectId: string }): Promise<void>;
}

export class ChatGPTHostedAdapter implements AgentRuntimeAdapter {
    readonly connectionId = "chatgpt.subscription.host";
    readonly profileId = "chatgpt.subscription.host";

    private readonly hostSessions = new Map<string, ChatGPTHostBridgeSession>();

    constructor(private readonly bridge: ChatGPTHostBridgeClient) {}

    async probe(): Promise<BrainRuntimeStatus> {
        const checkedAt = new Date().toISOString();
        try {
            const result = await this.bridge.probe();
            assertBridgeProbe(result, this.profileId);
            return {
                profileId: this.profileId,
                status: result.ready ? "ready" : "unavailable",
                ...(result.reason ? { statusReason: result.reason } : {}),
                checkedAt,
                version: result.billingMode,
            };
        } catch (error) {
            return {
                profileId: this.profileId,
                status: "unavailable",
                statusReason: error instanceof Error ? error.message : String(error),
                checkedAt,
            };
        }
    }

    async createSession(input: CreateBrainSessionInput, grant: AgentPermissionGrant): Promise<Partial<BrainSession>> {
        assertCreateScope(input, grant, this.profileId);
        const prepared = await this.bridge.prepareSession({
            brainSessionId: grant.sessionId,
            projectId: input.projectId,
            ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
            canvasId: input.canvasId,
            permissionGrant: structuredClone(grant),
        });
        assertHostSession(prepared, input.projectId);
        this.hostSessions.set(grant.sessionId, structuredClone(prepared));
        return { providerThreadId: prepared.hostSessionId };
    }

    async resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> {
        const current = this.hostSessions.get(input.sessionId);
        const hostSessionId = input.providerThreadId || current?.hostSessionId;
        if (!current || !hostSessionId) throw new Error("CHATGPT_HOST_SESSION_CONTEXT_MISSING");
        const refreshed = await this.bridge.refreshSession({
            brainSessionId: input.sessionId,
            hostSessionId,
            projectId: current.projectId,
        });
        assertHostSession(refreshed, current.projectId, hostSessionId);
        this.hostSessions.set(input.sessionId, structuredClone(refreshed));
        return { providerThreadId: refreshed.hostSessionId };
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        const host = this.hostSessions.get(input.session.id);
        if (!host) throw new Error("CHATGPT_HOST_SESSION_CONTEXT_MISSING");
        if (input.session.brainProfileId !== this.profileId || input.session.connectionId !== this.connectionId) {
            throw new Error("CHATGPT_HOST_PROFILE_SCOPE_MISMATCH");
        }
        if (host.projectId !== input.session.projectId) throw new Error("CHATGPT_HOST_PROJECT_SCOPE_MISMATCH");
        if (!input.context.contextReceiptId.trim()) throw new Error("CHATGPT_HOST_CONTEXT_RECEIPT_REQUIRED");

        const at = new Date().toISOString();
        await sink({ type: "turn.started", sessionId: input.session.id, turnId: input.turnId, at });
        const handoff = await this.bridge.prepareHandoff({
            brainSessionId: input.session.id,
            hostSessionId: host.hostSessionId,
            projectId: host.projectId,
            contextReceiptId: input.context.contextReceiptId,
            prompt: input.prompt,
        });
        assertHandoff(handoff, host, input.context.contextReceiptId);
        await sink({ type: "turn.completed", sessionId: input.session.id, turnId: input.turnId, at: new Date().toISOString() });
        return {
            sessionId: input.session.id,
            turnId: input.turnId,
            providerThreadId: host.hostSessionId,
            text: "ChatGPT Host Handoff 已准备；对话在 ChatGPT 官方宿主中继续。",
            status: "handoff_pending" as const,
        };
    }

    async cancelTurn(_sessionId: string): Promise<void> {
        throw new Error("CHATGPT_HOST_TURN_NOT_CANCELLABLE");
    }

    async closeSession(sessionId: string): Promise<void> {
        const current = this.hostSessions.get(sessionId);
        if (!current) return;
        this.hostSessions.delete(sessionId);
        await this.bridge.closeSession({ brainSessionId: sessionId, hostSessionId: current.hostSessionId, projectId: current.projectId });
    }
}

function assertCreateScope(input: CreateBrainSessionInput, grant: AgentPermissionGrant, profileId: string) {
    if (input.brainProfileId !== profileId) throw new Error("CHATGPT_HOST_PROFILE_NOT_SELECTED");
    if (!input.projectId.trim() || !input.canvasId.trim()) throw new Error("CHATGPT_HOST_REAL_PROJECT_CONTEXT_REQUIRED");
    if (grant.sessionId.trim() === "" || grant.connectionId !== profileId || grant.projectId !== input.projectId) {
        throw new Error("CHATGPT_HOST_GRANT_SCOPE_MISMATCH");
    }
    if (grant.toolSurface !== "chatgpt_hosted") throw new Error("CHATGPT_HOST_TOOL_SURFACE_REQUIRED");
}

function assertBridgeProbe(value: ChatGPTHostBridgeProbe, profileId: string) {
    if (value.profileId !== profileId
        || value.billingMode !== "subscription_host_no_extra_model_api"
        || value.modelApiAdapterAvailable !== false
        || value.fallbackEnabled !== false) {
        throw new Error("CHATGPT_HOST_BILLING_BOUNDARY_INVALID");
    }
}

function assertHostSession(value: ChatGPTHostBridgeSession, projectId: string, expectedHostSessionId?: string) {
    if (!value.hostSessionId.trim() || !value.projectGrantId.trim()) throw new Error("CHATGPT_HOST_SESSION_RECEIPT_INVALID");
    if (value.projectId !== projectId) throw new Error("CHATGPT_HOST_PROJECT_SCOPE_MISMATCH");
    if (expectedHostSessionId && value.hostSessionId !== expectedHostSessionId) throw new Error("CHATGPT_HOST_SESSION_SCOPE_MISMATCH");
    if (value.directApplyAvailable !== false) throw new Error("CHATGPT_HOST_DIRECT_APPLY_FORBIDDEN");
}

function assertHandoff(value: ChatGPTHostHandoff, host: ChatGPTHostBridgeSession, contextReceiptId: string) {
    if (!value.handoffId.trim() || value.status !== "waiting_for_host") throw new Error("CHATGPT_HOST_HANDOFF_RECEIPT_INVALID");
    if (value.hostSessionId !== host.hostSessionId || value.projectId !== host.projectId || value.contextReceiptId !== contextReceiptId) {
        throw new Error("CHATGPT_HOST_HANDOFF_SCOPE_MISMATCH");
    }
    if (value.directApplyAvailable !== false) throw new Error("CHATGPT_HOST_DIRECT_APPLY_FORBIDDEN");
}

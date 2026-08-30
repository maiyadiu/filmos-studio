import type {
    AgentEventSink,
    AgentHistoryMessage,
    AgentPermissionGrant,
    AgentRuntimeAdapter,
    AgentTurnInput,
    BrainRuntimeStatus,
    BrainSession,
    ChatGPTHandoffReceipt,
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
    observedAt?: string;
    proposalReceivedAt?: string;
    observedHandoffId?: string;
};

export type ChatGPTHostBridgeHandoff = {
    handoffId: string;
    hostSessionId: string;
    projectId: string;
    contextReceiptId: string;
    status: "waiting_for_host";
    directApplyAvailable: false;
    createdAt: string;
    expiresAt: string;
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
    refreshSession(input: {
        brainSessionId: string;
        hostSessionId: string;
        projectId: string;
        domainProjectId?: string;
        canvasId: string;
        permissionGrant: AgentPermissionGrant;
        hostHandoff?: ChatGPTHandoffReceipt;
    }): Promise<ChatGPTHostBridgeSession>;
    prepareHandoff(input: {
        brainSessionId: string;
        hostSessionId: string;
        projectId: string;
        turnId: string;
        contextReceiptId: string;
        prompt: string;
        context: AgentTurnInput["context"];
    }): Promise<ChatGPTHostBridgeHandoff>;
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
        const hostProjectId = input.domainProjectId || input.projectId;
        const prepared = await this.bridge.prepareSession({
            brainSessionId: grant.sessionId,
            projectId: input.projectId,
            ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
            canvasId: input.canvasId,
            permissionGrant: structuredClone(grant),
        });
        assertHostSession(prepared, hostProjectId);
        this.hostSessions.set(grant.sessionId, structuredClone(prepared));
        return { providerThreadId: prepared.hostSessionId };
    }

    async resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> {
        const hostSessionId = input.providerThreadId || this.hostSessions.get(input.sessionId)?.hostSessionId;
        const projectId = requiredResumeField(input.projectId, "projectId");
        const canvasId = requiredResumeField(input.canvasId, "canvasId");
        const grant = input.grant;
        if (!hostSessionId || !grant) throw new Error("CHATGPT_HOST_SESSION_CONTEXT_MISSING");
        assertResumeScope(input, grant, this.profileId);
        const hostProjectId = input.domainProjectId || projectId;
        const refreshed = await this.bridge.refreshSession({
            brainSessionId: input.sessionId,
            hostSessionId,
            projectId,
            ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
            canvasId,
            permissionGrant: structuredClone(grant),
            ...(input.hostHandoff ? { hostHandoff: structuredClone(input.hostHandoff) } : {}),
        });
        assertHostSession(refreshed, hostProjectId, hostSessionId);
        this.hostSessions.set(input.sessionId, structuredClone(refreshed));
        return {
            providerThreadId: refreshed.hostSessionId,
            ...(input.hostHandoff ? { hostHandoff: recoverHandoff(input.hostHandoff, refreshed) } : {}),
        };
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        const host = this.hostSessions.get(input.session.id);
        if (!host) throw new Error("CHATGPT_HOST_SESSION_CONTEXT_MISSING");
        if (input.session.brainProfileId !== this.profileId || input.session.connectionId !== this.connectionId) {
            throw new Error("CHATGPT_HOST_PROFILE_SCOPE_MISMATCH");
        }
        if (host.projectId !== (input.session.domainProjectId || input.session.projectId)) throw new Error("CHATGPT_HOST_PROJECT_SCOPE_MISMATCH");
        if (!input.context.contextReceiptId.trim()) throw new Error("CHATGPT_HOST_CONTEXT_RECEIPT_REQUIRED");

        const at = new Date().toISOString();
        await sink({ type: "turn.started", sessionId: input.session.id, turnId: input.turnId, at });
        const handoff = await this.bridge.prepareHandoff({
            brainSessionId: input.session.id,
            hostSessionId: host.hostSessionId,
            projectId: host.projectId,
            turnId: input.turnId,
            contextReceiptId: input.context.contextReceiptId,
            prompt: input.prompt,
            context: structuredClone(input.context),
        });
        assertHandoff(handoff, host, input.context.contextReceiptId);
        const receipt: ChatGPTHandoffReceipt = {
            handoffId: handoff.handoffId,
            hostSessionId: handoff.hostSessionId,
            projectId: handoff.projectId,
            contextReceiptId: handoff.contextReceiptId,
            createdAt: handoff.createdAt,
            expiresAt: handoff.expiresAt,
            status: "waiting_host",
            ...(handoff.externalConversationUrl ? { externalConversationUrl: handoff.externalConversationUrl } : {}),
        };
        await sink({ type: "host.handoff.prepared", sessionId: input.session.id, turnId: input.turnId, handoff: receipt, at: new Date().toISOString() });
        return {
            sessionId: input.session.id,
            turnId: input.turnId,
            providerThreadId: host.hostSessionId,
            status: "handoff_pending" as const,
            handoff: receipt,
        };
    }

    async readHistory(session: BrainSession): Promise<AgentHistoryMessage[]> {
        return (session.hostHandoffTimeline ?? []).map((entry, index) => ({
            id: `chatgpt-handoff:${entry.handoffId}:${entry.status}:${index}`,
            role: "system",
            title: "ChatGPT Handoff",
            text: handoffTimelineText(entry),
            detail: { kind: "chatgpt_handoff", ...structuredClone(entry) },
            at: entry.recordedAt,
            source: "handoff_timeline",
        }));
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

function assertResumeScope(input: ResumeBrainSessionInput, grant: AgentPermissionGrant, profileId: string) {
    if (grant.sessionId !== input.sessionId || grant.connectionId !== profileId || grant.projectId !== input.projectId) {
        throw new Error("CHATGPT_HOST_GRANT_SCOPE_MISMATCH");
    }
    if ((grant.domainProjectId || undefined) !== (input.domainProjectId || undefined)) throw new Error("CHATGPT_HOST_PROJECT_SCOPE_MISMATCH");
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

function assertHandoff(value: ChatGPTHostBridgeHandoff, host: ChatGPTHostBridgeSession, contextReceiptId: string) {
    if (!value.handoffId.trim() || value.status !== "waiting_for_host") throw new Error("CHATGPT_HOST_HANDOFF_RECEIPT_INVALID");
    if (value.hostSessionId !== host.hostSessionId || value.projectId !== host.projectId || value.contextReceiptId !== contextReceiptId) {
        throw new Error("CHATGPT_HOST_HANDOFF_SCOPE_MISMATCH");
    }
    if (value.directApplyAvailable !== false) throw new Error("CHATGPT_HOST_DIRECT_APPLY_FORBIDDEN");
    if (!validIso(value.createdAt) || !validIso(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) throw new Error("CHATGPT_HOST_HANDOFF_EXPIRY_INVALID");
}

function recoverHandoff(current: ChatGPTHandoffReceipt, host: ChatGPTHostBridgeSession): ChatGPTHandoffReceipt {
    const now = Date.now();
    if (Date.parse(current.expiresAt) <= now) return { ...current, status: "expired" };
    if (host.observedHandoffId !== current.handoffId) return structuredClone(current);
    if (host.status === "proposal_received" && atOrAfter(host.proposalReceivedAt, current.createdAt)) return { ...current, status: "proposal_received" };
    if (host.status === "observed" && atOrAfter(host.observedAt, current.createdAt)) return { ...current, status: "host_observed" };
    return structuredClone(current);
}

function handoffTimelineText(entry: ChatGPTHandoffReceipt) {
    const receipt = `Handoff ${entry.handoffId} · 项目 ${entry.projectId} · Context ${entry.contextReceiptId} · 至 ${entry.expiresAt}`;
    if (entry.status === "host_observed") return `ChatGPT 已读取。${receipt}`;
    if (entry.status === "proposal_received") return `ChatGPT Proposal 已返回，可进入 Preview。${receipt}`;
    if (entry.status === "expired") return `Handoff 已过期，可重新发送。${receipt}`;
    return `已准备 Handoff，等待 ChatGPT 接管。${receipt}`;
}

function requiredResumeField(value: string | undefined, field: string) {
    if (!value?.trim()) throw new Error(`CHATGPT_HOST_RESUME_SCOPE_REQUIRED:${field}`);
    return value.trim();
}

function validIso(value: string) { return Number.isFinite(Date.parse(value)); }
function atOrAfter(value: string | undefined, minimum: string) { return Boolean(value && validIso(value) && Date.parse(value) >= Date.parse(minimum)); }

import type {
    AgentEventSink,
    AgentTurnInput,
    AgentTurnResult,
    BrainRuntimeStatus,
    CreateBrainSessionInput,
    ResumeBrainSessionInput,
} from "./contracts.js";
import type { ModelApiCompatibilityPort } from "./adapters/model-api-brain-adapter.js";
import type {
    ChatGPTHostBridgeClient,
    ChatGPTHostBridgeHandoff,
    ChatGPTHostBridgeProbe,
    ChatGPTHostBridgeSession,
} from "./adapters/chatgpt-hosted-adapter.js";

export type BrowserRuntimeChannel = "model" | "chatgpt_host";

export type BrowserRuntimeRequest = {
    channel: BrowserRuntimeChannel;
    operation: "probe" | "create_session" | "resume_session" | "send_turn" | "cancel_turn" | "close_session" | "prepare_handoff";
    profileId: string;
    sessionId?: string;
    turnId?: string;
    payload: Record<string, unknown>;
};

/**
 * Signed browser bridge owned by the Local Runtime SSE connection. The bridge
 * transports request-scoped identities and normalized results only; it never
 * receives or persists API credentials.
 */
export interface BrowserRuntimeTransport {
    hasConnectedBrowser(): boolean;
    request<T>(input: BrowserRuntimeRequest): Promise<T>;
}

export class BrowserModelRuntimePort implements ModelApiCompatibilityPort {
    constructor(private readonly transport: BrowserRuntimeTransport) {}

    async probe(profileId: string) {
        if (!this.transport.hasConnectedBrowser()) {
            return { status: "unavailable" as const, statusReason: "当前 FilmOS Web Client 未连接" };
        }
        return await this.transport.request<Omit<BrainRuntimeStatus, "profileId" | "checkedAt">>({
            channel: "model",
            operation: "probe",
            profileId,
            payload: {},
        });
    }

    async createSession(input: CreateBrainSessionInput, brainSessionId: string) {
        return await this.transport.request<{ providerThreadId?: string }>({
            channel: "model",
            operation: "create_session",
            profileId: input.brainProfileId,
            sessionId: brainSessionId,
            payload: { input },
        });
    }

    async resumeSession(input: ResumeBrainSessionInput, profileId: string) {
        return await this.transport.request<{ providerThreadId?: string }>({
            channel: "model",
            operation: "resume_session",
            profileId,
            sessionId: input.sessionId,
            payload: { input },
        });
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink): Promise<AgentTurnResult> {
        const result = await this.transport.request<{ result: AgentTurnResult; events?: unknown[] }>({
            channel: "model",
            operation: "send_turn",
            profileId: input.session.brainProfileId,
            sessionId: input.session.id,
            turnId: input.turnId,
            payload: {
                session: input.session,
                turnId: input.turnId,
                prompt: input.prompt,
                context: input.context,
                localImagePaths: input.localImagePaths ?? [],
                localSkills: input.localSkills ?? [],
            },
        });
        for (const event of result.events ?? []) await sink(event as Parameters<AgentEventSink>[0]);
        return result.result;
    }

    async cancelTurn(sessionId: string, profileId: string) {
        await this.transport.request({ channel: "model", operation: "cancel_turn", profileId, sessionId, payload: {} });
    }

    async closeSession(sessionId: string, profileId: string) {
        await this.transport.request({ channel: "model", operation: "close_session", profileId, sessionId, payload: {} });
    }
}

export class BrowserChatGPTHostBridgeClient implements ChatGPTHostBridgeClient {
    constructor(private readonly transport: BrowserRuntimeTransport) {}

    async probe(): Promise<ChatGPTHostBridgeProbe> {
        if (!this.transport.hasConnectedBrowser()) {
            return {
                ready: false,
                reason: "当前 FilmOS Web Client 未连接",
                profileId: "chatgpt.subscription.host",
                billingMode: "subscription_host_no_extra_model_api",
                modelApiAdapterAvailable: false,
                fallbackEnabled: false,
            };
        }
        return await this.transport.request({ channel: "chatgpt_host", operation: "probe", profileId: "chatgpt.subscription.host", payload: {} });
    }

    async prepareSession(input: Parameters<ChatGPTHostBridgeClient["prepareSession"]>[0]): Promise<ChatGPTHostBridgeSession> {
        const { permissionGrant: _permissionGrant, ...scopedInput } = input;
        return await this.transport.request({
            channel: "chatgpt_host",
            operation: "create_session",
            profileId: "chatgpt.subscription.host",
            sessionId: input.brainSessionId,
            payload: { input: scopedInput },
        });
    }

    async refreshSession(input: Parameters<ChatGPTHostBridgeClient["refreshSession"]>[0]): Promise<ChatGPTHostBridgeSession> {
        const { permissionGrant, ...scopedInput } = input;
        return await this.transport.request({
            channel: "chatgpt_host",
            operation: "resume_session",
            profileId: "chatgpt.subscription.host",
            sessionId: input.brainSessionId,
            payload: {
                input: {
                    ...scopedInput,
                    agentGrant: {
                        id: permissionGrant.id,
                        sessionId: permissionGrant.sessionId,
                        connectionId: permissionGrant.connectionId,
                        projectId: permissionGrant.projectId,
                        ...(permissionGrant.domainProjectId ? { domainProjectId: permissionGrant.domainProjectId } : {}),
                        expiresAt: permissionGrant.expiresAt,
                        keyId: permissionGrant.keyId,
                    },
                },
            },
        });
    }

    async prepareHandoff(input: Parameters<ChatGPTHostBridgeClient["prepareHandoff"]>[0]): Promise<ChatGPTHostBridgeHandoff> {
        return await this.transport.request({
            channel: "chatgpt_host",
            operation: "prepare_handoff",
            profileId: "chatgpt.subscription.host",
            sessionId: input.brainSessionId,
            payload: { input },
        });
    }

    async closeSession(input: Parameters<ChatGPTHostBridgeClient["closeSession"]>[0]) {
        await this.transport.request({
            channel: "chatgpt_host",
            operation: "close_session",
            profileId: "chatgpt.subscription.host",
            sessionId: input.brainSessionId,
            payload: { input },
        });
    }
}

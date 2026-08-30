import type {
    AgentEventSink,
    AgentPermissionGrant,
    AgentRuntimeAdapter,
    AgentTurnInput,
    AgentTurnResult,
    BrainRuntimeStatus,
    BrainSession,
    CreateBrainSessionInput,
    ResumeBrainSessionInput,
} from "../contracts.js";

export type BrowserModelRuntimePort = {
    probe(profileId: string): Promise<Omit<BrainRuntimeStatus, "profileId" | "checkedAt">>;
    createSession(input: CreateBrainSessionInput, brainSessionId: string): Promise<{ providerThreadId?: string }>;
    resumeSession(input: ResumeBrainSessionInput, profileId: string): Promise<{ providerThreadId?: string }>;
    sendTurn(input: AgentTurnInput, sink: AgentEventSink): Promise<AgentTurnResult>;
    cancelTurn(sessionId: string, profileId: string): Promise<void>;
    closeSession(sessionId: string, profileId: string): Promise<void>;
};

/** @deprecated Use BrowserModelRuntimePort. */
export type ModelApiCompatibilityPort = BrowserModelRuntimePort;

export type ModelApiBrainAdapterOptions = {
    profileId: string;
    port: BrowserModelRuntimePort;
    explicitlyEnabled: () => boolean;
};

/**
 * Compatibility adapter for the existing browser/backend model-channel runtime.
 * It deliberately receives no Codex subscription adapter and has no fallback
 * routing: the metered port is reachable only after its own profile is selected.
 */
export class ModelApiBrainAdapter implements AgentRuntimeAdapter {
    readonly connectionId: string;
    readonly profileId: string;

    constructor(private readonly options: ModelApiBrainAdapterOptions) {
        if (!isApiProfile(options.profileId)) throw new Error(`MODEL_API_PROFILE_INVALID:${options.profileId}`);
        this.connectionId = options.profileId;
        this.profileId = options.profileId;
    }

    async probe(): Promise<BrainRuntimeStatus> {
        const checkedAt = new Date().toISOString();
        if (!this.options.explicitlyEnabled()) {
            return { profileId: this.profileId, status: "unavailable", statusReason: "API Profile 未显式启用，不会产生 API 调用", checkedAt };
        }
        return { profileId: this.profileId, checkedAt, ...(await this.options.port.probe(this.profileId)) };
    }

    async createSession(input: CreateBrainSessionInput, grant: AgentPermissionGrant): Promise<Partial<BrainSession>> {
        this.assertExplicitSelection(input.brainProfileId);
        if (!grant.sessionId.trim() || grant.connectionId !== this.profileId) throw new Error(`MODEL_API_GRANT_SCOPE_MISMATCH:${this.profileId}`);
        return await this.options.port.createSession(input, grant.sessionId);
    }

    async resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> {
        this.assertEnabled();
        return await this.options.port.resumeSession(input, this.profileId);
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        this.assertExplicitSelection(input.session.brainProfileId);
        return await this.options.port.sendTurn(input, sink);
    }

    async cancelTurn(sessionId: string) {
        this.assertEnabled();
        await this.options.port.cancelTurn(sessionId, this.profileId);
    }

    async closeSession(sessionId: string) {
        await this.options.port.closeSession(sessionId, this.profileId);
    }

    private assertExplicitSelection(selectedProfileId: string) {
        this.assertEnabled();
        if (selectedProfileId !== this.profileId) throw new Error(`MODEL_API_PROFILE_NOT_SELECTED:${this.profileId}`);
    }

    private assertEnabled() {
        if (!this.options.explicitlyEnabled()) throw new Error(`MODEL_API_EXPLICIT_ENABLE_REQUIRED:${this.profileId}`);
    }
}

function isApiProfile(profileId: string) {
    return profileId === "openai.api" || profileId === "anthropic.api" || profileId === "deepseek.api" || profileId.startsWith("custom.");
}

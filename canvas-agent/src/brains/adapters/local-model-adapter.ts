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
import type { BrowserModelRuntimePort } from "./model-api-brain-adapter.js";

export class LocalModelAdapter implements AgentRuntimeAdapter {
    readonly connectionId = "local.model";
    readonly profileId = "local.model";

    constructor(private readonly port: BrowserModelRuntimePort) {}

    async probe(): Promise<BrainRuntimeStatus> {
        return { profileId: this.profileId, checkedAt: new Date().toISOString(), ...(await this.port.probe(this.profileId)) };
    }

    async createSession(input: CreateBrainSessionInput, grant: AgentPermissionGrant): Promise<Partial<BrainSession>> {
        if (input.brainProfileId !== this.profileId) throw new Error("LOCAL_MODEL_PROFILE_NOT_SELECTED");
        if (!grant.sessionId.trim() || grant.connectionId !== this.profileId) throw new Error("LOCAL_MODEL_GRANT_SCOPE_MISMATCH");
        return await this.port.createSession(input, grant.sessionId);
    }

    async resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> {
        return await this.port.resumeSession(input, this.profileId);
    }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        if (input.session.brainProfileId !== this.profileId) throw new Error("LOCAL_MODEL_PROFILE_NOT_SELECTED");
        return await this.port.sendTurn(input, sink);
    }

    async cancelTurn(sessionId: string) { await this.port.cancelTurn(sessionId, this.profileId); }
    async closeSession(sessionId: string) { await this.port.closeSession(sessionId, this.profileId); }
}

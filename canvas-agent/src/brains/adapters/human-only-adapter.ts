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

export class HumanOnlyAdapter implements AgentRuntimeAdapter {
    readonly connectionId = "human.only";
    readonly profileId = "human.only";

    async probe(): Promise<BrainRuntimeStatus> {
        return { profileId: this.profileId, status: "ready", statusReason: "仅执行人工审批，不运行模型", checkedAt: new Date().toISOString() };
    }

    async createSession(input: CreateBrainSessionInput, grant: AgentPermissionGrant): Promise<Partial<BrainSession>> {
        if (input.brainProfileId !== this.profileId || grant.connectionId !== this.profileId) throw new Error("HUMAN_ONLY_PROFILE_SCOPE_MISMATCH");
        return {};
    }

    async resumeSession(_input: ResumeBrainSessionInput): Promise<Partial<BrainSession>> { return {}; }

    async sendTurn(input: AgentTurnInput, sink: AgentEventSink) {
        const at = new Date().toISOString();
        await sink({ type: "turn.started", sessionId: input.session.id, turnId: input.turnId, at });
        await sink({ type: "message.completed", sessionId: input.session.id, turnId: input.turnId, text: "Human Only 不运行模型；请在统一确认界面审阅待处理动作。", at: new Date().toISOString() });
        await sink({ type: "turn.completed", sessionId: input.session.id, turnId: input.turnId, at: new Date().toISOString() });
        return { sessionId: input.session.id, turnId: input.turnId, text: "Human Only", status: "completed" as const };
    }

    async cancelTurn(_sessionId: string) { throw new Error("HUMAN_ONLY_TURN_NOT_RUNNING"); }
    async closeSession(_sessionId: string) { /* no provider state */ }
}

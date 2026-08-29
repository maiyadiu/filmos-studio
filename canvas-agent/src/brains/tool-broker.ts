import crypto from "node:crypto";

import type {
    AgentConfirmation,
    AgentToolManifest,
    AgentToolRequest,
    AgentToolResult,
    BrainProfile,
    BrainSession,
} from "./contracts.js";
import { agentAuditRecord, type AgentAuditSink } from "./agent-audit.js";
import { AgentConfirmationStore } from "./confirmations.js";
import type { WorkbenchContextSnapshot } from "./context-broker.js";
import { AgentPermissionGrantStore } from "./permission-grants.js";
import { AgentPolicyGateway } from "./policy-gateway.js";
import { CanonicalAgentToolManifest } from "./tool-manifest.js";

export type CanonicalAgentToolProvider = {
    execute(input: {
        request: AgentToolRequest;
        manifest: AgentToolManifest;
        session: BrainSession;
        profile: BrainProfile;
    }): Promise<{ output: unknown; postcondition?: Record<string, unknown> }>;
    verifyPostcondition?(input: {
        request: AgentToolRequest;
        postcondition: Record<string, unknown>;
        session: BrainSession;
    }): Promise<boolean>;
};

type ProposalInput = {
    profile: BrainProfile;
    session: BrainSession;
    turnId: string;
    toolName: string;
    input: Record<string, unknown>;
    contextReceiptId: string;
    currentContext: Pick<WorkbenchContextSnapshot, "projectId" | "canvasId" | "canvasRevision" | "canvasStateHash" | "filmExpectedVersion" | "filmContentHash">;
    ordinaryConfirmationEnabled?: boolean;
};

type PendingProposal = ProposalInput & { request: AgentToolRequest; manifest: AgentToolManifest };

export type AgentBrokerOutcome =
    | { status: "confirmation_required"; request: AgentToolRequest; confirmation: AgentConfirmation }
    | { status: "completed"; request: AgentToolRequest; result: AgentToolResult };

export class CanonicalAgentToolBroker {
    private readonly providers = new Map<string, CanonicalAgentToolProvider>();
    private readonly pending = new Map<string, PendingProposal>();
    private readonly consumedRequestIds = new Set<string>();

    constructor(
        private readonly manifest: CanonicalAgentToolManifest,
        private readonly grants: AgentPermissionGrantStore,
        private readonly confirmations: AgentConfirmationStore,
        private readonly policy: AgentPolicyGateway,
        private readonly audit: AgentAuditSink,
    ) {}

    register(toolName: string, provider: CanonicalAgentToolProvider) {
        this.manifest.get(toolName);
        if (this.providers.has(toolName)) throw new Error(`AGENT_TOOL_PROVIDER_DUPLICATE:${toolName}`);
        this.providers.set(toolName, provider);
    }

    async request(input: ProposalInput): Promise<AgentBrokerOutcome> {
        const manifest = this.manifest.get(input.toolName);
        const request: AgentToolRequest = {
            requestId: crypto.randomUUID(),
            sessionId: input.session.id,
            turnId: input.turnId,
            connectionId: input.session.connectionId,
            projectId: input.session.projectId,
            toolName: manifest.name,
            input: structuredClone(input.input),
            contextReceiptId: input.contextReceiptId,
            proposedAt: new Date().toISOString(),
        };
        try {
            this.validate({ ...input, request, manifest });
        } catch (error) {
            const code = errorCode(error);
            await this.audit.append(agentAuditRecord({ request, manifest, profile: input.profile, session: input.session, outcome: staleCode(code) ? "stale" : "rejected", errorCode: code }));
            throw error;
        }
        await this.audit.append(agentAuditRecord({ request, manifest, profile: input.profile, session: input.session, outcome: "proposed" }));
        if (!this.policy.requiresConfirmation(manifest, input.ordinaryConfirmationEnabled ?? true)) {
            return await this.execute({ ...input, request, manifest });
        }
        const confirmation = this.confirmations.create({
            sessionId: input.session.id,
            turnId: input.turnId,
            requestId: request.requestId,
            toolName: manifest.name,
            risk: manifest.risk as Exclude<AgentToolManifest["risk"], "read" | "draft">,
            title: manifest.title,
            summary: manifest.description,
            impact: [input.session.projectId, input.session.canvasId, manifest.name],
            contextReceiptId: input.contextReceiptId,
            ...(manifest.mayCreateCharges ? { costPreview: { note: "该动作可能产生额外 Provider/API 费用；执行前必须人工确认。" } } : {}),
        });
        this.pending.set(confirmation.id, { ...input, request, manifest });
        await this.audit.append(agentAuditRecord({ request, manifest, profile: input.profile, session: input.session, outcome: "confirmation_required", confirmationId: confirmation.id }));
        return { status: "confirmation_required", request, confirmation };
    }

    async executeConfirmed(input: {
        confirmationId: string;
        profile: BrainProfile;
        session: BrainSession;
        currentContext: ProposalInput["currentContext"];
    }): Promise<AgentBrokerOutcome> {
        const pending = this.pending.get(input.confirmationId);
        if (!pending) throw new Error("AGENT_TOOL_PENDING_PROPOSAL_NOT_FOUND");
        if (pending.profile.id !== input.profile.id || pending.session.id !== input.session.id) throw new Error("AGENT_TOOL_PENDING_SCOPE_MISMATCH");
        let confirmation: AgentConfirmation;
        try {
            confirmation = this.confirmations.consume(input.confirmationId, {
                sessionId: input.session.id,
                contextReceiptId: pending.request.contextReceiptId,
            });
        } catch (error) {
            const status = this.confirmations.get(input.confirmationId)?.status;
            if (["rejected", "expired", "cancelled"].includes(status || "")) this.pending.delete(input.confirmationId);
            await this.audit.append(agentAuditRecord({ request: pending.request, manifest: pending.manifest, profile: input.profile, session: input.session, outcome: "rejected", confirmationId: input.confirmationId, errorCode: errorCode(error) }));
            throw error;
        }
        this.policy.validateConfirmation(confirmation, pending.request, input.session);
        this.pending.delete(input.confirmationId);
        return await this.execute({ ...pending, profile: input.profile, session: input.session, currentContext: input.currentContext }, confirmation);
    }

    private validate(input: PendingProposal) {
        const grant = this.grants.get(input.session.permissionGrantId);
        if (!grant) throw new Error("AGENT_GRANT_NOT_FOUND");
        this.policy.validate({
            profile: input.profile,
            session: input.session,
            grant,
            request: input.request,
            manifest: input.manifest,
            currentContext: input.currentContext,
        });
    }

    private async execute(input: PendingProposal, confirmation?: AgentConfirmation): Promise<AgentBrokerOutcome> {
        try {
            if (this.consumedRequestIds.has(input.request.requestId)) throw new Error("AGENT_TOOL_REQUEST_REPLAYED");
            this.validate(input);
            const provider = this.providers.get(input.manifest.name);
            if (!provider) throw new Error(`AGENT_TOOL_PROVIDER_UNAVAILABLE:${input.manifest.name}`);
            this.consumedRequestIds.add(input.request.requestId);
            const executed = await provider.execute({ request: input.request, manifest: input.manifest, session: input.session, profile: input.profile });
            if (!["read", "draft"].includes(input.manifest.risk) && !executed.postcondition) throw new Error("AGENT_TOOL_POSTCONDITION_REQUIRED");
            if (executed.postcondition && provider.verifyPostcondition && !await provider.verifyPostcondition({ request: input.request, postcondition: executed.postcondition, session: input.session })) {
                throw new Error("AGENT_TOOL_POSTCONDITION_FAILED");
            }
            const result: AgentToolResult = {
                requestId: input.request.requestId,
                sessionId: input.session.id,
                toolName: input.manifest.name,
                outcome: "succeeded",
                output: executed.output,
                ...(executed.postcondition ? { postcondition: executed.postcondition } : {}),
                completedAt: new Date().toISOString(),
            };
            await this.audit.append(agentAuditRecord({
                request: input.request,
                manifest: input.manifest,
                profile: input.profile,
                session: input.session,
                outcome: "succeeded",
                result,
                ...(confirmation?.decidedBy ? { appliedBy: confirmation.decidedBy } : {}),
                ...(confirmation ? { confirmationId: confirmation.id } : {}),
            }));
            return { status: "completed", request: input.request, result };
        } catch (error) {
            const code = errorCode(error);
            const stale = staleCode(code);
            const result: AgentToolResult = {
                requestId: input.request.requestId,
                sessionId: input.session.id,
                toolName: input.manifest.name,
                outcome: stale ? "stale" : "failed",
                errorCode: code,
                errorMessage: error instanceof Error ? error.message : String(error),
                completedAt: new Date().toISOString(),
            };
            await this.audit.append(agentAuditRecord({ request: input.request, manifest: input.manifest, profile: input.profile, session: input.session, outcome: stale ? "stale" : "failed", result, errorCode: code }));
            throw error;
        }
    }
}

function staleCode(code: string) {
    return code.includes("STALE") || code.includes("CONTEXT_") || code.includes("VERSION") || code.includes("HASH");
}

function errorCode(error: unknown) {
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
    if (error instanceof Error) return error.message.split(":", 1)[0] || "AGENT_TOOL_FAILED";
    return "AGENT_TOOL_FAILED";
}

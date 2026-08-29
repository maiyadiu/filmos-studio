import type { AgentConfirmation, AgentPermissionGrant, AgentToolManifest, AgentToolRequest, BrainProfile, BrainSession } from "./contracts.js";
import type { WorkbenchContextSnapshot } from "./context-broker.js";
import { AgentContextBroker } from "./context-broker.js";
import { AgentPermissionGrantStore } from "./permission-grants.js";

export class AgentPolicyGateway {
    constructor(
        private readonly grants: AgentPermissionGrantStore,
        private readonly contexts: AgentContextBroker,
    ) {}

    validate(input: {
        profile: BrainProfile;
        session: BrainSession;
        grant: AgentPermissionGrant;
        request: AgentToolRequest;
        manifest: AgentToolManifest;
        currentContext: Pick<WorkbenchContextSnapshot, "projectId" | "canvasId" | "canvasRevision" | "canvasStateHash" | "filmExpectedVersion" | "filmContentHash">;
    }) {
        const { profile, session, grant, request, manifest } = input;
        if (profile.id !== session.brainProfileId || session.connectionId !== profile.id) throw new Error("AGENT_PROFILE_SESSION_MISMATCH");
        if (request.sessionId !== session.id || request.connectionId !== session.connectionId || request.projectId !== session.projectId) {
            throw new Error("AGENT_TOOL_REQUEST_IDENTITY_MISMATCH");
        }
        if (!manifest.surfaces.includes(profile.toolSurface) || grant.toolSurface !== profile.toolSurface) throw new Error("AGENT_TOOL_SURFACE_DENIED");
        this.grants.validate(grant.id, {
            sessionId: session.id,
            connectionId: session.connectionId,
            projectId: session.projectId,
            nonce: grant.nonce,
            toolName: manifest.name,
        });
        if (manifest.requiresFreshContext) this.contexts.validate(request.contextReceiptId, session, input.currentContext);
        if (profile.billingMode !== "metered_api" && manifest.mayCreateCharges && profile.transport === "model_api") {
            throw new Error("AGENT_BILLING_PROFILE_MISMATCH");
        }
    }

    requiresConfirmation(manifest: AgentToolManifest, ordinaryConfirmationEnabled = true) {
        if (["paid", "destructive", "approval", "publish"].includes(manifest.risk)) return true;
        return manifest.risk === "write" && ordinaryConfirmationEnabled;
    }

    validateConfirmation(confirmation: AgentConfirmation, request: AgentToolRequest, session: BrainSession) {
        if (confirmation.sessionId !== session.id || confirmation.requestId !== request.requestId || confirmation.contextReceiptId !== request.contextReceiptId) {
            throw new Error("AGENT_CONFIRMATION_SCOPE_MISMATCH");
        }
    }
}

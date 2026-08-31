import { MemoryAgentAuditSink } from "../../../canvas-agent/src/brains/agent-audit";
import { AgentConfirmationStore } from "../../../canvas-agent/src/brains/confirmations";
import { AgentContextBroker, type WorkbenchContextSnapshot } from "../../../canvas-agent/src/brains/context-broker";
import type { BrainProfile, BrainSession } from "../../../canvas-agent/src/brains/contracts";
import { AgentPermissionGrantStore } from "../../../canvas-agent/src/brains/permission-grants";
import { AgentPolicyGateway } from "../../../canvas-agent/src/brains/policy-gateway";
import { CanonicalAgentToolBroker } from "../../../canvas-agent/src/brains/tool-broker";
import { CanonicalAgentToolManifest } from "../../../canvas-agent/src/brains/tool-manifest";
import { registerProductionToolProviders, type CanonicalToolExecutionMetadata } from "../../../canvas-agent/src/brains/tool-providers";

import type { CanonicalBrokerExecutionAuthorization } from "@/film/generation-routing/canonical-tool-runtime";

export async function canonicalGenerationBrokerAuthorization(purpose: string): Promise<CanonicalBrokerExecutionAuthorization> {
    const manifest = new CanonicalAgentToolManifest();
    const grants = new AgentPermissionGrantStore();
    const confirmations = new AgentConfirmationStore();
    const contexts = new AgentContextBroker();
    const audit = new MemoryAgentAuditSink();
    const profile = humanProfile();
    const session = brainSession(purpose);
    const grant = grants.issue({
        sessionId: session.id,
        connectionId: session.connectionId,
        actorId: "human-acceptance",
        projectId: session.projectId,
        toolSurface: "workbench_operator",
        allowedTools: manifest.names("workbench_operator"),
    });
    session.permissionGrantId = grant.id;
    const snapshot = workbenchSnapshot();
    const captured = contexts.capture(session, snapshot);
    session.lastContextReceiptId = captured.receipt.receiptId;
    const broker = new CanonicalAgentToolBroker(manifest, grants, confirmations, new AgentPolicyGateway(grants, contexts), audit);
    let metadata: CanonicalToolExecutionMetadata | undefined;
    registerProductionToolProviders({
        broker,
        manifest,
        canvas: {
            callTool: async (name, _input, currentMetadata) => {
                if (name === "generation_submit") metadata = currentMetadata;
                return { ok: true, verification: { ok: true }, purpose };
            },
        },
        snapshot: () => snapshot,
        browserRuntime: { hasConnectedBrowser: () => true, request: async () => ({ ok: true }) },
    });
    const proposed = await broker.request({
        profile,
        session,
        turnId: `turn:${purpose}`,
        toolName: "generation_submit",
        input: { proposalId: `proposal:${purpose}` },
        contextReceiptId: captured.receipt.receiptId,
        currentContext: snapshot,
        ordinaryConfirmationEnabled: false,
    });
    if (proposed.status !== "confirmation_required") throw new Error("CANONICAL_BROKER_CONFIRMATION_REQUIRED");
    confirmations.decide(proposed.confirmation.id, { sessionId: session.id, actorId: "human-acceptance", approved: true });
    const completed = await broker.executeConfirmed({ confirmationId: proposed.confirmation.id, profile, session, currentContext: snapshot });
    if (completed.status !== "completed" || !metadata) throw new Error("CANONICAL_BROKER_EXECUTION_REQUIRED");
    const values = {
        confirmationId: metadata.canonicalConfirmationId,
        brokerGrantId: metadata.canonicalBrokerGrantId,
        brokerGrantContentHash: metadata.canonicalBrokerGrantContentHash,
        brokerDecisionReceiptId: metadata.canonicalBrokerDecisionReceiptId,
        brokerDecisionReceiptContentHash: metadata.canonicalBrokerDecisionReceiptContentHash,
        toolRequestId: metadata.canonicalRequestId,
        actorRef: metadata.canonicalAuthorizedByActorRef,
        confirmedAt: metadata.canonicalConfirmedAt,
    };
    if (!Object.values(values).every((value) => typeof value === "string" && value.length > 0)) throw new Error("CANONICAL_BROKER_RECEIPT_INCOMPLETE");
    return values as CanonicalBrokerExecutionAuthorization;
}

function brainSession(purpose: string): BrainSession {
    return {
        id: `session-${purpose}`,
        conversationId: `conversation-${purpose}`,
        brainProfileId: "human.only",
        connectionId: "human.only",
        projectId: "FilmOS_Acceptance_Project",
        canvasId: "acceptance-canvas",
        permissionGrantId: "pending",
        status: "ready",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function humanProfile(): BrainProfile {
    return {
        id: "human.only",
        displayName: "Human Only",
        provider: "human",
        transport: "human_only",
        authMode: "none",
        billingMode: "none",
        interactionSurface: "native_stream",
        toolSurface: "workbench_operator",
        requiresApiKey: false,
        mayCreateSeparateCharges: false,
        availability: "enabled",
        capabilities: {
            streamingChat: false,
            threadHistory: false,
            threadResume: false,
            imageInput: false,
            automaticVisualContext: false,
            mcpTools: true,
            read: true,
            preview: true,
            applyAfterHumanConfirmation: true,
            hostedProposalReturn: false,
            cancelTurn: false,
        },
    };
}

function workbenchSnapshot(): WorkbenchContextSnapshot {
    return {
        projectId: "FilmOS_Acceptance_Project",
        canvasId: "acceptance-canvas",
        canvasRevision: 1,
        canvasStateHash: "a".repeat(64),
        nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [],
    };
}

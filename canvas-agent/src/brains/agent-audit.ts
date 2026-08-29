import { canonicalize } from "json-canonicalize";
import crypto from "node:crypto";

import type { AgentToolManifest, AgentToolRequest, AgentToolResult, BrainProfile, BrainSession } from "./contracts.js";

export type AgentAuditOutcome = "proposed" | "confirmation_required" | "succeeded" | "rejected" | "failed" | "stale";

export type AgentAuditRecord = {
    eventId: string;
    recordedAt: string;
    requestId: string;
    sessionId: string;
    turnId: string;
    projectId: string;
    connectionId: string;
    profileId: string;
    transport: BrainProfile["transport"];
    billingMode: BrainProfile["billingMode"];
    interactionSurface: BrainProfile["interactionSurface"];
    toolName: string;
    toolRisk: AgentToolManifest["risk"];
    contextReceiptId: string;
    proposedBy: { kind: "brain"; profileId: string; sessionId: string };
    appliedBy: { kind: "human"; actorId: string } | null;
    outcome: AgentAuditOutcome;
    inputHash: string;
    outputHash: string | null;
    confirmationId: string | null;
    errorCode: string | null;
};

export interface AgentAuditSink {
    append(record: AgentAuditRecord): Promise<void>;
}

export class MemoryAgentAuditSink implements AgentAuditSink {
    readonly records: AgentAuditRecord[] = [];
    async append(record: AgentAuditRecord) { this.records.push(structuredClone(record)); }
}

export function agentAuditRecord(input: {
    request: AgentToolRequest;
    manifest: AgentToolManifest;
    profile: BrainProfile;
    session: BrainSession;
    outcome: AgentAuditOutcome;
    result?: AgentToolResult;
    confirmationId?: string;
    appliedBy?: string;
    errorCode?: string;
}): AgentAuditRecord {
    return {
        eventId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        requestId: input.request.requestId,
        sessionId: input.session.id,
        turnId: input.request.turnId,
        projectId: input.session.projectId,
        connectionId: input.session.connectionId,
        profileId: input.profile.id,
        transport: input.profile.transport,
        billingMode: input.profile.billingMode,
        interactionSurface: input.profile.interactionSurface,
        toolName: input.manifest.name,
        toolRisk: input.manifest.risk,
        contextReceiptId: input.request.contextReceiptId,
        proposedBy: { kind: "brain", profileId: input.profile.id, sessionId: input.session.id },
        appliedBy: input.appliedBy ? { kind: "human", actorId: input.appliedBy } : null,
        outcome: input.outcome,
        inputHash: sha256(input.request.input),
        outputHash: input.result?.output === undefined ? null : sha256(input.result.output),
        confirmationId: input.confirmationId ?? null,
        errorCode: input.errorCode ?? input.result?.errorCode ?? null,
    };
}

export function brainTurnAuditRecord(input: {
    profile: BrainProfile;
    session: BrainSession;
    turnId: string;
    contextReceiptId: string;
    prompt: string;
    outcome: "proposed" | "succeeded" | "failed";
    errorCode?: string;
}): AgentAuditRecord {
    const request: AgentToolRequest = {
        requestId: `turn:${input.session.id}:${input.turnId}`,
        sessionId: input.session.id,
        turnId: input.turnId,
        connectionId: input.session.connectionId,
        projectId: input.session.projectId,
        toolName: "__brain_turn__",
        input: { promptHash: sha256(input.prompt) },
        contextReceiptId: input.contextReceiptId,
        proposedAt: new Date().toISOString(),
    };
    return agentAuditRecord({
        request,
        manifest: {
            name: "__brain_turn__",
            title: "Brain Turn",
            description: "Per-turn transport and billing attribution record",
            inputSchema: { type: "object" },
            risk: "read",
            surfaces: [input.profile.toolSurface],
            provider: "runtime",
            requiresFreshContext: true,
            mayCreateCharges: input.profile.billingMode === "metered_api",
        },
        profile: input.profile,
        session: input.session,
        outcome: input.outcome,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    });
}

function sha256(value: unknown) {
    return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

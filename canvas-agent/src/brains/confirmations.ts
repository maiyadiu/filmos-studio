import crypto from "node:crypto";

import type { AgentConfirmation, AgentToolRisk } from "./contracts.js";

export type CreateConfirmationInput = {
    sessionId: string;
    turnId: string;
    requestId: string;
    toolName: string;
    risk: Exclude<AgentToolRisk, "read" | "draft">;
    title: string;
    summary: string;
    impact?: string[];
    contextReceiptId: string;
    expiresInMs?: number;
    costPreview?: AgentConfirmation["costPreview"];
};

export class AgentConfirmationStore {
    private readonly confirmations = new Map<string, AgentConfirmation>();

    create(input: CreateConfirmationInput) {
        const createdAt = new Date();
        const confirmation: AgentConfirmation = {
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            turnId: input.turnId,
            requestId: input.requestId,
            toolName: input.toolName,
            risk: input.risk,
            title: input.title,
            summary: input.summary,
            impact: [...(input.impact ?? [])],
            ...(input.costPreview ? { costPreview: structuredClone(input.costPreview) } : {}),
            contextReceiptId: input.contextReceiptId,
            status: "pending",
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + (input.expiresInMs ?? 5 * 60_000)).toISOString(),
        };
        this.confirmations.set(confirmation.id, confirmation);
        return structuredClone(confirmation);
    }

    get(confirmationId: string, now = new Date()) {
        const confirmation = this.confirmations.get(confirmationId);
        if (!confirmation) return undefined;
        this.expireIfNeeded(confirmation, now);
        return structuredClone(confirmation);
    }

    decide(confirmationId: string, input: { sessionId: string; actorId: string; approved: boolean; now?: Date }) {
        const confirmation = this.requireOwnedPending(confirmationId, input.sessionId, input.now);
        confirmation.status = input.approved ? "approved" : "rejected";
        confirmation.decidedAt = (input.now ?? new Date()).toISOString();
        confirmation.decidedBy = input.actorId;
        return structuredClone(confirmation);
    }

    consume(confirmationId: string, input: { sessionId: string; contextReceiptId: string; now?: Date }) {
        const confirmation = this.confirmations.get(confirmationId);
        if (!confirmation) throw new Error("AGENT_CONFIRMATION_NOT_FOUND");
        this.expireIfNeeded(confirmation, input.now ?? new Date());
        if (confirmation.sessionId !== input.sessionId) throw new Error("AGENT_CONFIRMATION_SESSION_MISMATCH");
        if (confirmation.contextReceiptId !== input.contextReceiptId) throw new Error("AGENT_CONFIRMATION_CONTEXT_MISMATCH");
        if (confirmation.status !== "approved") throw new Error(`AGENT_CONFIRMATION_NOT_APPROVED:${confirmation.status}`);
        confirmation.status = "consumed";
        return structuredClone(confirmation);
    }

    cancelSession(sessionId: string) {
        for (const confirmation of this.confirmations.values()) {
            if (confirmation.sessionId === sessionId && ["pending", "approved"].includes(confirmation.status)) confirmation.status = "cancelled";
        }
    }

    private requireOwnedPending(confirmationId: string, sessionId: string, now = new Date()) {
        const confirmation = this.confirmations.get(confirmationId);
        if (!confirmation) throw new Error("AGENT_CONFIRMATION_NOT_FOUND");
        this.expireIfNeeded(confirmation, now);
        if (confirmation.sessionId !== sessionId) throw new Error("AGENT_CONFIRMATION_SESSION_MISMATCH");
        if (confirmation.status !== "pending") throw new Error(`AGENT_CONFIRMATION_ALREADY_DECIDED:${confirmation.status}`);
        return confirmation;
    }

    private expireIfNeeded(confirmation: AgentConfirmation, now: Date) {
        if (["pending", "approved"].includes(confirmation.status) && Date.parse(confirmation.expiresAt) <= now.getTime()) {
            confirmation.status = "expired";
        }
    }
}

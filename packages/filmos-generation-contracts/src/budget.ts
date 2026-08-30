import { hashEnvelope, hashProjection } from "./canonical.js";
import type { BudgetLedger, BudgetLedgerEvent, BudgetReservation, CanonicalSignedMicrounitsDelta, CanonicalUnsignedMicrounits, GenerationBudgetGrant, SignedBudgetLedgerEffects } from "./types.js";

const UNSIGNED = /^(0|[1-9][0-9]*)$/;
const SIGNED = /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/;

export function canonicalUnsignedMicrounits(value: string): CanonicalUnsignedMicrounits {
    if (!UNSIGNED.test(value)) throw new Error("BUDGET_UNSIGNED_MICROUNITS_INVALID");
    return BigInt(value).toString();
}

export function canonicalSignedMicrounitsDelta(value: string): CanonicalSignedMicrounitsDelta {
    if (!SIGNED.test(value)) throw new Error("BUDGET_SIGNED_MICROUNITS_DELTA_INVALID");
    return BigInt(value).toString();
}

export function assertBudgetBindingScope(ledger: Pick<BudgetLedger, "accountBindingRef" | "connectionInstanceRef">, input: { accountBindingRef?: string; connectionInstanceRef: string }): void {
    if (ledger.accountBindingRef !== input.accountBindingRef || ledger.connectionInstanceRef !== input.connectionInstanceRef) throw new Error("BUDGET_BINDING_SCOPE_MISMATCH");
}

export async function createBudgetReservation(input: {
    reservationId: string;
    ledger: BudgetLedger;
    grant: GenerationBudgetGrant;
    generationAttemptId: string;
    routeSnapshotId: string;
    routeContentHash: string;
    reservedTasks: number;
    reservedCost?: { unit: string; amountMicrounits: CanonicalUnsignedMicrounits };
    expiresAt: string;
    createdAt: string;
}): Promise<BudgetReservation> {
    if (input.ledger.grantId !== input.grant.grantId || input.ledger.projectId !== input.grant.projectId) throw new Error("BUDGET_GRANT_LEDGER_SCOPE_MISMATCH");
    assertBudgetBindingScope(input.ledger, input.grant);
    if (input.grant.status !== "active" || Date.parse(input.createdAt) >= Date.parse(input.grant.expiresAt)) throw new Error("BUDGET_GRANT_NOT_ACTIVE");
    if (!Number.isSafeInteger(input.reservedTasks) || input.reservedTasks < 1) throw new Error("BUDGET_RESERVED_TASKS_INVALID");
    if (input.reservedCost) canonicalUnsignedMicrounits(input.reservedCost.amountMicrounits);
    const semantic = {
        ledgerId: input.ledger.ledgerId, budgetGrantId: input.grant.grantId,
        generationAttemptId: input.generationAttemptId, routeSnapshotId: input.routeSnapshotId,
        routeContentHash: input.routeContentHash,
        ...(input.ledger.accountBindingRef ? { accountBindingRef: input.ledger.accountBindingRef } : {}),
        connectionInstanceRef: input.ledger.connectionInstanceRef,
        budgetGrantExpectedVersion: input.grant.entityVersion, budgetGrantExpectedContentHash: input.grant.contentHash,
        ledgerExpectedVersion: input.ledger.entityVersion, ledgerExpectedContentHash: input.ledger.contentHash,
        reservedTasks: input.reservedTasks, ...(input.reservedCost ? { reservedCost: input.reservedCost } : {}),
        expiresAt: input.expiresAt,
    };
    const budgetReservationSemanticHash = await hashProjection("budget-reservation", "semantic", semantic);
    const envelope: Omit<BudgetReservation, "contentHash"> = { schemaVersion: 1, reservationId: input.reservationId, ...semantic, budgetReservationSemanticHash, createdAt: input.createdAt };
    return { ...envelope, contentHash: await hashEnvelope("budget-reservation", envelope as unknown as Record<string, unknown>) };
}

export async function verifyBudgetReservation(reservation: BudgetReservation): Promise<void> {
    const semantic = {
        ledgerId: reservation.ledgerId, budgetGrantId: reservation.budgetGrantId,
        generationAttemptId: reservation.generationAttemptId, routeSnapshotId: reservation.routeSnapshotId,
        routeContentHash: reservation.routeContentHash,
        ...(reservation.accountBindingRef ? { accountBindingRef: reservation.accountBindingRef } : {}),
        connectionInstanceRef: reservation.connectionInstanceRef,
        budgetGrantExpectedVersion: reservation.budgetGrantExpectedVersion, budgetGrantExpectedContentHash: reservation.budgetGrantExpectedContentHash,
        ledgerExpectedVersion: reservation.ledgerExpectedVersion, ledgerExpectedContentHash: reservation.ledgerExpectedContentHash,
        reservedTasks: reservation.reservedTasks, ...(reservation.reservedCost ? { reservedCost: reservation.reservedCost } : {}),
        expiresAt: reservation.expiresAt,
    };
    const semanticHash = await hashProjection("budget-reservation", "semantic", semantic);
    const { contentHash: _contentHash, ...envelope } = reservation;
    const envelopeHash = await hashEnvelope("budget-reservation", envelope as unknown as Record<string, unknown>);
    if (semanticHash !== reservation.budgetReservationSemanticHash || envelopeHash !== reservation.contentHash) throw new Error("BUDGET_RESERVATION_TAMPERED");
}

function addUnsigned(current: string, delta: string): string {
    canonicalUnsignedMicrounits(current);
    canonicalSignedMicrounitsDelta(delta);
    const next = BigInt(current) + BigInt(delta);
    if (next < BigInt(0)) throw new Error("BUDGET_LEDGER_NEGATIVE");
    return next.toString();
}

function assertEffects(effects: SignedBudgetLedgerEffects): void {
    if (!Number.isSafeInteger(effects.reservedTasksDelta) || !Number.isSafeInteger(effects.consumedTasksDelta)) throw new Error("BUDGET_TASK_DELTA_INVALID");
    canonicalSignedMicrounitsDelta(effects.reservedCostMicrounitsDelta);
    canonicalSignedMicrounitsDelta(effects.consumedCostMicrounitsDelta);
}

export async function createBudgetLedgerEvent(input: Omit<BudgetLedgerEvent, "contentHash" | "budgetLedgerEventSemanticHash">): Promise<BudgetLedgerEvent> {
    assertEffects(input.effects);
    const reservationEvent = ["reserved", "submitted", "released", "expired", "settled", "adjusted"].includes(input.eventType);
    if (reservationEvent && (!input.reservationId || !input.generationAttemptId)) throw new Error("BUDGET_EVENT_RESERVATION_SCOPE_REQUIRED");
    if (["revoked", "binding_rotated"].includes(input.eventType)) {
        const effects = input.effects;
        if (effects.reservedTasksDelta || effects.consumedTasksDelta || effects.reservedCostMicrounitsDelta !== "0" || effects.consumedCostMicrounitsDelta !== "0") throw new Error("BUDGET_BINDING_EVENT_EFFECTS_MUST_BE_ZERO");
    }
    if ((input.effects.reservedCostMicrounitsDelta !== "0" || input.effects.consumedCostMicrounitsDelta !== "0") && !input.costUnit) throw new Error("BUDGET_COST_UNIT_REQUIRED");
    const semanticProjection = { ...input, createdAt: undefined, contentHash: undefined, budgetLedgerEventSemanticHash: undefined } as Record<string, unknown>;
    delete semanticProjection.createdAt;
    delete semanticProjection.contentHash;
    delete semanticProjection.budgetLedgerEventSemanticHash;
    const budgetLedgerEventSemanticHash = await hashProjection("budget-ledger-event", "semantic", semanticProjection);
    const envelope = { ...input, budgetLedgerEventSemanticHash };
    return { ...envelope, contentHash: await hashEnvelope("budget-ledger-event", envelope as unknown as Record<string, unknown>) };
}

export async function applyBudgetLedgerEvent(ledger: BudgetLedger, event: BudgetLedgerEvent): Promise<BudgetLedger> {
    if (event.ledgerId !== ledger.ledgerId || event.grantId !== ledger.grantId) throw new Error("BUDGET_LEDGER_EVENT_SCOPE_MISMATCH");
    assertBudgetBindingScope(ledger, event);
    if (event.sequence !== ledger.lastEventSequence + 1) throw new Error("BUDGET_LEDGER_SEQUENCE_GAP");
    if (event.costUnit && ledger.costUnit && event.costUnit !== ledger.costUnit) throw new Error("BUDGET_UNIT_MISMATCH");
    assertEffects(event.effects);
    const reservedTasks = ledger.reservedTasks + event.effects.reservedTasksDelta;
    const consumedTasks = ledger.consumedTasks + event.effects.consumedTasksDelta;
    if (![reservedTasks, consumedTasks].every(Number.isSafeInteger) || reservedTasks < 0 || consumedTasks < 0) throw new Error("BUDGET_LEDGER_NEGATIVE");
    const status = event.eventType === "revoked" ? "revoked" : event.eventType === "binding_rotated" ? "binding_rotated" : event.eventType === "reconciliation_required" ? "reconciliation_required" : ledger.status;
    const updated = {
        ...ledger,
        entityVersion: ledger.entityVersion + 1,
        reservedTasks,
        reservedCostMicrounits: addUnsigned(ledger.reservedCostMicrounits, event.effects.reservedCostMicrounitsDelta),
        consumedTasks,
        consumedCostMicrounits: addUnsigned(ledger.consumedCostMicrounits, event.effects.consumedCostMicrounitsDelta),
        lastEventSequence: event.sequence,
        status,
        costUnit: ledger.costUnit ?? event.costUnit,
        updatedAt: event.occurredAt,
    } satisfies BudgetLedger;
    const { contentHash: _contentHash, ...projection } = updated;
    return { ...updated, contentHash: await hashEnvelope("budget-ledger", projection as unknown as Record<string, unknown>) };
}

export function assertBudgetEventStateClosure(events: readonly BudgetLedgerEvent[]): void {
    for (const event of events) {
        if (!["reserved", "submitted", "released", "expired", "settled", "adjusted", "revoked", "binding_rotated", "reconciliation_required"].includes(event.eventType)) throw new Error("BUDGET_EVENT_STATE_UNKNOWN");
    }
}

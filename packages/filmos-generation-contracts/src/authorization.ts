import { canonicalSort, hashEnvelope, hashProjection, sha256Hex } from "./canonical.js";
import type { AuthorizedGenerationSubmission, GenerationExecutionGuard, GenerationExecutionGuardSet, ProviderInputAuthorizationSnapshot } from "./types.js";

function guardKey(item: GenerationExecutionGuard): string {
    return item.guardKind === "canvas_state" ? `canvas_state:${item.canvasId}:${item.nodeId ?? ""}` : `versioned_entity:${item.entityType}:${item.entityId}`;
}

export async function createProviderInputAuthorizationSnapshot(input: Omit<ProviderInputAuthorizationSnapshot, "contentHash" | "authorizationScopeHash">): Promise<ProviderInputAuthorizationSnapshot> {
    if (!input.authorizationEvidence.confirmationId || !input.authorizationEvidence.brokerGrantId || !input.authorizationEvidence.brokerDecisionReceiptId || !input.authorizationEvidence.toolRequestId) throw new Error("BROKER_AUTHORIZATION_EVIDENCE_INCOMPLETE");
    for (const grant of input.grants) {
        if (/^(?:https?:|file:|\/|~\/)/i.test(grant.destinationScope)) throw new Error("AUTHORIZATION_DESTINATION_SCOPE_NOT_OPAQUE");
    }
    const authorizationScopeHash = await hashProjection("provider-input-authorization", "semantic", { routeContentHash: input.routeContentHash, engineId: input.engineId, connectionId: input.connectionId, ...(input.accountBindingRef ? { accountBindingRef: input.accountBindingRef } : {}), connectionInstanceRef: input.connectionInstanceRef, ...(input.externalProjectId ? { externalProjectId: input.externalProjectId } : {}), grants: input.grants.map(({ authorizedAt: _a, expiresAt: _e, ...grant }) => grant) });
    const envelope = { ...input, authorizationScopeHash };
    return { ...envelope, contentHash: await hashEnvelope("provider-input-authorization", envelope as unknown as Record<string, unknown>) };
}

export async function executionGuardHash(guards: GenerationExecutionGuardSet): Promise<string> {
    return hashProjection("generation-execution-guards", "semantic", { ...guards, dependencies: canonicalSort(guards.dependencies, guardKey) });
}

export async function createAuthorizedGenerationSubmission(input: Omit<AuthorizedGenerationSubmission, "contentHash" | "authorizedSubmissionSemanticHash" | "executionGuardHash" | "idempotencyKey"> & { providerOperation: string }): Promise<AuthorizedGenerationSubmission> {
    if (!input.confirmationId || !input.brokerGrantId || !input.brokerDecisionReceiptId) throw new Error("BROKER_AUTHORIZATION_EVIDENCE_INCOMPLETE");
    const { providerOperation, ...base } = input;
    const guardHash = await executionGuardHash(base.executionGuards);
    const semantic = { generationAttemptId: base.generationAttemptId, routeSnapshotId: base.routeSnapshotId, routeSnapshotContentHash: base.routeSnapshotContentHash, routeContentHash: base.routeContentHash, descriptorReceiptContentHash: base.descriptorReceiptContentHash, catalogValidationReceiptContentHash: base.catalogValidationReceiptContentHash, catalogValidationSemanticHash: base.catalogValidationSemanticHash, catalogValidationSubmitNotAfter: base.catalogValidationSubmitNotAfter, providerInputAuthorizationContentHash: base.providerInputAuthorizationContentHash, authorizationScopeHash: base.authorizationScopeHash, proposalHash: base.proposalHash, confirmationId: base.confirmationId, brokerGrantId: base.brokerGrantId, brokerGrantContentHash: base.brokerGrantContentHash, brokerDecisionReceiptId: base.brokerDecisionReceiptId, brokerDecisionReceiptContentHash: base.brokerDecisionReceiptContentHash, confirmedByActorRef: base.confirmedByActorRef, ...(base.accountBindingRef ? { accountBindingRef: base.accountBindingRef } : {}), connectionInstanceRef: base.connectionInstanceRef, executionGuardHash: guardHash, ...(base.budgetReservationContentHash ? { budgetReservationContentHash: base.budgetReservationContentHash } : {}), ...(base.budgetReservationSemanticHash ? { budgetReservationSemanticHash: base.budgetReservationSemanticHash } : {}) };
    const authorizedSubmissionSemanticHash = await hashProjection("authorized-generation-submission", "semantic", semantic);
    const idempotencyKey = await sha256Hex(`filmos:generation-submit-idempotency:v1\0${base.generationAttemptId}\0${authorizedSubmissionSemanticHash}\0${providerOperation}`);
    const envelope = { ...base, executionGuardHash: guardHash, authorizedSubmissionSemanticHash, idempotencyKey };
    return { ...envelope, contentHash: await hashEnvelope("authorized-generation-submission", envelope as unknown as Record<string, unknown>) };
}

export function assertExecutionGuards(current: ReadonlyMap<string, { version: number; contentHash: string }>, guards: GenerationExecutionGuardSet): void {
    const all = [guards.primaryTarget, guards.promptDraft, guards.projectPolicy, guards.engineConnection, ...(guards.projectLock ? [guards.projectLock] : []), ...(guards.budgetGrant ? [guards.budgetGrant] : []), ...guards.dependencies];
    for (const guard of all) {
        const actual = current.get(guardKey(guard));
        const matches = guard.guardKind === "canvas_state" ? actual?.version === guard.expectedRevision && actual.contentHash === guard.expectedStateHash : actual?.version === guard.expectedVersion && actual.contentHash === guard.expectedContentHash;
        if (!matches) throw new Error("GENERATION_SUBMISSION_STALE");
    }
}

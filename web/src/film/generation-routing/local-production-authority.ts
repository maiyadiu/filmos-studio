import type {
    MockProviderTaskReceipt,
    ProductionAuthorizationBundle,
    ProductionCandidate,
    ProductionGenerationAuthority,
    ProductionPreviewBundle,
    ProductionTraceEvent,
} from "./production-composition";

export type LocalProductionAuthoritySnapshot = {
    previews: ProductionPreviewBundle[];
    authorizations: ProductionAuthorizationBundle[];
    receipts: MockProviderTaskReceipt[];
    candidates: ProductionCandidate[];
    rejections: Array<{ proposalId: string; decisionId: string; traceEvent: ProductionTraceEvent }>;
    guards: Array<[string, { version: number; contentHash: string }]>;
};

/** Local deterministic authority used by the candidate-only acceptance project and restart harness. */
export class LocalProductionGenerationAuthority implements ProductionGenerationAuthority {
    private readonly previews = new Map<string, ProductionPreviewBundle>();
    private readonly authorizations = new Map<string, ProductionAuthorizationBundle>();
    private readonly receipts = new Map<string, MockProviderTaskReceipt>();
    private readonly candidates = new Map<string, ProductionCandidate>();
    private readonly rejections = new Map<string, { decisionId: string; traceEvent: ProductionTraceEvent }>();
    private readonly guards = new Map<string, { version: number; contentHash: string }>();

    constructor(snapshot?: LocalProductionAuthoritySnapshot) {
        for (const item of snapshot?.previews || []) this.previews.set(item.proposal.proposalId, item);
        for (const item of snapshot?.authorizations || []) this.authorizations.set(item.authorizedSubmission.authorizedSubmissionId, item);
        for (const item of snapshot?.receipts || []) this.receipts.set(item.idempotencyKey, item);
        for (const item of snapshot?.candidates || []) this.candidates.set(item.generationAttemptId, item);
        for (const item of snapshot?.rejections || []) this.rejections.set(item.proposalId, { decisionId: item.decisionId, traceEvent: item.traceEvent });
        for (const item of snapshot?.guards || []) this.guards.set(item[0], item[1]);
    }

    async persistPreview(bundle: ProductionPreviewBundle): Promise<void> {
        if (this.previews.has(bundle.proposal.proposalId)) throw new Error("GENERATION_PROPOSAL_DUPLICATE");
        this.previews.set(bundle.proposal.proposalId, structuredClone(bundle));
        seedGuardSet(this.guards, bundle.guards);
    }

    async loadPreview(proposalId: string) { const value = this.previews.get(proposalId); return value && structuredClone(value); }
    async recordRejection(proposalId: string, decisionId: string, traceEvent: ProductionTraceEvent) {
        if (!this.previews.has(proposalId)) throw new Error("GENERATION_PROPOSAL_NOT_FOUND");
        this.rejections.set(proposalId, { decisionId, traceEvent: structuredClone(traceEvent) });
    }

    async reserveAndAuthorize(bundle: ProductionAuthorizationBundle): Promise<void> {
        if (this.rejections.has(bundle.preview.proposal.proposalId)) throw new Error("GENERATION_PROPOSAL_REJECTED");
        if (this.authorizations.has(bundle.authorizedSubmission.authorizedSubmissionId)) throw new Error("AUTHORIZED_GENERATION_SUBMISSION_DUPLICATE");
        this.authorizations.set(bundle.authorizedSubmission.authorizedSubmissionId, structuredClone(bundle));
    }

    async loadAuthorized(id: string) { const value = this.authorizations.get(id); return value && structuredClone(value); }
    async currentGuards() { return new Map(this.guards); }
    async loadProviderReceipt(key: string) { const value = this.receipts.get(key); return value && structuredClone(value); }
    async persistProviderReceipt(receipt: MockProviderTaskReceipt) {
        const existing = this.receipts.get(receipt.idempotencyKey);
        if (existing && existing.contentHash !== receipt.contentHash) throw new Error("PROVIDER_RECEIPT_IDEMPOTENCY_CONFLICT");
        this.receipts.set(receipt.idempotencyKey, structuredClone(receipt));
    }
    async persistCandidate(candidate: ProductionCandidate) {
        const existing = this.candidates.get(candidate.generationAttemptId);
        if (existing && existing.contentHash !== candidate.contentHash) throw new Error("GENERATION_CANDIDATE_DUPLICATE");
        if (candidate.approvalState !== "not_approved" || candidate.qcState !== "pending") throw new Error("GENERATION_CANDIDATE_BOUNDARY_VIOLATION");
        this.candidates.set(candidate.generationAttemptId, structuredClone(candidate));
    }
    async loadCandidateByAttempt(attemptId: string) { const value = this.candidates.get(attemptId); return value && structuredClone(value); }

    setGuard(key: string, value: { version: number; contentHash: string }) { this.guards.set(key, value); }
    providerReceiptCount() { return this.receipts.size; }
    candidateCount() { return this.candidates.size; }
    rejectionCount() { return this.rejections.size; }
    snapshot(): LocalProductionAuthoritySnapshot {
        return {
            previews: [...this.previews.values()].map((item) => structuredClone(item)),
            authorizations: [...this.authorizations.values()].map((item) => structuredClone(item)),
            receipts: [...this.receipts.values()].map((item) => structuredClone(item)),
            candidates: [...this.candidates.values()].map((item) => structuredClone(item)),
            rejections: [...this.rejections].map(([proposalId, value]) => ({ proposalId, decisionId: value.decisionId, traceEvent: structuredClone(value.traceEvent) })),
            guards: [...this.guards].map(([key, value]) => [key, { ...value }]),
        };
    }
}

function seedGuardSet(target: Map<string, { version: number; contentHash: string }>, guards: ProductionPreviewBundle["guards"]) {
    for (const guard of [guards.primaryTarget, guards.promptDraft, guards.projectPolicy, guards.engineConnection, ...(guards.projectLock ? [guards.projectLock] : []), ...(guards.budgetGrant ? [guards.budgetGrant] : []), ...guards.dependencies]) {
        const key = guard.guardKind === "canvas_state" ? `canvas_state:${guard.canvasId}:${guard.nodeId ?? ""}` : `versioned_entity:${guard.entityType}:${guard.entityId}`;
        target.set(key, guard.guardKind === "canvas_state" ? { version: guard.expectedRevision, contentHash: guard.expectedStateHash } : { version: guard.expectedVersion, contentHash: guard.expectedContentHash });
    }
}

import {
    assertCatalogValidationSubmitReady,
    assertExecutionGuards,
    assertGenerationEngineConnectionRoutable,
    assertProjectGenerationLock,
    assertProjectGenerationPolicy,
    compilePrompt,
    createAuthorizedGenerationSubmission,
    createBudgetReservation,
    createCatalogValidationReceipt,
    createGenerationRouteSnapshot,
    createInlineDescriptorReceipt,
    createProviderInputAuthorizationSnapshot,
    exactSelectedDescriptors,
    hashGenerationReferences,
    hashEnvelope,
    hashProjection,
    verifyBudgetReservation,
    verifyGenerationRouteSnapshot,
    type AuthorizedGenerationSubmission,
    type BudgetLedger,
    type BudgetReservation,
    type CatalogValidationReceipt,
    type CompiledPromptReceipt,
    type GenerationBudgetGrant,
    type GenerationCatalogSnapshot,
    type GenerationDefaultRoute,
    type GenerationEngineConnection,
    type GenerationExecutionGuardSet,
    type GenerationReferenceBinding,
    type GenerationRouteSnapshot,
    type GenerationTaskKind,
    type ProjectGenerationLock,
    type ProjectGenerationPolicy,
    type ProviderInputAuthorizationSnapshot,
    type ResolvedGenerationDescriptorReceipt,
} from "@filmos/generation-contracts";

export const FILMOS_ACCEPTANCE_PROJECT_NAME = "FilmOS_Acceptance_Project";
export const FILMOS_MOCK_GENERATION_ENGINE_ID = "filmos_mock_generation";

export type ProductionRouteInput = GenerationDefaultRoute & { taskKind: GenerationTaskKind };
export type ProductionRouteSelection = ProductionRouteInput & { selectionSource: "explicit_task" | "node_override" | "project_default" | "global_default" };

export function selectEffectiveGenerationRoute(input: {
    taskKind: GenerationTaskKind;
    explicitTask?: GenerationDefaultRoute;
    nodeOverride?: GenerationDefaultRoute;
    projectPolicy?: ProjectGenerationPolicy;
    globalDefault?: GenerationDefaultRoute;
}): ProductionRouteSelection {
    const selected = input.explicitTask
        ? { ...input.explicitTask, selectionSource: "explicit_task" as const }
        : input.nodeOverride
            ? { ...input.nodeOverride, selectionSource: "node_override" as const }
            : input.projectPolicy?.defaultRoutes[input.taskKind]
                ? { ...input.projectPolicy.defaultRoutes[input.taskKind]!, selectionSource: "project_default" as const }
                : input.globalDefault
                    ? { ...input.globalDefault, selectionSource: "global_default" as const }
                    : undefined;
    if (!selected) throw new Error("GENERATION_ROUTE_NEEDS_CONFIGURATION");
    if (![selected.modelId, selected.workflowId, selected.skillId].some(Boolean)) throw new Error("GENERATION_ROUTE_DESCRIPTOR_REQUIRED");
    return { ...selected, taskKind: input.taskKind };
}

export type ProductionTraceEventName =
    | "draft.created" | "descriptor.resolved" | "prompt.compiled" | "route.snapshotted" | "proposal.previewed"
    | "confirmation.rejected" | "confirmation.approved" | "catalog.validated" | "input.authorized" | "budget.reserved"
    | "submission.authorized" | "provider.submitted" | "provider.succeeded" | "output.downloaded" | "candidate.imported" | "qc.pending";

export type ProductionTraceEvent = {
    sequence: number;
    event: ProductionTraceEventName;
    objectId: string;
    contentHash: string;
    semanticHash: string;
    projectId: string;
    nodeId: string;
    generationAttemptId: string;
    timestamp: string;
    actor: string;
    brokerDecision: "none" | "rejected" | "approved";
    externalCostMicrounits: "0";
    externalWrite: false;
};

export type ProductionPreviewBundle = {
    projectId: string;
    projectName: string;
    nodeId: string;
    generationAttemptId: string;
    descriptorReceipt: ResolvedGenerationDescriptorReceipt;
    compiledPromptReceipt: CompiledPromptReceipt;
    routeSnapshot: GenerationRouteSnapshot;
    proposal: { proposalId: string; proposalHash: string; previewReceiptId: string; previewReceiptHash: string; externalCostMicrounits: "0"; externalWritePerformed: false };
    guards: GenerationExecutionGuardSet;
    catalog: GenerationCatalogSnapshot;
    connection: GenerationEngineConnection;
    trace: ProductionTraceEvent[];
};

export type ProductionAuthorizationBundle = {
    preview: ProductionPreviewBundle;
    catalogValidation: CatalogValidationReceipt;
    inputAuthorization: ProviderInputAuthorizationSnapshot;
    budgetReservation: BudgetReservation;
    authorizedSubmission: AuthorizedGenerationSubmission;
    trace: ProductionTraceEvent[];
};

export type MockProviderTaskReceipt = {
    providerReceiptId: string;
    providerTaskId: string;
    authorizedSubmissionId: string;
    idempotencyKey: string;
    outputHash: string;
    outputAssetVersionId: string;
    contentHash: string;
    status: "succeeded";
    externalNetworkRequests: 0;
    externalSpendMicrounits: "0";
    submittedAt: string;
    completedAt: string;
};

export type ProductionCandidate = {
    candidateId: string;
    generationAttemptId: string;
    providerReceiptId: string;
    outputAssetVersionId: string;
    outputHash: string;
    qcState: "pending";
    approvalState: "not_approved";
    contentHash: string;
};

export interface ProductionGenerationAuthority {
    persistPreview(bundle: ProductionPreviewBundle): Promise<void>;
    loadPreview(proposalId: string): Promise<ProductionPreviewBundle | undefined>;
    recordRejection(proposalId: string, decisionId: string, traceEvent: ProductionTraceEvent): Promise<void>;
    reserveAndAuthorize(bundle: ProductionAuthorizationBundle): Promise<void>;
    loadAuthorized(authorizedSubmissionId: string): Promise<ProductionAuthorizationBundle | undefined>;
    currentGuards(preview?: ProductionPreviewBundle): Promise<ReadonlyMap<string, { version: number; contentHash: string }>>;
    loadProviderReceipt(idempotencyKey: string): Promise<MockProviderTaskReceipt | undefined>;
    persistProviderReceipt(receipt: MockProviderTaskReceipt): Promise<void>;
    persistCandidate(candidate: ProductionCandidate): Promise<void>;
    loadCandidateByAttempt(generationAttemptId: string): Promise<ProductionCandidate | undefined>;
}

export interface ProductionGenerationProvider {
    readonly engineId: string;
    readonly supportsHardLockedReferences: boolean;
    submit(input: { projectName: string; authorization: ProductionAuthorizationBundle; now: string }): Promise<MockProviderTaskReceipt>;
}

export class FilmOSMockGenerationProvider implements ProductionGenerationProvider {
    readonly engineId = FILMOS_MOCK_GENERATION_ENGINE_ID;
    readonly supportsHardLockedReferences = true;
    private readonly receipts = new Map<string, MockProviderTaskReceipt>();
    submitCount = 0;

    async submit(input: { projectName: string; authorization: ProductionAuthorizationBundle; now: string }): Promise<MockProviderTaskReceipt> {
        if (input.projectName !== FILMOS_ACCEPTANCE_PROJECT_NAME) throw new Error("MOCK_PROVIDER_ACCEPTANCE_PROJECT_ONLY");
        if (input.authorization.preview.routeSnapshot.engineId !== this.engineId) throw new Error("MOCK_PROVIDER_ENGINE_MISMATCH");
        const key = input.authorization.authorizedSubmission.idempotencyKey;
        const existing = this.receipts.get(key);
        if (existing) return existing;
        this.submitCount += 1;
        const outputHash = await hashProjection("mock-generation-output", "semantic", { idempotencyKey: key, routeContentHash: input.authorization.preview.routeSnapshot.routeContentHash });
        const base = {
            providerReceiptId: `mock-receipt-${outputHash.slice(0, 24)}`,
            providerTaskId: `mock-task-${outputHash.slice(0, 24)}`,
            authorizedSubmissionId: input.authorization.authorizedSubmission.authorizedSubmissionId,
            idempotencyKey: key,
            outputHash,
            outputAssetVersionId: `mock-asset-version-${outputHash.slice(0, 24)}`,
            status: "succeeded" as const,
            externalNetworkRequests: 0 as const,
            externalSpendMicrounits: "0" as const,
            submittedAt: input.now,
            completedAt: input.now,
        };
        const receipt = { ...base, contentHash: await hashProjection("mock-provider-receipt", "envelope", base) };
        this.receipts.set(key, receipt);
        return receipt;
    }
}

export class ProductionGenerationComposition {
    constructor(
        private readonly authority: ProductionGenerationAuthority,
        private readonly providers: ReadonlyMap<string, ProductionGenerationProvider>,
        private readonly issueId: (prefix: string) => string = (prefix) => `${prefix}-${crypto.randomUUID()}`,
        private readonly now: () => string = () => new Date().toISOString(),
    ) {}

    async preview(input: {
        projectId: string; projectName: string; nodeId: string; generationAttemptId: string; taskKind: GenerationTaskKind;
        explicitTask?: GenerationDefaultRoute; nodeOverride?: GenerationDefaultRoute; projectPolicy: ProjectGenerationPolicy;
        projectLock?: ProjectGenerationLock; globalDefault?: GenerationDefaultRoute; connection: GenerationEngineConnection;
        catalog: GenerationCatalogSnapshot; promptIntent: Parameters<typeof compilePrompt>[0]["intent"]; references: GenerationReferenceBinding[];
        normalizedParameters: Record<string, unknown>; promptDraftVersion: number; promptDraftContentHash: string; nodeDraftVersion: number;
        userConfigRevision: string; guards: GenerationExecutionGuardSet;
    }): Promise<ProductionPreviewBundle> {
        assertGenerationEngineConnectionRoutable(input.connection);
        const selectedRoute = selectEffectiveGenerationRoute(input);
        if (selectedRoute.engineId !== input.connection.engineId || selectedRoute.connectionId !== input.connection.connectionId) throw new Error("GENERATION_ROUTE_CONNECTION_MISMATCH");
        if (input.catalog.engineId !== selectedRoute.engineId || input.catalog.connectionId !== selectedRoute.connectionId) throw new Error("GENERATION_CATALOG_CONNECTION_MISMATCH");
        const selections = [
            ...(selectedRoute.modelId ? [{ descriptorKind: "model" as const, descriptorId: selectedRoute.modelId }] : []),
            ...(selectedRoute.workflowId ? [{ descriptorKind: "workflow" as const, descriptorId: selectedRoute.workflowId }] : []),
            ...(selectedRoute.skillId ? [{ descriptorKind: "skill" as const, descriptorId: selectedRoute.skillId }] : []),
        ];
        const selected = exactSelectedDescriptors(input.catalog, selections);
        const at = this.now();
        const descriptorReceipt = await createInlineDescriptorReceipt({ descriptorReceiptId: this.issueId("descriptor"), selected, catalog: input.catalog, createdAt: at });
        const parameterSchema = descriptorParameterSchema(selected[0]);
        const compiledPromptReceipt = await compilePrompt({ id: this.issueId("compiled-prompt"), intent: input.promptIntent, engineId: selectedRoute.engineId, ...(selectedRoute.modelId ? { modelId: selectedRoute.modelId } : {}), taskKind: input.taskKind, templateVersion: "filmos-v2.4", compilerVersion: "filmos-v2.4-production", parameterSchema, references: input.references, createdAt: at });
        const referenceHash = await hashGenerationReferences(input.references);
        const parameterHash = await hashProjection("generation-parameters", "semantic", input.normalizedParameters);
        const routeSnapshot = await createGenerationRouteSnapshot({
            schemaVersion: 1, routeSnapshotId: this.issueId("route"), generationAttemptId: input.generationAttemptId,
            engineId: selectedRoute.engineId, connectionId: selectedRoute.connectionId,
            ...(input.connection.accountBindingRef ? { accountBindingRef: input.connection.accountBindingRef } : {}), connectionInstanceRef: input.connection.connectionInstanceRef,
            capability: descriptorCapability(selected[0], input.taskKind), taskKind: input.taskKind, descriptorReceiptId: descriptorReceipt.descriptorReceiptId,
            descriptorReceiptContentHash: descriptorReceipt.contentHash, descriptorSemanticHash: descriptorReceipt.descriptorSemanticHash,
            ...(selectedRoute.modelId ? { modelId: selectedRoute.modelId } : {}), ...(selectedRoute.workflowId ? { workflowId: selectedRoute.workflowId } : {}), ...(selectedRoute.skillId ? { skillId: selectedRoute.skillId } : {}),
            normalizedParameters: input.normalizedParameters, parameterHash, references: input.references, referenceHash,
            promptDraftVersion: input.promptDraftVersion, promptDraftContentHash: input.promptDraftContentHash,
            compiledPromptSemanticHash: compiledPromptReceipt.compiledPromptSemanticHash, compiledPromptTextHash: compiledPromptReceipt.compiledTextHash,
            compilerVersion: compiledPromptReceipt.compilerVersion, templateVersion: compiledPromptReceipt.templateVersion,
            userConfigRevision: input.userConfigRevision, projectPolicyVersion: input.projectPolicy.entityVersion, projectPolicyHash: input.projectPolicy.contentHash,
            ...(input.projectLock ? { projectLockVersion: input.projectLock.entityVersion, projectLockHash: input.projectLock.contentHash } : {}),
            nodeDraftVersion: input.nodeDraftVersion, selectionSource: selectedRoute.selectionSource, resolvedAt: at, createdAt: at,
        });
        assertProjectGenerationPolicy(input.projectPolicy, routeSnapshot);
        if (input.projectLock) assertProjectGenerationLock(input.projectLock, input.taskKind, routeSnapshot, selected.map(({ descriptor: _descriptor, ...ref }) => ref), descriptorDetails(selected, input.catalog));
        const proposalHash = await hashProjection("generation-submission-proposal", "semantic", { projectId: input.projectId, nodeId: input.nodeId, routeContentHash: routeSnapshot.routeContentHash });
        const proposalId = this.issueId("proposal");
        const previewReceiptHash = await hashProjection("generation-preview-receipt", "envelope", { proposalId, proposalHash, routeSnapshotContentHash: routeSnapshot.contentHash, externalCostMicrounits: "0", externalWritePerformed: false });
        const bundle: ProductionPreviewBundle = {
            projectId: input.projectId, projectName: input.projectName, nodeId: input.nodeId, generationAttemptId: input.generationAttemptId,
            descriptorReceipt, compiledPromptReceipt, routeSnapshot,
            proposal: { proposalId, proposalHash, previewReceiptId: this.issueId("preview"), previewReceiptHash, externalCostMicrounits: "0", externalWritePerformed: false },
            guards: input.guards, catalog: input.catalog, connection: input.connection,
            trace: await buildTrace(input.projectId, input.nodeId, input.generationAttemptId, at, [
                ["draft.created", input.generationAttemptId, input.promptDraftContentHash, input.promptDraftContentHash],
                ["descriptor.resolved", descriptorReceipt.descriptorReceiptId, descriptorReceipt.contentHash, descriptorReceipt.descriptorSemanticHash],
                ["prompt.compiled", compiledPromptReceipt.compiledPromptReceiptId, compiledPromptReceipt.contentHash, compiledPromptReceipt.compiledPromptSemanticHash],
                ["route.snapshotted", routeSnapshot.routeSnapshotId, routeSnapshot.contentHash, routeSnapshot.routeContentHash],
                ["proposal.previewed", proposalId, previewReceiptHash, proposalHash],
            ]),
        };
        await this.authority.persistPreview(bundle);
        return bundle;
    }

    async reject(proposalId: string, decisionId = this.issueId("decision")): Promise<ProductionTraceEvent> {
        const preview = await this.authority.loadPreview(proposalId);
        if (!preview) throw new Error("GENERATION_PROPOSAL_NOT_FOUND");
        const [traceEvent] = await buildTrace(preview.projectId, preview.nodeId, preview.generationAttemptId, this.now(), [
            ["confirmation.rejected", decisionId, preview.proposal.previewReceiptHash, preview.proposal.proposalHash],
        ], preview.trace.length, "rejected");
        await this.authority.recordRejection(proposalId, decisionId, traceEvent);
        return traceEvent;
    }

    async approve(input: {
        proposalId: string; actorRef: string; confirmationId: string; brokerGrantId: string; brokerGrantContentHash: string;
        brokerDecisionReceiptId: string; brokerDecisionReceiptContentHash: string; toolRequestId: string;
        grant: GenerationBudgetGrant; ledger: BudgetLedger; submitNotAfter: string;
    }): Promise<ProductionAuthorizationBundle> {
        const preview = await this.authority.loadPreview(input.proposalId);
        if (!preview) throw new Error("GENERATION_PROPOSAL_NOT_FOUND");
        const at = this.now();
        const current = await this.authority.currentGuards(preview);
        assertExecutionGuards(current, preview.guards);
        const catalogValidation = await createCatalogValidationReceipt({ id: this.issueId("catalog-validation"), descriptorReceipt: preview.descriptorReceipt, route: preview.routeSnapshot, catalog: preview.catalog, validationMode: preview.catalog.evidence.source === "remote_catalog" ? "remote_catalog_revalidation" : preview.catalog.evidence.source === "verified_static_version_bound" ? "verified_static_version_check" : "runtime_revalidation", validatedAt: at, submitNotAfter: input.submitNotAfter });
        const inputAuthorization = await createProviderInputAuthorizationSnapshot({
            schemaVersion: 1, authorizationSnapshotId: this.issueId("input-authorization"), routeSnapshotId: preview.routeSnapshot.routeSnapshotId,
            routeSnapshotContentHash: preview.routeSnapshot.contentHash, routeContentHash: preview.routeSnapshot.routeContentHash,
            engineId: preview.routeSnapshot.engineId, connectionId: preview.routeSnapshot.connectionId,
            ...(preview.routeSnapshot.accountBindingRef ? { accountBindingRef: preview.routeSnapshot.accountBindingRef } : {}), connectionInstanceRef: preview.routeSnapshot.connectionInstanceRef,
            grants: preview.routeSnapshot.references.map((reference) => ({ bindingId: reference.bindingId, assetVersionId: reference.assetVersionId, assetVersionContentHash: reference.assetVersionContentHash, ...(reference.preparedRepresentationId ? { preparedRepresentationId: reference.preparedRepresentationId, preparedRepresentationContentHash: reference.preparedRepresentationContentHash } : {}), permission: "provider_local_read" as const, destinationScope: `filmos_${preview.routeSnapshot.engineId}_input`, authorizedAt: at })),
            authorizationEvidence: { confirmationId: input.confirmationId, brokerGrantId: input.brokerGrantId, brokerGrantContentHash: input.brokerGrantContentHash, brokerDecisionReceiptId: input.brokerDecisionReceiptId, brokerDecisionReceiptContentHash: input.brokerDecisionReceiptContentHash, toolRequestId: input.toolRequestId, authorizedByActorRef: input.actorRef, confirmedAt: at }, createdAt: at,
        });
        const budgetReservation = await createBudgetReservation({ reservationId: this.issueId("budget-reservation"), ledger: input.ledger, grant: input.grant, generationAttemptId: preview.generationAttemptId, routeSnapshotId: preview.routeSnapshot.routeSnapshotId, routeContentHash: preview.routeSnapshot.routeContentHash, reservedTasks: 1, reservedCost: { unit: "mock", amountMicrounits: "0" }, expiresAt: input.submitNotAfter, createdAt: at });
        const authorizedSubmission = await createAuthorizedGenerationSubmission({
            schemaVersion: 1, authorizedSubmissionId: this.issueId("authorized-submission"), generationAttemptId: preview.generationAttemptId,
            routeSnapshotId: preview.routeSnapshot.routeSnapshotId, routeSnapshotContentHash: preview.routeSnapshot.contentHash, routeContentHash: preview.routeSnapshot.routeContentHash,
            descriptorReceiptId: preview.descriptorReceipt.descriptorReceiptId, descriptorReceiptContentHash: preview.descriptorReceipt.contentHash,
            catalogValidationReceiptId: catalogValidation.catalogValidationReceiptId, catalogValidationReceiptContentHash: catalogValidation.contentHash, catalogValidationSemanticHash: catalogValidation.catalogValidationSemanticHash, catalogValidationSubmitNotAfter: catalogValidation.submitNotAfter,
            providerInputAuthorizationSnapshotId: inputAuthorization.authorizationSnapshotId, providerInputAuthorizationContentHash: inputAuthorization.contentHash, authorizationScopeHash: inputAuthorization.authorizationScopeHash,
            proposalId: preview.proposal.proposalId, proposalHash: preview.proposal.proposalHash, confirmationId: input.confirmationId,
            brokerGrantId: input.brokerGrantId, brokerGrantContentHash: input.brokerGrantContentHash, brokerDecisionReceiptId: input.brokerDecisionReceiptId, brokerDecisionReceiptContentHash: input.brokerDecisionReceiptContentHash,
            confirmedByActorRef: input.actorRef, confirmedAt: at, ...(preview.routeSnapshot.accountBindingRef ? { accountBindingRef: preview.routeSnapshot.accountBindingRef } : {}), connectionInstanceRef: preview.routeSnapshot.connectionInstanceRef,
            executionGuards: preview.guards, budgetReservationId: budgetReservation.reservationId, budgetReservationContentHash: budgetReservation.contentHash, budgetReservationSemanticHash: budgetReservation.budgetReservationSemanticHash,
            providerOperation: `${preview.routeSnapshot.taskKind}.generate`, createdAt: at,
        });
        const trace = [...preview.trace, ...await buildTrace(preview.projectId, preview.nodeId, preview.generationAttemptId, at, [
            ["confirmation.approved", input.brokerDecisionReceiptId, input.brokerDecisionReceiptContentHash, input.brokerDecisionReceiptContentHash],
            ["catalog.validated", catalogValidation.catalogValidationReceiptId, catalogValidation.contentHash, catalogValidation.catalogValidationSemanticHash],
            ["input.authorized", inputAuthorization.authorizationSnapshotId, inputAuthorization.contentHash, inputAuthorization.authorizationScopeHash],
            ["budget.reserved", budgetReservation.reservationId, budgetReservation.contentHash, budgetReservation.budgetReservationSemanticHash],
            ["submission.authorized", authorizedSubmission.authorizedSubmissionId, authorizedSubmission.contentHash, authorizedSubmission.authorizedSubmissionSemanticHash],
        ], preview.trace.length, "approved")];
        const bundle = { preview, catalogValidation, inputAuthorization, budgetReservation, authorizedSubmission, trace };
        await this.authority.reserveAndAuthorize(bundle);
        return bundle;
    }

    async submitAuthorized(authorizedSubmissionId: string): Promise<{ receipt: MockProviderTaskReceipt; candidate: ProductionCandidate; trace: ProductionTraceEvent[] }> {
        const authorization = await this.authority.loadAuthorized(authorizedSubmissionId);
        if (!authorization) throw new Error("AUTHORIZED_GENERATION_SUBMISSION_NOT_FOUND");
        const { preview, authorizedSubmission } = authorization;
        await verifyProductionAuthorizationBundle(authorization);
        const current = await this.authority.currentGuards(preview);
        assertExecutionGuards(current, preview.guards);
        assertCatalogValidationSubmitReady(authorization.catalogValidation, { now: this.now(), routeContentHash: preview.routeSnapshot.routeContentHash, descriptorSemanticHash: preview.descriptorReceipt.descriptorSemanticHash, accountBindingRef: preview.routeSnapshot.accountBindingRef, connectionInstanceRef: preview.routeSnapshot.connectionInstanceRef });
        const storedReceipt = await this.authority.loadProviderReceipt(authorizedSubmission.idempotencyKey);
        const provider = this.providers.get(preview.routeSnapshot.engineId);
        if (!provider) throw new Error("GENERATION_PROVIDER_ADAPTER_NOT_FOUND");
        if (preview.routeSnapshot.references.some((reference) => reference.hardLock) && !provider.supportsHardLockedReferences) throw new Error("GENERATION_REFERENCE_HARD_LOCK_UNSUPPORTED");
        const at = this.now();
        const receipt = storedReceipt ?? await provider.submit({ projectName: preview.projectName, authorization, now: at });
        if (!storedReceipt) await this.authority.persistProviderReceipt(receipt);
        let candidate = await this.authority.loadCandidateByAttempt(preview.generationAttemptId);
        if (!candidate) {
            const candidateBase = { candidateId: this.issueId("candidate"), generationAttemptId: preview.generationAttemptId, providerReceiptId: receipt.providerReceiptId, outputAssetVersionId: receipt.outputAssetVersionId, outputHash: receipt.outputHash, qcState: "pending" as const, approvalState: "not_approved" as const };
            candidate = { ...candidateBase, contentHash: await hashProjection("generation-candidate", "envelope", candidateBase) };
            await this.authority.persistCandidate(candidate);
        }
        const trace = [...authorization.trace, ...await buildTrace(preview.projectId, preview.nodeId, preview.generationAttemptId, at, [
            ["provider.submitted", receipt.providerTaskId, receipt.contentHash, authorizedSubmission.authorizedSubmissionSemanticHash],
            ["provider.succeeded", receipt.providerReceiptId, receipt.contentHash, receipt.outputHash],
            ["output.downloaded", receipt.outputAssetVersionId, receipt.outputHash, receipt.outputHash],
            ["candidate.imported", candidate.candidateId, candidate.contentHash, candidate.outputHash],
            ["qc.pending", candidate.candidateId, candidate.contentHash, candidate.outputHash],
        ], authorization.trace.length, "approved")];
        return { receipt, candidate, trace };
    }

    async recover(generationAttemptId: string): Promise<ProductionCandidate> {
        const candidate = await this.authority.loadCandidateByAttempt(generationAttemptId);
        if (!candidate) throw new Error("GENERATION_RECOVERY_RECEIPT_NOT_FOUND");
        return candidate;
    }
}

async function verifyProductionAuthorizationBundle(bundle: ProductionAuthorizationBundle): Promise<void> {
    const { preview, catalogValidation, inputAuthorization, budgetReservation, authorizedSubmission } = bundle;
    assertGenerationEngineConnectionRoutable(preview.connection);
    if (preview.connection.engineId !== preview.routeSnapshot.engineId || preview.connection.connectionId !== preview.routeSnapshot.connectionId || preview.connection.accountBindingRef !== preview.routeSnapshot.accountBindingRef || preview.connection.connectionInstanceRef !== preview.routeSnapshot.connectionInstanceRef) throw new Error("GENERATION_SUBMISSION_CONNECTION_STALE");
    await verifyEnvelopeHash("compiled-prompt", preview.compiledPromptReceipt);
    await verifyGenerationRouteSnapshot(preview.routeSnapshot);
    const selected = preview.descriptorReceipt.payload.storage === "inline" ? preview.descriptorReceipt.payload.selectedDescriptors : undefined;
    if (!selected) throw new Error("GENERATION_PRODUCTION_DESCRIPTOR_INLINE_REQUIRED");
    const rebuiltDescriptor = await createInlineDescriptorReceipt({ descriptorReceiptId: preview.descriptorReceipt.descriptorReceiptId, selected, catalog: preview.catalog, createdAt: preview.descriptorReceipt.createdAt });
    if (rebuiltDescriptor.contentHash !== preview.descriptorReceipt.contentHash || rebuiltDescriptor.descriptorSemanticHash !== preview.descriptorReceipt.descriptorSemanticHash) throw new Error("GENERATION_DESCRIPTOR_RECEIPT_TAMPERED");
    const rebuiltCatalog = await createCatalogValidationReceipt({ id: catalogValidation.catalogValidationReceiptId, descriptorReceipt: preview.descriptorReceipt, route: preview.routeSnapshot, catalog: preview.catalog, validationMode: catalogValidation.validationMode, validatedAt: catalogValidation.validatedAt, submitNotAfter: catalogValidation.submitNotAfter });
    if (rebuiltCatalog.contentHash !== catalogValidation.contentHash || rebuiltCatalog.catalogValidationSemanticHash !== catalogValidation.catalogValidationSemanticHash) throw new Error("CATALOG_VALIDATION_RECEIPT_TAMPERED");
    const { contentHash: _inputContentHash, authorizationScopeHash: _authorizationScopeHash, ...inputBase } = inputAuthorization;
    const rebuiltInput = await createProviderInputAuthorizationSnapshot(inputBase);
    if (rebuiltInput.contentHash !== inputAuthorization.contentHash || rebuiltInput.authorizationScopeHash !== inputAuthorization.authorizationScopeHash) throw new Error("PROVIDER_INPUT_AUTHORIZATION_TAMPERED");
    await verifyBudgetReservation(budgetReservation);
    const { contentHash: _authorizedContentHash, executionGuardHash: _executionGuardHash, authorizedSubmissionSemanticHash: _authorizedSemanticHash, idempotencyKey: _idempotencyKey, ...authorizedBase } = authorizedSubmission;
    const rebuiltAuthorized = await createAuthorizedGenerationSubmission({ ...authorizedBase, providerOperation: `${preview.routeSnapshot.taskKind}.generate` });
    if (rebuiltAuthorized.contentHash !== authorizedSubmission.contentHash || rebuiltAuthorized.authorizedSubmissionSemanticHash !== authorizedSubmission.authorizedSubmissionSemanticHash || rebuiltAuthorized.idempotencyKey !== authorizedSubmission.idempotencyKey) throw new Error("AUTHORIZED_GENERATION_SUBMISSION_TAMPERED");
}

async function verifyEnvelopeHash(entityType: string, object: { contentHash: string } & Record<string, unknown>): Promise<void> {
    if (await hashEnvelope(entityType, object) !== object.contentHash) throw new Error(`${entityType.toUpperCase().replaceAll("-", "_")}_TAMPERED`);
}

function descriptorDetails(selected: ReturnType<typeof exactSelectedDescriptors>, catalog: GenerationCatalogSnapshot) {
    const model = selected.find((item) => item.descriptorKind === "model")?.descriptor;
    const workflow = selected.find((item) => item.descriptorKind === "workflow")?.descriptor;
    const skill = selected.find((item) => item.descriptorKind === "skill")?.descriptor;
    return {
        ...(model && "providerModelId" in model ? { providerModelId: model.providerModelId, modelVersion: model.modelVersion } : {}),
        ...(workflow && "version" in workflow ? { workflowVersion: workflow.version } : {}),
        ...(skill && "version" in skill ? { skillVersion: skill.version } : {}),
        catalogRevision: catalog.catalogRevision,
    };
}

function descriptorParameterSchema(selected: ReturnType<typeof exactSelectedDescriptors>[number]): Record<string, unknown> {
    if (selected.descriptorKind === "model") return selected.descriptor.parameterSchema;
    return selected.descriptor.inputSchema ?? {};
}

function descriptorCapability(selected: ReturnType<typeof exactSelectedDescriptors>[number], taskKind: GenerationTaskKind): "image" | "video" | "audio" | "workflow" {
    if (selected.descriptorKind !== "skill") return selected.descriptor.capability;
    if (taskKind.includes("video")) return "video";
    if (taskKind === "audio") return "audio";
    return "workflow";
}

async function buildTrace(projectId: string, nodeId: string, generationAttemptId: string, timestamp: string, entries: Array<[ProductionTraceEventName, string, string, string]>, offset = 0, brokerDecision: ProductionTraceEvent["brokerDecision"] = "none"): Promise<ProductionTraceEvent[]> {
    return entries.map(([event, objectId, contentHash, semanticHash], index) => ({ sequence: offset + index + 1, event, objectId, contentHash, semanticHash, projectId, nodeId, generationAttemptId, timestamp, actor: "filmos-production-composition", brokerDecision, externalCostMicrounits: "0", externalWrite: false }));
}

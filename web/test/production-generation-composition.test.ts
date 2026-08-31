import { describe, expect, test } from "bun:test";
import {
    hashEnvelope,
    hashProjectGenerationLock,
    hashProjectGenerationPolicy,
    hashProjection,
    type BudgetLedger,
    type GenerationBudgetGrant,
    type GenerationCatalogSnapshot,
    type GenerationEngineConnection,
    type ProjectGenerationLock,
    type ProjectGenerationPolicy,
} from "@filmos/generation-contracts";

import { LocalProductionGenerationAuthority } from "@/film/generation-routing/local-production-authority";
import { executeCanonicalGenerationTool } from "@/film/generation-routing/canonical-tool-runtime";
import {
    FILMOS_ACCEPTANCE_PROJECT_NAME,
    FILMOS_MOCK_GENERATION_ENGINE_ID,
    FilmOSMockGenerationProvider,
    ProductionGenerationService,
    assertProductionReleaseSubmitAllowed,
    productionReleasePolicyFromEnvironment,
    selectEffectiveGenerationRoute,
} from "@/film/generation-routing/production-composition";
import { defaultConfig } from "@/stores/use-config-store";
import { canonicalGenerationBrokerAuthorization } from "./helpers/canonical-agent-broker";

const at = "2026-08-31T00:00:00.000Z";
const submitNotAfter = "2026-08-31T01:00:00.000Z";
const instance = "filmos_instance_22222222-2222-4222-8222-222222222222";

describe("V2.4 production generation composition", () => {
    test("Pilot release policy fails closed before every real or paid submit", () => {
        const pilot = productionReleasePolicyFromEnvironment("false");
        expect(() => assertProductionReleaseSubmitAllowed({ policy: pilot, engineId: "dreamina_cli", estimatedCostMicrounits: "0" }))
            .toThrow("PILOT_EXTERNAL_PAID_SUBMIT_DISABLED");
        expect(() => assertProductionReleaseSubmitAllowed({ policy: pilot, engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, estimatedCostMicrounits: "1" }))
            .toThrow("PILOT_EXTERNAL_PAID_SUBMIT_DISABLED");
        expect(() => assertProductionReleaseSubmitAllowed({ policy: pilot, engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, estimatedCostMicrounits: "0" }))
            .not.toThrow();
        expect(() => assertProductionReleaseSubmitAllowed({ policy: productionReleasePolicyFromEnvironment("true"), engineId: "dreamina_cli", estimatedCostMicrounits: "1" }))
            .not.toThrow();
    });

    test("Pilot paid-submit policy cannot be bypassed through executeAuthorized", async () => {
        const fixture = await createFixture();
        const authority = new LocalProductionGenerationAuthority();
        const backing = new FilmOSMockGenerationProvider();
        const provider = {
            engineId: backing.engineId,
            supportsHardLockedReferences: backing.supportsHardLockedReferences,
            doctor: backing.doctor.bind(backing),
            getConnectionScope: backing.getConnectionScope.bind(backing),
            refreshCatalog: backing.refreshCatalog.bind(backing),
            preview: async () => ({ costUnit: "mock", estimatedCostMicrounits: "1", estimateAvailable: true, externalWritePerformed: false as const }),
            submit: backing.submit.bind(backing),
            getStatus: backing.getStatus.bind(backing),
            reconcile: backing.reconcile.bind(backing),
            downloadOutputs: backing.downloadOutputs.bind(backing),
        };
        let id = 0;
        const composition = new ProductionGenerationService(
            authority,
            new Map([[provider.engineId, provider]]),
            (prefix) => `${prefix}-pilot-${++id}`,
            () => at,
            productionReleasePolicyFromEnvironment("false"),
        );
        const preview = await composition.preview({ ...fixture.previewInput, generationAttemptId: "attempt-pilot-paid-bypass" });
        const broker = await canonicalGenerationBrokerAuthorization("composition-pilot-paid-bypass");
        await expect(composition.executeAuthorized({ proposalId: preview.proposal.proposalId, ...broker, ...fixture.approvalInput }))
            .rejects.toThrow("PILOT_EXTERNAL_PAID_SUBMIT_DISABLED");
        expect(backing.submitCount).toBe(0);
        expect(authority.providerReceiptCount()).toBe(0);
    });

    test("reject, approve, exactly-once, stale and restart recovery stay on one production chain", async () => {
        const fixture = await createFixture();
        const authority = new LocalProductionGenerationAuthority();
        const provider = new FilmOSMockGenerationProvider();
        let id = 0;
        const composition = new ProductionGenerationService(authority, new Map([[provider.engineId, provider]]), (prefix) => `${prefix}-${++id}`, () => at);

        const rejected = await composition.preview({ ...fixture.previewInput, generationAttemptId: "attempt-reject" });
        const rejectedTrace = await composition.reject(rejected.proposal.proposalId, "decision-reject");
        expect(rejectedTrace).toMatchObject({ event: "confirmation.rejected", brokerDecision: "rejected", externalCostMicrounits: "0", externalWrite: false });
        expect(authority.rejectionCount()).toBe(1);
        expect(provider.submitCount).toBe(0);
        expect(authority.providerReceiptCount()).toBe(0);

        const approvedPreview = await composition.preview({ ...fixture.previewInput, generationAttemptId: "attempt-approved" });
        const broker = await canonicalGenerationBrokerAuthorization("composition-approve");
        const toolResult = await executeCanonicalGenerationTool("generation_submit", { proposalId: approvedPreview.proposal.proposalId }, {
            projectId: fixture.previewInput.projectId,
            config: structuredClone(defaultConfig),
            routingConfig: null,
            snapshot: { revision: 1, nodes: [], connections: [], selectedNodeIds: [] },
            productionPort: { executeAuthorized: (input) => composition.executeAuthorized({ ...input, grant: fixture.approvalInput.grant, ledger: fixture.approvalInput.ledger, submitNotAfter }) },
            brokerAuthorization: broker,
        });
        expect(toolResult.ok).toBe(true);
        if (!toolResult.ok) throw new Error(toolResult.message);
        const result = toolResult.data as Awaited<ReturnType<ProductionGenerationService["submitAuthorized"]>>;
        const duplicate = await composition.submitAuthorized(result.receipt.authorizedSubmissionId);
        expect(provider.submitCount).toBe(1);
        expect(result.receipt.contentHash).toBe(duplicate.receipt.contentHash);
        expect(authority.providerReceiptCount()).toBe(1);
        expect(authority.candidateCount()).toBe(1);
        expect(result.candidate).toMatchObject({ qcState: "pending", approvalState: "not_approved" });
        expect(result.trace.map((item) => item.event)).toEqual([
            "draft.created", "descriptor.resolved", "prompt.compiled", "route.snapshotted", "proposal.previewed",
            "confirmation.approved", "catalog.validated", "input.authorized", "budget.reserved", "submission.authorized",
            "provider.submitted", "provider.succeeded", "output.downloaded", "candidate.imported", "qc.pending",
        ]);
        expect(result.trace.every((item) => item.externalCostMicrounits === "0" && item.externalWrite === false)).toBe(true);

        const stalePreview = await composition.preview({ ...fixture.previewInput, generationAttemptId: "attempt-stale" });
        authority.setGuard("canvas_state:canvas-acceptance:node-image-1", { version: 2, contentHash: "changed-canvas-hash" });
        await expect(composition.executeAuthorized({ proposalId: stalePreview.proposal.proposalId, ...fixture.approvalInput })).rejects.toThrow("GENERATION_SUBMISSION_STALE");
        expect(provider.submitCount).toBe(1);
        authority.setGuard("canvas_state:canvas-acceptance:node-image-1", { version: 1, contentHash: "canvas-state-hash" });

        const restartedAuthority = new LocalProductionGenerationAuthority(authority.snapshot());
        const restartedProvider = new FilmOSMockGenerationProvider();
        const restarted = new ProductionGenerationService(restartedAuthority, new Map([[restartedProvider.engineId, restartedProvider]]), (prefix) => `${prefix}-restart`, () => at);
        expect((await restarted.recover("attempt-approved")).contentHash).toBe(result.candidate.contentHash);
        const recoveredSubmit = await restarted.submitAuthorized(result.receipt.authorizedSubmissionId);
        expect(recoveredSubmit.receipt.contentHash).toBe(result.receipt.contentHash);
        expect(restartedProvider.submitCount).toBe(0);

        const traceOutput = process.env.FILMOS_PRODUCTION_TRACE_OUTPUT;
        if (traceOutput) {
            await Bun.write(traceOutput, JSON.stringify({
                schema_version: "1.0.0",
                golden_case_id: "PRODUCTION-GENERATION-COMPOSITION-001",
                status: "PASSED",
                project_name: FILMOS_ACCEPTANCE_PROJECT_NAME,
                engine_id: FILMOS_MOCK_GENERATION_ENGINE_ID,
                rounds: {
                    reject: { decision_event: rejectedTrace, provider_submit_count: 0, provider_receipt_count: 0 },
                    approve: { trace: result.trace, provider_submit_count: provider.submitCount, provider_receipt: result.receipt, candidate: result.candidate },
                    stale: { blocked_code: "GENERATION_SUBMISSION_STALE", provider_submit_delta: 0 },
                    restart: { candidate_content_hash: recoveredSubmit.candidate.contentHash, provider_submit_count: restartedProvider.submitCount, duplicate_receipt_content_hash: recoveredSubmit.receipt.contentHash },
                },
                external_network_request_count: 0,
                external_spend_microunits: "0",
                candidate_approved_count: 0,
                canonical_broker: {
                    confirmation_id: broker.confirmationId,
                    broker_grant_id: broker.brokerGrantId,
                    broker_grant_content_hash: broker.brokerGrantContentHash,
                    broker_decision_receipt_id: broker.brokerDecisionReceiptId,
                    broker_decision_receipt_content_hash: broker.brokerDecisionReceiptContentHash,
                    tool_request_id: broker.toolRequestId,
                },
                synthetic_broker_receipt_count: 0,
            }, null, 2) + "\n");
        }
    });

    test("hard-locked references and tampered authorization fail before provider submit", async () => {
        const fixture = await createFixture();
        const authority = new LocalProductionGenerationAuthority();
        const backingProvider = new FilmOSMockGenerationProvider();
        const unsupportedProvider = {
            engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
            supportsHardLockedReferences: false,
            doctor: backingProvider.doctor.bind(backingProvider),
            getConnectionScope: backingProvider.getConnectionScope.bind(backingProvider),
            refreshCatalog: backingProvider.refreshCatalog.bind(backingProvider),
            preview: backingProvider.preview.bind(backingProvider),
            submit: backingProvider.submit.bind(backingProvider),
            getStatus: backingProvider.getStatus.bind(backingProvider),
            reconcile: backingProvider.reconcile.bind(backingProvider),
            downloadOutputs: backingProvider.downloadOutputs.bind(backingProvider),
        };
        let id = 0;
        const composition = new ProductionGenerationService(authority, new Map([[unsupportedProvider.engineId, unsupportedProvider]]), (prefix) => `${prefix}-hard-lock-${++id}`, () => at);
        const preview = await composition.preview({ ...fixture.previewInput, generationAttemptId: "attempt-hard-lock" });
        const broker = await canonicalGenerationBrokerAuthorization("composition-hard-lock");
        await expect(composition.executeAuthorized({ proposalId: preview.proposal.proposalId, ...broker, ...fixture.approvalInput })).rejects.toThrow("GENERATION_REFERENCE_HARD_LOCK_UNSUPPORTED");
        expect(backingProvider.submitCount).toBe(0);

        const snapshot = authority.snapshot();
        snapshot.authorizations[0].authorizedSubmission.contentHash = "f".repeat(64);
        const tampered = new ProductionGenerationService(new LocalProductionGenerationAuthority(snapshot), new Map([[backingProvider.engineId, backingProvider]]), undefined, () => at);
        await expect(tampered.submitAuthorized(snapshot.authorizations[0].authorizedSubmission.authorizedSubmissionId)).rejects.toThrow("AUTHORIZED_GENERATION_SUBMISSION_TAMPERED");
        expect(backingProvider.submitCount).toBe(0);

        await updateMachineTrace({
            hard_lock_unsupported_blocked: true,
            tampered_authorization_blocked: true,
        });
    });

    test("route precedence is explicit, node, project, global and then fail-closed", async () => {
        const fixture = await createFixture();
        const route = (suffix: string) => ({
            engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
            connectionId: "mock-local",
            modelId: `mock-${suffix}`,
        });
        const projectPolicy = {
            ...fixture.previewInput.projectPolicy,
            defaultRoutes: { text_to_image: route("project") },
        } satisfies ProjectGenerationPolicy;

        expect(selectEffectiveGenerationRoute({
            taskKind: "text_to_image",
            explicitTask: route("explicit"),
            nodeOverride: route("node"),
            projectPolicy,
            globalDefault: route("global"),
        })).toMatchObject({ modelId: "mock-explicit", selectionSource: "explicit_task" });
        expect(selectEffectiveGenerationRoute({
            taskKind: "text_to_image",
            nodeOverride: route("node"),
            projectPolicy,
            globalDefault: route("global"),
        })).toMatchObject({ modelId: "mock-node", selectionSource: "node_override" });
        expect(selectEffectiveGenerationRoute({
            taskKind: "text_to_image",
            projectPolicy,
            globalDefault: route("global"),
        })).toMatchObject({ modelId: "mock-project", selectionSource: "project_default" });
        expect(selectEffectiveGenerationRoute({
            taskKind: "text_to_image",
            globalDefault: route("global"),
        })).toMatchObject({ modelId: "mock-global", selectionSource: "global_default" });
        expect(() => selectEffectiveGenerationRoute({ taskKind: "text_to_image" })).toThrow("GENERATION_ROUTE_NEEDS_CONFIGURATION");

        await updateMachineTrace({
            route_precedence_verified: ["explicit_task", "node_override", "project_default", "global_default"],
            route_missing_fails_closed: true,
        });
    });
});

async function updateMachineTrace(values: Record<string, unknown>) {
    const traceOutput = process.env.FILMOS_PRODUCTION_TRACE_OUTPUT;
    if (!traceOutput) return;
    const file = Bun.file(traceOutput);
    const trace = await file.json() as Record<string, unknown>;
    await Bun.write(traceOutput, JSON.stringify({ ...trace, ...values }, null, 2) + "\n");
}

async function createFixture() {
    const modelDescriptorHash = await hashProjection("generation-model-descriptor", "semantic", { engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, modelId: "mock-image-v1" });
    const parameterSchema = { type: "object", properties: { aspectRatio: { enum: ["9:16"] }, resolution: { enum: ["1080p"] } }, additionalProperties: false };
    const parameterSchemaHash = await hashProjection("generation-parameter-schema", "semantic", parameterSchema);
    const catalogBase = {
        schemaVersion: 1 as const, snapshotId: "catalog-mock-1", observedAt: at, expiresAt: submitNotAfter,
        engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, connectionId: "mock-local", authScope: "local_instance", connectionInstanceRef: instance,
        catalogRevision: "mock-r1", catalogValidUntil: submitNotAfter,
        evidence: { source: "runtime_discovery" as const, runtimeVersion: "filmos-mock-1", sourceLocatorId: "local-acceptance-harness", observedAt: at },
        models: [{ schemaVersion: 1 as const, engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, connectionId: "mock-local", modelId: "mock-image-v1", providerModelId: "mock-image-v1", displayName: "Mock Image V1", modelVersion: "1", capability: "image" as const, operations: ["text_to_image" as const], parameterSchema, constraints: { supportedAspectRatios: ["9:16"], supportedResolutionTiers: ["1080p"], minReferences: 1, maxReferences: 1 }, billing: { mode: "per_request" as const, estimateAvailable: true, currencyOrUnit: "mock" }, availability: "available" as const, descriptorHash: modelDescriptorHash, parameterSchemaHash }],
        workflows: [], skills: [],
    };
    const catalog = { ...catalogBase, contentHash: await hashEnvelope("generation-catalog", catalogBase) } satisfies GenerationCatalogSnapshot;
    const connectionBase = { schemaVersion: 1 as const, entityVersion: 1, connectionId: "mock-local", engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, enabled: true, authScope: "local_instance" as const, status: "ready" as const, connectionInstanceRef: instance, createdAt: at, updatedAt: at };
    const connection = { ...connectionBase, contentHash: await hashEnvelope("generation-engine-connection", connectionBase) } satisfies GenerationEngineConnection;
    const policyBase = { schemaVersion: 1 as const, entityVersion: 1, projectId: "project-acceptance", allowedEngineIds: [FILMOS_MOCK_GENERATION_ENGINE_ID], defaultRoutes: { text_to_image: { engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, connectionId: "mock-local", modelId: "mock-image-v1" } }, externalProjectBindings: {}, uploadPolicy: { allowProviderUpload: false, requirePerSubmitPreview: true }, createdAt: at, updatedAt: at };
    const projectPolicy = { ...policyBase, contentHash: await hashProjectGenerationPolicy(policyBase) } satisfies ProjectGenerationPolicy;
    const lockBase = { schemaVersion: 1 as const, entityVersion: 1, projectId: "project-acceptance", taskLocks: { text_to_image: { engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, connectionId: "mock-local", modelId: "mock-image-v1", providerModelId: "mock-image-v1", modelVersion: "1", modelDescriptorHash, catalogRevision: "mock-r1", enforcement: "strict" as const } }, createdAt: at, updatedAt: at };
    const projectLock = { ...lockBase, contentHash: await hashProjectGenerationLock(lockBase) } satisfies ProjectGenerationLock;
    const grantBase = { schemaVersion: 1 as const, entityVersion: 1, grantId: "grant-mock", projectId: "project-acceptance", engineId: FILMOS_MOCK_GENERATION_ENGINE_ID, connectionId: "mock-local", connectionInstanceRef: instance, status: "active" as const, bindingRevision: 1, allowedModelIds: ["mock-image-v1"], allowedTaskKinds: ["text_to_image" as const], maxTasks: 10, maxTotalCost: { unit: "mock", amountMicrounits: "0" }, expiresAt: submitNotAfter, grantedByActorRef: "human-acceptance", brokerGrantId: "broker-grant-mock", confirmationId: "confirmation-mock", createdAt: at, updatedAt: at };
    const grant = { ...grantBase, contentHash: await hashEnvelope("generation-budget-grant", grantBase) } satisfies GenerationBudgetGrant;
    const ledgerBase = { schemaVersion: 1 as const, entityVersion: 1, ledgerId: "ledger-mock", grantId: grant.grantId, projectId: grant.projectId, engineId: grant.engineId, connectionId: grant.connectionId, connectionInstanceRef: instance, costUnit: "mock", reservedTasks: 0, reservedCostMicrounits: "0", consumedTasks: 0, consumedCostMicrounits: "0", openReservationIds: [], lastEventSequence: 0, status: "active" as const, createdAt: at, updatedAt: at };
    const ledger = { ...ledgerBase, contentHash: await hashEnvelope("budget-ledger", ledgerBase) } satisfies BudgetLedger;
    const guards = {
        primaryTarget: { guardKind: "canvas_state" as const, canvasId: "canvas-acceptance", nodeId: "node-image-1", expectedRevision: 1, expectedStateHash: "canvas-state-hash" },
        promptDraft: { guardKind: "versioned_entity" as const, entityType: "prompt_draft" as const, entityId: "prompt-draft-1", expectedVersion: 1, expectedContentHash: "prompt-draft-hash" },
        projectPolicy: { guardKind: "versioned_entity" as const, entityType: "project_generation_policy" as const, entityId: projectPolicy.projectId, expectedVersion: 1, expectedContentHash: projectPolicy.contentHash },
        engineConnection: { guardKind: "versioned_entity" as const, entityType: "generation_engine_connection" as const, entityId: connection.connectionId, expectedVersion: 1, expectedContentHash: connection.contentHash },
        projectLock: { guardKind: "versioned_entity" as const, entityType: "project_generation_lock" as const, entityId: projectLock.projectId, expectedVersion: 1, expectedContentHash: projectLock.contentHash },
        budgetGrant: { guardKind: "versioned_entity" as const, entityType: "generation_budget_grant" as const, entityId: grant.grantId, expectedVersion: 1, expectedContentHash: grant.contentHash },
        dependencies: [],
    };
    return {
        previewInput: {
            projectId: "project-acceptance", projectName: FILMOS_ACCEPTANCE_PROJECT_NAME, nodeId: "node-image-1", generationAttemptId: "attempt-placeholder", taskKind: "text_to_image" as const,
            projectPolicy, projectLock, connection, catalog,
            promptIntent: { subject: ["locked subject"], identityLocks: ["same identity"], action: ["standing"], environment: ["studio"], sceneLayout: [], camera: ["medium shot"], lens: [], composition: ["centered"], lighting: ["soft"], color: [], continuity: [], negativeConstraints: ["no watermark"], deliveryRequirements: ["9:16", "1080p"] },
            references: [{ bindingId: "binding-random", role: "subject_identity" as const, assetId: "asset-1", assetVersionId: "asset-version-1", assetVersionContentHash: "a".repeat(64), mediaType: "image/png", ordinal: 0, preparedRepresentationId: "prepared-1", preparedRepresentationContentHash: "b".repeat(64), weightMicrounits: 1_000_000, hardLock: true }],
            normalizedParameters: { aspectRatio: "9:16", resolution: "1080p" }, promptDraftVersion: 1, promptDraftContentHash: "prompt-draft-hash", nodeDraftVersion: 1, userConfigRevision: "config-r1", guards,
        },
        approvalInput: { grant, ledger, submitNotAfter },
    };
}

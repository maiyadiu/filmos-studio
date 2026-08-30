import {
    hashEnvelope,
    hashProjectGenerationLock,
    hashProjectGenerationPolicy,
    hashProjection,
    type BudgetLedger,
    type GenerationBudgetGrant,
    type GenerationCatalogSnapshot,
    type GenerationEngineConnection,
    type GenerationExecutionGuardSet,
    type GenerationReferenceBinding,
    type ProjectGenerationLock,
    type ProjectGenerationPolicy,
} from "@filmos/generation-contracts";

import { hashCanvasAgentSnapshot, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { FilmCoreHttpProductionGenerationAuthority } from "./film-core-production-authority";
import {
    FILMOS_ACCEPTANCE_PROJECT_NAME,
    FILMOS_MOCK_GENERATION_ENGINE_ID,
    FilmOSMockGenerationProvider,
    ProductionGenerationComposition,
    type ProductionPreviewBundle,
} from "./production-composition";

export const FILMOS_ACCEPTANCE_PROJECT_ID = "filmos-acceptance-project-v1";
export const FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID = "filmos-acceptance-mock-local";
export const FILMOS_ACCEPTANCE_MOCK_MODEL_ID = "filmos-acceptance-mock-image-v1";

const authorityCreatedAt = "2026-08-31T00:00:00.000Z";
const authorityExpiresAt = "2099-01-01T00:00:00.000Z";
const connectionInstanceRef = "filmos_instance_33333333-3333-4333-8333-333333333333";

export type AcceptanceMockBindings = {
    connection: GenerationEngineConnection;
    catalog: GenerationCatalogSnapshot;
    projectPolicy: ProjectGenerationPolicy;
    projectLock: ProjectGenerationLock;
    grant: GenerationBudgetGrant;
    ledger: BudgetLedger;
};

export function isAcceptanceProductionProject(input: { projectId: string; domainProjectId?: string; projectName: string }): boolean {
    return input.projectName === FILMOS_ACCEPTANCE_PROJECT_NAME
        && (input.projectId === FILMOS_ACCEPTANCE_PROJECT_ID || input.domainProjectId === FILMOS_ACCEPTANCE_PROJECT_ID);
}

export async function createAcceptanceMockBindings(projectId = FILMOS_ACCEPTANCE_PROJECT_ID): Promise<AcceptanceMockBindings> {
    const parameterSchema = {
        type: "object",
        properties: {
            aspectRatio: { type: "string", enum: ["9:16"] },
            resolution: { type: "string", enum: ["1080p"] },
        },
        required: ["aspectRatio", "resolution"],
        additionalProperties: false,
    };
    const descriptorSemantic = {
        engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
        connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
        modelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
        providerModelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
        modelVersion: "1",
        capability: "image",
    };
    const descriptorHash = await hashProjection("generation-model-descriptor", "semantic", descriptorSemantic);
    const parameterSchemaHash = await hashProjection("generation-parameter-schema", "semantic", parameterSchema);
    const catalogBase = {
        schemaVersion: 1 as const,
        snapshotId: "catalog-filmos-acceptance-mock-v1",
        observedAt: authorityCreatedAt,
        expiresAt: authorityExpiresAt,
        engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
        connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
        authScope: "local_instance",
        connectionInstanceRef,
        catalogRevision: "filmos-acceptance-mock-r1",
        catalogValidUntil: authorityExpiresAt,
        evidence: {
            source: "runtime_discovery" as const,
            runtimeVersion: "filmos-candidate-mock-v1",
            sourceLocatorId: "filmos-acceptance-project-only",
            observedAt: authorityCreatedAt,
        },
        models: [{
            schemaVersion: 1 as const,
            engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
            connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
            modelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
            providerModelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
            displayName: "FilmOS Acceptance Mock Image V1",
            modelVersion: "1",
            capability: "image" as const,
            operations: ["text_to_image" as const],
            parameterSchema,
            constraints: {
                supportedAspectRatios: ["9:16"],
                supportedResolutionTiers: ["1080p"],
                minReferences: 1,
                maxReferences: 8,
            },
            billing: { mode: "per_request" as const, estimateAvailable: true, currencyOrUnit: "mock" },
            availability: "available" as const,
            descriptorHash,
            parameterSchemaHash,
        }],
        workflows: [],
        skills: [],
    };
    const catalog = { ...catalogBase, contentHash: await hashEnvelope("generation-catalog", catalogBase) } satisfies GenerationCatalogSnapshot;
    const connectionBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
        engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
        enabled: true,
        authScope: "local_instance" as const,
        status: "ready" as const,
        connectionInstanceRef,
        createdAt: authorityCreatedAt,
        updatedAt: authorityCreatedAt,
    };
    const connection = { ...connectionBase, contentHash: await hashEnvelope("generation-engine-connection", connectionBase) } satisfies GenerationEngineConnection;
    const projectPolicyBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        projectId,
        allowedEngineIds: [FILMOS_MOCK_GENERATION_ENGINE_ID],
        defaultRoutes: {
            text_to_image: {
                engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
                connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
                modelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
            },
        },
        externalProjectBindings: {},
        uploadPolicy: { allowProviderUpload: false, requirePerSubmitPreview: true },
        createdAt: authorityCreatedAt,
        updatedAt: authorityCreatedAt,
    };
    const projectPolicy = { ...projectPolicyBase, contentHash: await hashProjectGenerationPolicy(projectPolicyBase) } satisfies ProjectGenerationPolicy;
    const projectLockBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        projectId,
        taskLocks: {
            text_to_image: {
                engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
                connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
                modelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
                providerModelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
                modelVersion: "1",
                modelDescriptorHash: descriptorHash,
                catalogRevision: catalog.catalogRevision,
                enforcement: "strict" as const,
            },
        },
        createdAt: authorityCreatedAt,
        updatedAt: authorityCreatedAt,
    };
    const projectLock = { ...projectLockBase, contentHash: await hashProjectGenerationLock(projectLockBase) } satisfies ProjectGenerationLock;
    const grantBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        grantId: "filmos-acceptance-mock-budget-grant",
        projectId,
        engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
        connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
        connectionInstanceRef,
        status: "active" as const,
        bindingRevision: 1,
        allowedModelIds: [FILMOS_ACCEPTANCE_MOCK_MODEL_ID],
        allowedTaskKinds: ["text_to_image" as const],
        maxTasks: 100,
        maxTotalCost: { unit: "mock", amountMicrounits: "0" },
        expiresAt: authorityExpiresAt,
        grantedByActorRef: "human-acceptance",
        brokerGrantId: "filmos-acceptance-mock-broker-grant",
        confirmationId: "filmos-acceptance-mock-confirmation-scope",
        createdAt: authorityCreatedAt,
        updatedAt: authorityCreatedAt,
    };
    const grant = { ...grantBase, contentHash: await hashEnvelope("generation-budget-grant", grantBase) } satisfies GenerationBudgetGrant;
    const ledgerBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        ledgerId: "filmos-acceptance-mock-budget-ledger",
        grantId: grant.grantId,
        projectId,
        engineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
        connectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
        connectionInstanceRef,
        costUnit: "mock",
        reservedTasks: 0,
        reservedCostMicrounits: "0",
        consumedTasks: 0,
        consumedCostMicrounits: "0",
        openReservationIds: [],
        lastEventSequence: 0,
        status: "active" as const,
        createdAt: authorityCreatedAt,
        updatedAt: authorityCreatedAt,
    };
    const ledger = { ...ledgerBase, contentHash: await hashEnvelope("budget-ledger", ledgerBase) } satisfies BudgetLedger;
    return { connection, catalog, projectPolicy, projectLock, grant, ledger };
}

export class AcceptanceProductionRuntime {
    readonly composition: ProductionGenerationComposition;

    private constructor(
        readonly bindings: AcceptanceMockBindings,
        private readonly getSnapshot: () => CanvasAgentSnapshot,
        authority: FilmCoreHttpProductionGenerationAuthority,
    ) {
        const provider = new FilmOSMockGenerationProvider();
        this.composition = new ProductionGenerationComposition(authority, new Map([[provider.engineId, provider]]));
    }

    static async create(input: {
        projectId: string;
        domainProjectId?: string;
        projectName: string;
        getSnapshot: () => CanvasAgentSnapshot;
        filmCoreBaseUrl?: string;
        fetchImpl?: typeof fetch;
    }): Promise<AcceptanceProductionRuntime> {
        if (!isAcceptanceProductionProject(input)) throw new Error("MOCK_PROVIDER_ACCEPTANCE_PROJECT_ONLY");
        const authorityProjectId = input.domainProjectId || input.projectId;
        const proposedBindings = await createAcceptanceMockBindings(authorityProjectId);
        let runtime: AcceptanceProductionRuntime;
        const authority = new FilmCoreHttpProductionGenerationAuthority(
            async (preview) => runtime.currentGuards(preview),
            input.filmCoreBaseUrl,
            input.fetchImpl,
        );
        const bindings = await authority.ensureAcceptanceAuthority(authorityProjectId, input.projectName, proposedBindings);
        runtime = new AcceptanceProductionRuntime(bindings, input.getSnapshot, authority);
        return runtime;
    }

    async preview(input: { nodeId: string; projectName: string; userConfigRevision: string }): Promise<ProductionPreviewBundle> {
        const snapshot = this.getSnapshot();
        const node = requireSnapshotNode(snapshot, input.nodeId);
        const prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        if (!prompt.trim()) throw new Error("GENERATION_PROMPT_REQUIRED");
        const references = await acceptanceReferences(snapshot, input.nodeId);
        if (!references.length) throw new Error("GENERATION_HARD_LOCK_REFERENCE_REQUIRED");
        const draftVersion = node.metadata?.generationDraftVersion || 0;
        const promptHash = await promptDraftHash(prompt);
        const guardStateHash = await acceptanceCanvasGuardHash(snapshot, input.nodeId);
        const projectId = snapshot.domainProjectId || snapshot.projectId;
        const guards: GenerationExecutionGuardSet = {
            primaryTarget: {
                guardKind: "canvas_state",
                canvasId: snapshot.projectId,
                nodeId: input.nodeId,
                expectedRevision: draftVersion,
                expectedStateHash: guardStateHash,
            },
            promptDraft: {
                guardKind: "versioned_entity",
                entityType: "prompt_draft",
                entityId: input.nodeId,
                expectedVersion: draftVersion,
                expectedContentHash: promptHash,
            },
            projectPolicy: versionedGuard("project_generation_policy", this.bindings.projectPolicy.projectId, this.bindings.projectPolicy),
            engineConnection: versionedGuard("generation_engine_connection", this.bindings.connection.connectionId, this.bindings.connection),
            projectLock: versionedGuard("project_generation_lock", this.bindings.projectLock.projectId, this.bindings.projectLock),
            budgetGrant: versionedGuard("generation_budget_grant", this.bindings.grant.grantId, this.bindings.grant),
            dependencies: [
                {
                    guardKind: "versioned_entity",
                    entityType: "generation_catalog_snapshot",
                    entityId: this.bindings.catalog.snapshotId,
                    expectedVersion: 1,
                    expectedContentHash: this.bindings.catalog.contentHash,
                },
                ...references.map((reference) => ({
                    guardKind: "versioned_entity" as const,
                    entityType: "asset_version",
                    entityId: reference.assetVersionId,
                    expectedVersion: 1,
                    expectedContentHash: reference.assetVersionContentHash,
                })),
            ],
        };
        const generationAttemptId = `attempt-${crypto.randomUUID()}`;
        return this.composition.preview({
            projectId,
            projectName: input.projectName,
            nodeId: input.nodeId,
            generationAttemptId,
            taskKind: "text_to_image",
            explicitTask: this.bindings.projectPolicy.defaultRoutes.text_to_image,
            projectPolicy: this.bindings.projectPolicy,
            projectLock: this.bindings.projectLock,
            connection: this.bindings.connection,
            catalog: this.bindings.catalog,
            promptIntent: {
                subject: [prompt], identityLocks: ["hard-locked references"], action: [], environment: [], sceneLayout: [],
                camera: [], lens: [], composition: [], lighting: [], color: [], continuity: [], negativeConstraints: [],
                deliveryRequirements: [node.metadata?.generationNativeSize || "9:16", node.metadata?.generationDeliveryResolution || "1080p"],
            },
            references,
            normalizedParameters: {
                aspectRatio: node.metadata?.generationNativeSize || "9:16",
                resolution: node.metadata?.generationDeliveryResolution || "1080p",
            },
            promptDraftVersion: draftVersion,
            promptDraftContentHash: promptHash,
            nodeDraftVersion: draftVersion,
            userConfigRevision: input.userConfigRevision,
            guards,
        });
    }

    reject(proposalId: string) {
        return this.composition.reject(proposalId);
    }

    async approve(proposalId: string) {
        const confirmationId = `confirmation-${crypto.randomUUID()}`;
        const brokerDecisionReceiptId = `broker-decision-${crypto.randomUUID()}`;
        const toolRequestId = `tool-request-${crypto.randomUUID()}`;
        const submitNotAfter = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const brokerGrantContentHash = await hashProjection("broker-grant", "envelope", { brokerGrantId: this.bindings.grant.brokerGrantId, proposalId, confirmationId });
        const brokerDecisionReceiptContentHash = await hashProjection("broker-decision", "envelope", { brokerDecisionReceiptId, proposalId, confirmationId, decision: "approved" });
        return this.composition.approve({
            proposalId,
            actorRef: "human-acceptance",
            confirmationId,
            brokerGrantId: this.bindings.grant.brokerGrantId,
            brokerGrantContentHash,
            brokerDecisionReceiptId,
            brokerDecisionReceiptContentHash,
            toolRequestId,
            grant: this.bindings.grant,
            ledger: this.bindings.ledger,
            submitNotAfter,
        });
    }

    submitAuthorized(authorizedSubmissionId: string) {
        return this.composition.submitAuthorized(authorizedSubmissionId);
    }

    recover(generationAttemptId: string) {
        return this.composition.recover(generationAttemptId);
    }

    private async currentGuards(preview?: ProductionPreviewBundle) {
        const map = new Map<string, { version: number; contentHash: string }>();
        if (!preview) return map;
        for (const guard of [preview.guards.projectPolicy, preview.guards.engineConnection, ...(preview.guards.projectLock ? [preview.guards.projectLock] : []), ...(preview.guards.budgetGrant ? [preview.guards.budgetGrant] : []), ...preview.guards.dependencies]) {
            if (guard.guardKind === "canvas_state") {
                map.set(`canvas_state:${guard.canvasId}:${guard.nodeId ?? ""}`, { version: guard.expectedRevision, contentHash: guard.expectedStateHash });
            } else {
                map.set(`versioned_entity:${guard.entityType}:${guard.entityId}`, { version: guard.expectedVersion, contentHash: guard.expectedContentHash });
            }
        }
        const snapshot = this.getSnapshot();
        const node = requireSnapshotNode(snapshot, preview.nodeId);
        const prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        const draftVersion = node.metadata?.generationDraftVersion || 0;
        map.set(`canvas_state:${snapshot.projectId}:${preview.nodeId}`, {
            version: draftVersion,
            contentHash: await acceptanceCanvasGuardHash(snapshot, preview.nodeId),
        });
        map.set(`versioned_entity:prompt_draft:${preview.nodeId}`, {
            version: draftVersion,
            contentHash: await promptDraftHash(prompt),
        });
        return map;
    }
}

function versionedGuard<const E extends string, T extends { entityVersion: number; contentHash: string }>(entityType: E, entityId: string, record: T) {
    return {
        guardKind: "versioned_entity" as const,
        entityType,
        entityId,
        expectedVersion: record.entityVersion,
        expectedContentHash: record.contentHash,
    };
}

function requireSnapshotNode(snapshot: CanvasAgentSnapshot, nodeId: string): CanvasNodeData {
    const node = snapshot.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("GENERATION_TARGET_NODE_NOT_FOUND");
    return node;
}

async function promptDraftHash(prompt: string) {
    return hashProjection("prompt-draft", "semantic", { prompt });
}

async function acceptanceCanvasGuardHash(snapshot: CanvasAgentSnapshot, nodeId: string) {
    const node = requireSnapshotNode(snapshot, nodeId);
    const references = await acceptanceReferences(snapshot, nodeId);
    return hashProjection("acceptance-generation-canvas-guard", "semantic", {
        projectId: snapshot.projectId,
        domainProjectId: snapshot.domainProjectId,
        nodeId,
        draftVersion: node.metadata?.generationDraftVersion || 0,
        prompt: node.metadata?.composerContent ?? node.metadata?.prompt ?? "",
        nativeSize: node.metadata?.generationNativeSize || "9:16",
        deliveryResolution: node.metadata?.generationDeliveryResolution || "1080p",
        references: references.map(({ bindingId: _bindingId, ...reference }) => reference),
        legacyCanvasStateHash: hashCanvasAgentSnapshot({ ...snapshot, nodes: [], connections: [] }),
    });
}

async function acceptanceReferences(snapshot: CanvasAgentSnapshot, nodeId: string): Promise<GenerationReferenceBinding[]> {
    const sourceIds = snapshot.connections.filter((item) => item.toNodeId === nodeId).map((item) => item.fromNodeId);
    const sources = sourceIds.map((id) => snapshot.nodes.find((item) => item.id === id)).filter((item): item is CanvasNodeData => Boolean(item));
    const media = sources.filter((node) => node.type === CanvasNodeType.Image || node.metadata?.workflowKind === "character");
    return Promise.all(media.map(async (node, ordinal) => {
        const assetId = node.metadata?.assetId || `canvas-asset-${node.id}`;
        const assetVersionId = `asset-version-${node.metadata?.assetId || node.id}`;
        const assetVersionContentHash = await hashProjection("acceptance-asset-version", "semantic", {
            assetId,
            nodeId: node.id,
            storageKey: node.metadata?.storageKey || "local-canvas",
            mimeType: node.metadata?.mimeType || "image/png",
            title: node.title,
        });
        const preparedRepresentationId = `prepared-${assetVersionContentHash.slice(0, 24)}`;
        const preparedRepresentationContentHash = await hashProjection("acceptance-prepared-representation", "semantic", {
            assetVersionId,
            assetVersionContentHash,
            mediaType: node.metadata?.mimeType || "image/png",
        });
        return {
            bindingId: `binding-${node.id}`,
            role: "subject_identity" as const,
            assetId,
            assetVersionId,
            assetVersionContentHash,
            mediaType: node.metadata?.mimeType || "image/png",
            ordinal,
            preparedRepresentationId,
            preparedRepresentationContentHash,
            weightMicrounits: 1_000_000,
            hardLock: true,
        };
    }));
}

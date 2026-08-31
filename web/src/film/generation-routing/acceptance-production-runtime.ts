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

import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import {
    FILMOS_ACCEPTANCE_PROJECT_NAME,
    FILMOS_MOCK_GENERATION_ENGINE_ID,
    FilmOSMockGenerationProvider,
    type ProductionAuthorizedCommand,
} from "./production-composition";
import {
    createProjectAuthorizedCommand,
    createProjectProductionFixture,
    type ProjectProductionBindings,
    type ProjectProductionFixture,
} from "./project-production-runtime";

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

export type AcceptanceProviderFixture = ProjectProductionFixture & { bindings: AcceptanceMockBindings };

export async function createAcceptanceProviderFixture(input: {
    projectId: string;
    domainProjectId?: string;
    projectName: string;
    getSnapshot: () => CanvasAgentSnapshot;
    filmCoreBaseUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<AcceptanceProviderFixture> {
    if (!isAcceptanceProductionProject(input)) throw new Error("MOCK_PROVIDER_ACCEPTANCE_PROJECT_ONLY");
    const authorityProjectId = input.domainProjectId || input.projectId;
    const provider = new FilmOSMockGenerationProvider();
    return await createProjectProductionFixture({
        ...input,
        proposedBindings: await createAcceptanceMockBindings(authorityProjectId),
        providers: new Map([[provider.engineId, provider]]),
        requireHardLockReference: true,
    }) as AcceptanceProviderFixture;
}

export function createAcceptanceAuthorizedCommand(
    fixture: AcceptanceProviderFixture,
    input: Omit<ProductionAuthorizedCommand, "grant" | "ledger" | "submitNotAfter"> & { confirmedAt: string },
): ProductionAuthorizedCommand {
    return createProjectAuthorizedCommand(fixture as ProjectProductionFixture, input);
}

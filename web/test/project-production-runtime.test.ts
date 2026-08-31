import { describe, expect, test } from "bun:test";

import { hashEnvelope, hashProjection, type GenerationCatalogSnapshot, type GenerationEngineConnection } from "@filmos/generation-contracts";
import { LocalProductionGenerationAuthority } from "@/film/generation-routing/local-production-authority";
import { BoundProductionGenerationProviderAdapter } from "@/film/generation-routing/production-provider-adapters";
import { buildProjectProductionBindings } from "@/film/generation-routing/project-production-authority-builder";
import { ProductionGenerationService } from "@/film/generation-routing/production-composition";

const projectId = "ordinary-project-production-dry-run";
const connectionId = "dreamina-local-ordinary";
const instanceRef = "filmos_instance_55555555-5555-4555-8555-555555555555";
const now = "2026-08-31T08:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";

describe("ordinary project production authority", () => {
    test("uses the same ProductionGenerationService and bound adapter without the Acceptance Mock", async () => {
        const connection = await readyConnection();
        const catalog = await readyCatalog();
        const route = { engineId: "dreamina_cli", connectionId, modelId: "seedream-v1" };
        const bindings = await buildProjectProductionBindings({
            projectId,
            connection,
            catalog,
            taskKind: "text_to_image",
            route,
            defaultBrainProfileId: "codex.subscription",
            allowedBrainProfileIds: ["codex.subscription", "chatgpt.subscription.host"],
            strictLock: true,
            allowProviderUpload: false,
            maxTasks: 5,
            maxTotalCostMicrounits: "1000000",
            costUnit: "credits",
            now,
        });
        const authority = new LocalProductionGenerationAuthority();
        const adapter = new BoundProductionGenerationProviderAdapter({
            engineId: "dreamina_cli",
            connection,
            catalog,
            supportsHardLockedReferences: true,
        });
        const service = new ProductionGenerationService(authority, new Map([[adapter.engineId, adapter]]), (prefix) => `${prefix}-ordinary`, () => now);
        const promptHash = await hashProjection("prompt-draft", "semantic", { prompt: "ordinary dry-run" });
        const canvasHash = await hashProjection("canvas-state", "semantic", { projectId, nodeId: "config-1" });
        const preview = await service.preview({
            projectId,
            projectName: "Ordinary Production Project",
            nodeId: "config-1",
            generationAttemptId: "attempt-ordinary-dry-run",
            taskKind: "text_to_image",
            explicitTask: route,
            projectPolicy: bindings.projectPolicy,
            projectLock: bindings.projectLock,
            connection,
            catalog,
            promptIntent: {
                subject: ["ordinary dry-run"], identityLocks: [], action: [], environment: [], sceneLayout: [], camera: [], lens: [], composition: [], lighting: [], color: [], continuity: [], negativeConstraints: [], deliveryRequirements: ["9:16", "1080p"],
            },
            references: [],
            normalizedParameters: { aspectRatio: "9:16", resolution: "1080p" },
            promptDraftVersion: 1,
            promptDraftContentHash: promptHash,
            nodeDraftVersion: 1,
            userConfigRevision: "ordinary-r1",
            guards: {
                primaryTarget: { guardKind: "canvas_state", canvasId: projectId, nodeId: "config-1", expectedRevision: 1, expectedStateHash: canvasHash },
                promptDraft: { guardKind: "versioned_entity", entityType: "prompt_draft", entityId: "config-1", expectedVersion: 1, expectedContentHash: promptHash },
                projectPolicy: { guardKind: "versioned_entity", entityType: "project_generation_policy", entityId: projectId, expectedVersion: 1, expectedContentHash: bindings.projectPolicy.contentHash },
                projectLock: { guardKind: "versioned_entity", entityType: "project_generation_lock", entityId: projectId, expectedVersion: 1, expectedContentHash: bindings.projectLock!.contentHash },
                engineConnection: { guardKind: "versioned_entity", entityType: "generation_engine_connection", entityId: connectionId, expectedVersion: 1, expectedContentHash: connection.contentHash },
                budgetGrant: { guardKind: "versioned_entity", entityType: "generation_budget_grant", entityId: bindings.grant.grantId, expectedVersion: 1, expectedContentHash: bindings.grant.contentHash },
                dependencies: [{ guardKind: "versioned_entity", entityType: "generation_catalog_snapshot", entityId: catalog.snapshotId, expectedVersion: 1, expectedContentHash: catalog.contentHash }],
            },
        });
        expect(preview.routeSnapshot.engineId).toBe("dreamina_cli");
        expect(preview.routeSnapshot.engineId).not.toBe("filmos_mock_generation");
        expect(preview.proposal).toMatchObject({ externalCostMicrounits: "0", externalWritePerformed: false });
        expect(await service.requestSubmit({ proposalId: preview.proposal.proposalId })).toMatchObject({ risk: "paid" });
        expect(authority.providerReceiptCount()).toBe(0);
    });
});

async function readyConnection(): Promise<GenerationEngineConnection> {
    const base = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        connectionId,
        engineId: "dreamina_cli",
        enabled: true,
        authScope: "local_instance" as const,
        status: "ready" as const,
        accountBindingRef: "filmos_acct_55555555-5555-4555-8555-555555555555",
        connectionInstanceRef: instanceRef,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
    };
    return { ...base, contentHash: await hashEnvelope("generation-engine-connection", base) };
}

async function readyCatalog(): Promise<GenerationCatalogSnapshot> {
    const parameterSchema = { type: "object", properties: { aspectRatio: { type: "string" }, resolution: { type: "string" } }, additionalProperties: false };
    const descriptorHash = await hashProjection("generation-model-descriptor", "semantic", { engineId: "dreamina_cli", connectionId, modelId: "seedream-v1", modelVersion: "1" });
    const parameterSchemaHash = await hashProjection("generation-parameter-schema", "semantic", parameterSchema);
    const base = {
        schemaVersion: 1 as const,
        snapshotId: "catalog-dreamina-ordinary-v1",
        observedAt: now,
        expiresAt: future,
        engineId: "dreamina_cli",
        connectionId,
        authScope: "local_instance",
        accountBindingRef: "filmos_acct_55555555-5555-4555-8555-555555555555",
        connectionInstanceRef: instanceRef,
        catalogRevision: "dreamina-ordinary-r1",
        catalogValidUntil: future,
        evidence: { source: "runtime_discovery" as const, runtimeVersion: "dreamina-local-v1", sourceLocatorId: "dreamina-local-runtime", observedAt: now },
        models: [{
            schemaVersion: 1 as const,
            engineId: "dreamina_cli",
            connectionId,
            modelId: "seedream-v1",
            providerModelId: "seedream-v1",
            displayName: "Seedream V1",
            modelVersion: "1",
            capability: "image" as const,
            operations: ["text_to_image" as const],
            parameterSchema,
            constraints: { supportedAspectRatios: ["9:16"], supportedResolutionTiers: ["1080p"] },
            billing: { mode: "credits" as const, estimateAvailable: false, currencyOrUnit: "credits" },
            availability: "available" as const,
            descriptorHash,
            parameterSchemaHash,
        }],
        workflows: [],
        skills: [],
    };
    return { ...base, contentHash: await hashEnvelope("generation-catalog", base) };
}

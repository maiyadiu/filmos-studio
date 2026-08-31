import {
    hashProjection,
    type BudgetLedger,
    type GenerationBudgetGrant,
    type GenerationCatalogSnapshot,
    type GenerationEngineConnection,
    type GenerationExecutionGuardSet,
    type GenerationReferenceBinding,
    type GenerationTaskKind,
    type ProjectBrainPolicy,
    type ProjectGenerationLock,
    type ProjectGenerationPolicy,
} from "@filmos/generation-contracts";

import { hashCanvasAgentSnapshot, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { FilmCoreHttpProductionGenerationAuthority } from "./film-core-production-authority";
import { BoundProductionGenerationProviderAdapter, type ProductionProviderAdapterBinding } from "./production-provider-adapters";
import {
    ProductionGenerationService,
    type ProductionAuthorizedCommand,
    type ProductionGenerationProviderAdapter,
    type ProductionPreviewBundle,
} from "./production-composition";

export type ProjectProductionBindings = {
    brainPolicy?: ProjectBrainPolicy;
    connection: GenerationEngineConnection;
    catalog: GenerationCatalogSnapshot;
    projectPolicy: ProjectGenerationPolicy;
    projectLock?: ProjectGenerationLock;
    grant: GenerationBudgetGrant;
    ledger: BudgetLedger;
};

export type ProjectProductionFixture = {
    bindings: ProjectProductionBindings;
    service: ProductionGenerationService;
    preview(input: {
        nodeId: string;
        projectName: string;
        userConfigRevision: string;
        mode?: CanvasGenerationMode;
    }): Promise<ProductionPreviewBundle>;
};

export async function createProjectProductionFixture(input: {
    projectId: string;
    domainProjectId?: string;
    projectName: string;
    getSnapshot: () => CanvasAgentSnapshot;
    proposedBindings?: ProjectProductionBindings;
    providers?: ReadonlyMap<string, ProductionGenerationProviderAdapter>;
    requireHardLockReference?: boolean;
    filmCoreBaseUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<ProjectProductionFixture> {
    const authorityProjectId = input.domainProjectId || input.projectId;
    let bindings: ProjectProductionBindings | undefined;
    const authority = new FilmCoreHttpProductionGenerationAuthority(
        async (preview) => currentProjectGuards(input.getSnapshot, requireBindings(bindings), preview),
        input.filmCoreBaseUrl,
        input.fetchImpl,
    );
    if (input.proposedBindings) {
        bindings = await authority.ensureProjectAuthority(authorityProjectId, input.projectName, input.proposedBindings);
    } else {
        const stored = await authority.loadProjectAuthority<ProjectProductionBindings>(authorityProjectId);
        if (!stored) throw new Error("PROJECT_GENERATION_AUTHORITY_NOT_CONFIGURED");
        if (stored.projectName !== input.projectName) throw new Error("FILM_CORE_PROJECT_AUTHORITY_NAME_MISMATCH");
        bindings = stored.bindings;
    }
    assertProjectBindings(authorityProjectId, bindings);
    const providers = input.providers ?? defaultProviderMap(bindings);
    const service = new ProductionGenerationService(authority, providers);
    return {
        bindings,
        service,
        async preview(command) {
            const snapshot = input.getSnapshot();
            const node = requireSnapshotNode(snapshot, command.nodeId);
            const prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
            if (!prompt.trim()) throw new Error("GENERATION_PROMPT_REQUIRED");
            const references = await projectReferences(snapshot, command.nodeId);
            if (input.requireHardLockReference && !references.some((reference) => reference.hardLock)) {
                throw new Error("GENERATION_HARD_LOCK_REFERENCE_REQUIRED");
            }
            const taskKind = taskKindForMode(command.mode || node.metadata?.generationMode || "image", references.length > 0);
            const route = nodeRoute(node) ?? bindings!.projectPolicy.defaultRoutes[taskKind];
            if (!route) throw new Error("GENERATION_ROUTE_NEEDS_CONFIGURATION");
            if (route.engineId !== bindings!.connection.engineId || route.connectionId !== bindings!.connection.connectionId) {
                throw new Error("PROJECT_GENERATION_ROUTE_AUTHORITY_MISMATCH");
            }
            const draftVersion = node.metadata?.generationDraftVersion || 0;
            const promptHash = await promptDraftHash(prompt);
            const guardStateHash = await projectCanvasGuardHash(snapshot, command.nodeId);
            const guards = projectExecutionGuards(snapshot, command.nodeId, draftVersion, promptHash, guardStateHash, references, bindings!);
            return service.preview({
                projectId: authorityProjectId,
                projectName: command.projectName,
                nodeId: command.nodeId,
                generationAttemptId: `attempt-${crypto.randomUUID()}`,
                taskKind,
                explicitTask: route,
                projectPolicy: bindings!.projectPolicy,
                projectLock: bindings!.projectLock,
                connection: bindings!.connection,
                catalog: bindings!.catalog,
                promptIntent: {
                    subject: [prompt],
                    identityLocks: references.filter((reference) => reference.hardLock).map((reference) => reference.assetVersionId),
                    action: [], environment: [], sceneLayout: [], camera: [], lens: [], composition: [], lighting: [], color: [], continuity: [], negativeConstraints: [],
                    deliveryRequirements: [node.metadata?.generationNativeSize || "descriptor-default", node.metadata?.generationDeliveryResolution || "descriptor-default"],
                },
                references,
                normalizedParameters: {
                    aspectRatio: node.metadata?.generationNativeSize || "descriptor-default",
                    resolution: node.metadata?.generationDeliveryResolution || "descriptor-default",
                },
                promptDraftVersion: draftVersion,
                promptDraftContentHash: promptHash,
                nodeDraftVersion: draftVersion,
                userConfigRevision: command.userConfigRevision,
                guards,
            });
        },
    };
}

export function createProjectAuthorizedCommand(
    fixture: ProjectProductionFixture,
    input: Omit<ProductionAuthorizedCommand, "grant" | "ledger" | "submitNotAfter"> & { confirmedAt: string },
): ProductionAuthorizedCommand {
    return {
        ...input,
        grant: fixture.bindings.grant,
        ledger: fixture.bindings.ledger,
        submitNotAfter: new Date(Date.parse(input.confirmedAt) + 15 * 60 * 1000).toISOString(),
    };
}

function defaultProviderMap(bindings: ProjectProductionBindings): ReadonlyMap<string, ProductionGenerationProviderAdapter> {
    const adapter = new BoundProductionGenerationProviderAdapter({
        engineId: bindings.connection.engineId as ProductionProviderAdapterBinding["engineId"],
        connection: bindings.connection,
        catalog: bindings.catalog,
        supportsHardLockedReferences: bindings.connection.engineId !== "manual_web",
    });
    return new Map([[adapter.engineId, adapter]]);
}

function assertProjectBindings(projectId: string, bindings: ProjectProductionBindings) {
    if (bindings.projectPolicy.projectId !== projectId || bindings.grant.projectId !== projectId || bindings.ledger.projectId !== projectId) {
        throw new Error("PROJECT_GENERATION_AUTHORITY_SCOPE_MISMATCH");
    }
    if (bindings.projectLock && bindings.projectLock.projectId !== projectId) throw new Error("PROJECT_GENERATION_LOCK_SCOPE_MISMATCH");
    if (bindings.brainPolicy && bindings.brainPolicy.projectId !== projectId) throw new Error("PROJECT_BRAIN_POLICY_SCOPE_MISMATCH");
    if (bindings.connection.engineId !== bindings.catalog.engineId || bindings.connection.connectionId !== bindings.catalog.connectionId) {
        throw new Error("PROJECT_GENERATION_CATALOG_CONNECTION_MISMATCH");
    }
    if (bindings.grant.grantId !== bindings.ledger.grantId || bindings.grant.engineId !== bindings.connection.engineId) {
        throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
    }
}

function requireBindings(bindings: ProjectProductionBindings | undefined): ProjectProductionBindings {
    if (!bindings) throw new Error("PROJECT_GENERATION_AUTHORITY_NOT_CONFIGURED");
    return bindings;
}

async function currentProjectGuards(
    getSnapshot: () => CanvasAgentSnapshot,
    bindings: ProjectProductionBindings,
    preview?: ProductionPreviewBundle,
) {
    const map = new Map<string, { version: number; contentHash: string }>();
    if (!preview) return map;
    for (const guard of [preview.guards.projectPolicy, preview.guards.engineConnection, ...(preview.guards.projectLock ? [preview.guards.projectLock] : []), ...(preview.guards.budgetGrant ? [preview.guards.budgetGrant] : []), ...preview.guards.dependencies]) {
        if (guard.guardKind === "canvas_state") {
            map.set(`canvas_state:${guard.canvasId}:${guard.nodeId ?? ""}`, { version: guard.expectedRevision, contentHash: guard.expectedStateHash });
        } else {
            map.set(`versioned_entity:${guard.entityType}:${guard.entityId}`, { version: guard.expectedVersion, contentHash: guard.expectedContentHash });
        }
    }
    const snapshot = getSnapshot();
    const node = requireSnapshotNode(snapshot, preview.nodeId);
    const prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
    const draftVersion = node.metadata?.generationDraftVersion || 0;
    map.set(`canvas_state:${snapshot.projectId}:${preview.nodeId}`, {
        version: draftVersion,
        contentHash: await projectCanvasGuardHash(snapshot, preview.nodeId),
    });
    map.set(`versioned_entity:prompt_draft:${preview.nodeId}`, { version: draftVersion, contentHash: await promptDraftHash(prompt) });
    map.set(`versioned_entity:project_generation_policy:${bindings.projectPolicy.projectId}`, { version: bindings.projectPolicy.entityVersion, contentHash: bindings.projectPolicy.contentHash });
    return map;
}

function projectExecutionGuards(
    snapshot: CanvasAgentSnapshot,
    nodeId: string,
    draftVersion: number,
    promptHash: string,
    guardStateHash: string,
    references: readonly GenerationReferenceBinding[],
    bindings: ProjectProductionBindings,
): GenerationExecutionGuardSet {
    return {
        primaryTarget: { guardKind: "canvas_state", canvasId: snapshot.projectId, nodeId, expectedRevision: draftVersion, expectedStateHash: guardStateHash },
        promptDraft: { guardKind: "versioned_entity", entityType: "prompt_draft", entityId: nodeId, expectedVersion: draftVersion, expectedContentHash: promptHash },
        projectPolicy: versionedGuard("project_generation_policy", bindings.projectPolicy.projectId, bindings.projectPolicy),
        engineConnection: versionedGuard("generation_engine_connection", bindings.connection.connectionId, bindings.connection),
        ...(bindings.projectLock ? { projectLock: versionedGuard("project_generation_lock", bindings.projectLock.projectId, bindings.projectLock) } : {}),
        budgetGrant: versionedGuard("generation_budget_grant", bindings.grant.grantId, bindings.grant),
        dependencies: [
            { guardKind: "versioned_entity", entityType: "generation_catalog_snapshot", entityId: bindings.catalog.snapshotId, expectedVersion: 1, expectedContentHash: bindings.catalog.contentHash },
            ...references.map((reference) => ({ guardKind: "versioned_entity" as const, entityType: "asset_version", entityId: reference.assetVersionId, expectedVersion: 1, expectedContentHash: reference.assetVersionContentHash })),
        ],
    };
}

function versionedGuard<const E extends string, T extends { entityVersion: number; contentHash: string }>(entityType: E, entityId: string, record: T) {
    return { guardKind: "versioned_entity" as const, entityType, entityId, expectedVersion: record.entityVersion, expectedContentHash: record.contentHash };
}

function requireSnapshotNode(snapshot: CanvasAgentSnapshot, nodeId: string): CanvasNodeData {
    const node = snapshot.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("GENERATION_TARGET_NODE_NOT_FOUND");
    return node;
}

function nodeRoute(node: CanvasNodeData) {
    const engineId = node.metadata?.generationEngineId;
    const connectionId = node.metadata?.generationConnectionId;
    if (!engineId || !connectionId) return undefined;
    const modelId = node.metadata?.generationModelId;
    const workflowId = node.metadata?.generationWorkflowId;
    const skillId = node.metadata?.generationSkillId;
    if (!modelId && !workflowId && !skillId) return undefined;
    return { engineId, connectionId, ...(modelId ? { modelId } : {}), ...(workflowId ? { workflowId } : {}), ...(skillId ? { skillId } : {}) };
}

function taskKindForMode(mode: CanvasGenerationMode, hasReferences: boolean): GenerationTaskKind {
    if (mode === "video") return hasReferences ? "image_to_video" : "text_to_video";
    if (mode === "audio") return "audio";
    if (mode === "image") return hasReferences ? "reference_to_image" : "text_to_image";
    return "workflow";
}

async function promptDraftHash(prompt: string) {
    return hashProjection("prompt-draft", "semantic", { prompt });
}

async function projectCanvasGuardHash(snapshot: CanvasAgentSnapshot, nodeId: string) {
    const node = requireSnapshotNode(snapshot, nodeId);
    const references = await projectReferences(snapshot, nodeId);
    return hashProjection("production-generation-canvas-guard", "semantic", {
        projectId: snapshot.projectId,
        domainProjectId: snapshot.domainProjectId,
        nodeId,
        draftVersion: node.metadata?.generationDraftVersion || 0,
        prompt: node.metadata?.composerContent ?? node.metadata?.prompt ?? "",
        nativeSize: node.metadata?.generationNativeSize || "descriptor-default",
        deliveryResolution: node.metadata?.generationDeliveryResolution || "descriptor-default",
        references: references.map(({ bindingId: _bindingId, ...reference }) => reference),
        legacyCanvasStateHash: hashCanvasAgentSnapshot({ ...snapshot, nodes: [], connections: [] }),
    });
}

async function projectReferences(snapshot: CanvasAgentSnapshot, nodeId: string): Promise<GenerationReferenceBinding[]> {
    const sourceIds = snapshot.connections.filter((item) => item.toNodeId === nodeId).map((item) => item.fromNodeId);
    const sources = sourceIds.map((id) => snapshot.nodes.find((item) => item.id === id)).filter((item): item is CanvasNodeData => Boolean(item));
    const media = sources.filter((node) => node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.metadata?.workflowKind === "character");
    return Promise.all(media.map(async (node, ordinal) => {
        const assetId = node.metadata?.assetId || `canvas-asset-${node.id}`;
        const assetVersionId = `asset-version-${node.metadata?.assetId || node.id}`;
        const mediaType = node.metadata?.mimeType || (node.type === CanvasNodeType.Video ? "video/mp4" : "image/png");
        const assetVersionContentHash = await hashProjection("production-asset-version", "semantic", {
            assetId, nodeId: node.id, storageKey: node.metadata?.storageKey || "local-canvas", mediaType, title: node.title,
        });
        const preparedRepresentationId = `prepared-${assetVersionContentHash.slice(0, 24)}`;
        const preparedRepresentationContentHash = await hashProjection("production-prepared-representation", "semantic", { assetVersionId, assetVersionContentHash, mediaType });
        return {
            bindingId: `binding-${node.id}`,
            role: node.type === CanvasNodeType.Video ? "generic_reference" as const : "subject_identity" as const,
            assetId,
            assetVersionId,
            assetVersionContentHash,
            mediaType,
            ordinal,
            preparedRepresentationId,
            preparedRepresentationContentHash,
            weightMicrounits: 1_000_000,
            hardLock: true,
        };
    }));
}

import {
    hashProjection,
    migrateProjectGenerationPolicyV1ToV2,
    assertProjectGenerationPolicyV2,
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
    type ProjectGenerationPolicyV2,
} from "@filmos/generation-contracts";

import { hashCanvasAgentSnapshot, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { FilmCoreHttpProductionGenerationAuthority } from "./film-core-production-authority";
import { BoundProductionGenerationProviderAdapter, type ProductionProviderAdapterBinding } from "./production-provider-adapters";
import {
    ProductionGenerationService,
    productionProviderKey,
    type ProductionAuthorizedCommand,
    type ProductionGenerationProviderAdapter,
    type ProductionPreviewBundle,
} from "./production-composition";

export type ProjectProductionBindingsV1 = {
    schemaVersion?: 1;
    brainPolicy?: ProjectBrainPolicy;
    connection: GenerationEngineConnection;
    catalog: GenerationCatalogSnapshot;
    projectPolicy: ProjectGenerationPolicy;
    projectLock?: ProjectGenerationLock;
    grant: GenerationBudgetGrant;
    ledger: BudgetLedger;
};

export type ProjectProductionBindingsV2 = {
    schemaVersion: 2;
    brainPolicy?: ProjectBrainPolicy;
    connections: GenerationEngineConnection[];
    catalogs: GenerationCatalogSnapshot[];
    projectPolicy: ProjectGenerationPolicyV2;
    grants: GenerationBudgetGrant[];
    ledgers: BudgetLedger[];
};

export type ProjectProductionBindings = ProjectProductionBindingsV1 | ProjectProductionBindingsV2;

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
        bindings = await normalizeProjectProductionBindings(await authority.ensureProjectAuthority(authorityProjectId, input.projectName, input.proposedBindings));
    } else {
        const stored = await authority.loadProjectAuthority<ProjectProductionBindings>(authorityProjectId);
        if (!stored) throw new Error("PROJECT_GENERATION_AUTHORITY_NOT_CONFIGURED");
        if (stored.projectName !== input.projectName) throw new Error("FILM_CORE_PROJECT_AUTHORITY_NAME_MISMATCH");
        bindings = await normalizeProjectProductionBindings(stored.bindings);
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
            const routeAuthority = authorityForRoute(bindings!, route);
            const draftVersion = node.metadata?.generationDraftVersion || 0;
            const promptHash = await promptDraftHash(prompt);
            const guardStateHash = await projectCanvasGuardHash(snapshot, command.nodeId);
            return service.preview({
                projectId: authorityProjectId,
                projectName: command.projectName,
                nodeId: command.nodeId,
                generationAttemptId: `attempt-${crypto.randomUUID()}`,
                taskKind,
                explicitTask: route,
                projectPolicy: bindings!.projectPolicy,
                projectLock: undefined,
                connection: routeAuthority.connection,
                catalog: routeAuthority.catalog,
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
                guards: projectExecutionGuards(snapshot, command.nodeId, draftVersion, promptHash, guardStateHash, references, bindings!, routeAuthority),
            });
        },
    };
}

export function createProjectAuthorizedCommand(
    fixture: ProjectProductionFixture,
    input: Omit<ProductionAuthorizedCommand, "grant" | "ledger" | "submitNotAfter"> & { confirmedAt: string; connectionId?: string },
): ProductionAuthorizedCommand {
    const budget = budgetAuthority(fixture.bindings, input.connectionId);
    return {
        ...input,
        grant: budget.grant,
        ledger: budget.ledger,
        submitNotAfter: new Date(Date.parse(input.confirmedAt) + 15 * 60 * 1000).toISOString(),
    };
}

function defaultProviderMap(bindings: ProjectProductionBindings): ReadonlyMap<string, ProductionGenerationProviderAdapter> {
    const authorities = isV2Bindings(bindings)
        ? bindings.connections.map((connection) => authorityForRoute(bindings, { engineId: connection.engineId, connectionId: connection.connectionId }))
        : [{ connection: bindings.connection, catalog: bindings.catalog }];
    return new Map(authorities.map(({ connection, catalog }) => {
        const adapter = new BoundProductionGenerationProviderAdapter({
            engineId: connection.engineId as ProductionProviderAdapterBinding["engineId"],
            connection,
            catalog,
            supportsHardLockedReferences: connection.engineId !== "manual_web",
        });
        return [productionProviderKey(connection.engineId, connection.connectionId), adapter] as const;
    }));
}

function assertProjectBindings(projectId: string, bindings: ProjectProductionBindings) {
    const grants = isV2Bindings(bindings) ? bindings.grants : [bindings.grant];
    const ledgers = isV2Bindings(bindings) ? bindings.ledgers : [bindings.ledger];
    const connections = isV2Bindings(bindings) ? bindings.connections : [bindings.connection];
    const catalogs = isV2Bindings(bindings) ? bindings.catalogs : [bindings.catalog];
    if (bindings.projectPolicy.projectId !== projectId || grants.some((item) => item.projectId !== projectId) || ledgers.some((item) => item.projectId !== projectId)) {
        throw new Error("PROJECT_GENERATION_AUTHORITY_SCOPE_MISMATCH");
    }
    if (!isV2Bindings(bindings) && bindings.projectLock && bindings.projectLock.projectId !== projectId) throw new Error("PROJECT_GENERATION_LOCK_SCOPE_MISMATCH");
    if (bindings.brainPolicy && bindings.brainPolicy.projectId !== projectId) throw new Error("PROJECT_BRAIN_POLICY_SCOPE_MISMATCH");
    if (isV2Bindings(bindings)) assertProjectGenerationPolicyV2(bindings.projectPolicy);
    for (const connection of connections) authorityForRoute(bindings, { engineId: connection.engineId, connectionId: connection.connectionId });
    for (const grant of grants) {
        const ledger = ledgers.find((item) => item.grantId === grant.grantId);
        if (!ledger || ledger.engineId !== grant.engineId || ledger.connectionId !== grant.connectionId) throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
    }
    if (catalogs.length !== connections.length) throw new Error("PROJECT_GENERATION_CATALOG_CONNECTION_MISMATCH");
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
    routeAuthority: ReturnType<typeof authorityForRoute>,
): GenerationExecutionGuardSet {
    return {
        primaryTarget: { guardKind: "canvas_state", canvasId: snapshot.projectId, nodeId, expectedRevision: draftVersion, expectedStateHash: guardStateHash },
        promptDraft: { guardKind: "versioned_entity", entityType: "prompt_draft", entityId: nodeId, expectedVersion: draftVersion, expectedContentHash: promptHash },
        projectPolicy: versionedGuard("project_generation_policy", bindings.projectPolicy.projectId, bindings.projectPolicy),
        engineConnection: versionedGuard("generation_engine_connection", routeAuthority.connection.connectionId, routeAuthority.connection),
        ...(!isV2Bindings(bindings) && bindings.projectLock ? { projectLock: versionedGuard("project_generation_lock", bindings.projectLock.projectId, bindings.projectLock) } : {}),
        budgetGrant: versionedGuard("generation_budget_grant", routeAuthority.grant.grantId, routeAuthority.grant),
        dependencies: [
            { guardKind: "versioned_entity", entityType: "generation_catalog_snapshot", entityId: routeAuthority.catalog.snapshotId, expectedVersion: 1, expectedContentHash: routeAuthority.catalog.contentHash },
            ...references.map((reference) => ({ guardKind: "versioned_entity" as const, entityType: "asset_version", entityId: reference.assetVersionId, expectedVersion: 1, expectedContentHash: reference.assetVersionContentHash })),
        ],
    };
}

export async function normalizeProjectProductionBindings(bindings: ProjectProductionBindings): Promise<ProjectProductionBindingsV2> {
    if (isV2Bindings(bindings)) {
        assertProjectBindings(bindings.projectPolicy.projectId, bindings);
        return structuredClone(bindings);
    }
    const policy = bindings.projectPolicy.schemaVersion === 2
        ? bindings.projectPolicy
        : await migrateProjectGenerationPolicyV1ToV2(bindings.projectPolicy, {
            budgetGrantIdsByConnection: { [bindings.connection.connectionId]: bindings.grant.grantId },
            projectLock: bindings.projectLock,
            connectionIdByEngine: { [bindings.connection.engineId]: bindings.connection.connectionId },
        });
    const migrated: ProjectProductionBindingsV2 = {
        schemaVersion: 2,
        ...(bindings.brainPolicy ? { brainPolicy: structuredClone(bindings.brainPolicy) } : {}),
        connections: [structuredClone(bindings.connection)],
        catalogs: [structuredClone(bindings.catalog)],
        projectPolicy: policy,
        grants: [structuredClone(bindings.grant)],
        ledgers: [structuredClone(bindings.ledger)],
    };
    assertProjectBindings(policy.projectId, migrated);
    return migrated;
}

export function isV2Bindings(bindings: ProjectProductionBindings): bindings is ProjectProductionBindingsV2 {
    return bindings.schemaVersion === 2 && Array.isArray((bindings as ProjectProductionBindingsV2).connections);
}

function authorityForRoute(bindings: ProjectProductionBindings, route: { engineId: string; connectionId: string }) {
    const connections = isV2Bindings(bindings) ? bindings.connections : [bindings.connection];
    const catalogs = isV2Bindings(bindings) ? bindings.catalogs : [bindings.catalog];
    const connection = connections.find((item) => item.engineId === route.engineId && item.connectionId === route.connectionId);
    const catalog = catalogs.find((item) => item.engineId === route.engineId && item.connectionId === route.connectionId);
    if (!connection || !catalog) throw new Error("PROJECT_GENERATION_ROUTE_AUTHORITY_MISMATCH");
    const budget = budgetAuthority(bindings, route.connectionId);
    return { connection, catalog, ...budget };
}

function budgetAuthority(bindings: ProjectProductionBindings, connectionId?: string) {
    if (!isV2Bindings(bindings)) return { grant: bindings.grant, ledger: bindings.ledger };
    const resolvedConnectionId = connectionId ?? (bindings.connections.length === 1 ? bindings.connections[0]!.connectionId : undefined);
    if (!resolvedConnectionId) throw new Error("PROJECT_GENERATION_BUDGET_CONNECTION_REQUIRED");
    const grantId = bindings.projectPolicy.budgetGrantIdsByConnection[resolvedConnectionId];
    const grant = bindings.grants.find((item) => item.grantId === grantId && item.connectionId === resolvedConnectionId);
    const ledger = bindings.ledgers.find((item) => item.grantId === grantId && item.connectionId === resolvedConnectionId);
    if (!grant || !ledger) throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
    return { grant, ledger };
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

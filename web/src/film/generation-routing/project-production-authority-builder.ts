import {
    canonicalUnsignedMicrounits,
    hashEnvelope,
    hashProjectGenerationLock,
    hashProjectGenerationPolicy,
    type GenerationCatalogSnapshot,
    type GenerationDefaultRoute,
    type GenerationEngineConnection,
    type GenerationTaskKind,
    type ProjectBrainPolicy,
    type UserSelectableBrainProfileId,
} from "@filmos/generation-contracts";

import type { ProjectProductionBindings } from "./project-production-runtime";

export async function buildProjectProductionBindings(input: {
    projectId: string;
    connection: GenerationEngineConnection;
    catalog: GenerationCatalogSnapshot;
    taskKind: GenerationTaskKind;
    route: GenerationDefaultRoute;
    defaultBrainProfileId?: UserSelectableBrainProfileId;
    allowedBrainProfileIds: UserSelectableBrainProfileId[];
    externalProjectId?: string;
    strictLock: boolean;
    allowProviderUpload: boolean;
    maxTasks: number;
    maxTotalCostMicrounits: string;
    costUnit: string;
    now?: string;
}): Promise<ProjectProductionBindings> {
    const now = input.now || new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + 365 * 24 * 60 * 60_000).toISOString();
    if (input.connection.engineId !== input.catalog.engineId || input.connection.connectionId !== input.catalog.connectionId) {
        throw new Error("PROJECT_GENERATION_CATALOG_CONNECTION_MISMATCH");
    }
    if (input.route.engineId !== input.connection.engineId || input.route.connectionId !== input.connection.connectionId) {
        throw new Error("PROJECT_GENERATION_ROUTE_CONNECTION_MISMATCH");
    }
    if (!Number.isSafeInteger(input.maxTasks) || input.maxTasks < 1) throw new Error("PROJECT_BUDGET_MAX_TASKS_INVALID");
    const maxTotalCostMicrounits = canonicalUnsignedMicrounits(input.maxTotalCostMicrounits);
    const brainPolicyBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        projectId: input.projectId,
        ...(input.defaultBrainProfileId ? { defaultProfileId: input.defaultBrainProfileId } : {}),
        allowedProfileIds: [...new Set(input.allowedBrainProfileIds)].sort() as UserSelectableBrainProfileId[],
        profileOverrides: {},
        createdAt: now,
        updatedAt: now,
    };
    if (input.defaultBrainProfileId && !brainPolicyBase.allowedProfileIds.includes(input.defaultBrainProfileId)) throw new Error("PROJECT_DEFAULT_BRAIN_NOT_ALLOWED");
    const brainPolicy = { ...brainPolicyBase, contentHash: await hashEnvelope("project-brain-policy", brainPolicyBase) } satisfies ProjectBrainPolicy;
    const projectPolicyBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        projectId: input.projectId,
        allowedEngineIds: [input.connection.engineId],
        defaultRoutes: { [input.taskKind]: input.route },
        externalProjectBindings: input.externalProjectId
            ? { [input.connection.engineId]: { connectionId: input.connection.connectionId, externalProjectId: input.externalProjectId, bindingVersion: 1 } }
            : {},
        uploadPolicy: { allowProviderUpload: input.allowProviderUpload, requirePerSubmitPreview: true },
        createdAt: now,
        updatedAt: now,
    };
    const projectPolicy = { ...projectPolicyBase, contentHash: await hashProjectGenerationPolicy(projectPolicyBase) };
    const selected = selectedDescriptor(input.catalog, input.route);
    const projectLockBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        projectId: input.projectId,
        taskLocks: input.strictLock ? {
            [input.taskKind]: {
                engineId: input.connection.engineId,
                connectionId: input.connection.connectionId,
                ...(input.route.modelId ? {
                    modelId: input.route.modelId,
                    providerModelId: selected.kind === "model" ? selected.value.providerModelId : undefined,
                    modelVersion: selected.kind === "model" ? selected.value.modelVersion : undefined,
                    modelDescriptorHash: selected.value.descriptorHash,
                } : {}),
                ...(input.route.workflowId ? {
                    workflowId: input.route.workflowId,
                    workflowVersion: selected.kind === "workflow" ? selected.value.version : undefined,
                    workflowDescriptorHash: selected.value.descriptorHash,
                } : {}),
                ...(input.route.skillId ? {
                    skillId: input.route.skillId,
                    skillVersion: selected.kind === "skill" ? selected.value.version : undefined,
                    skillDescriptorHash: selected.value.descriptorHash,
                } : {}),
                catalogRevision: input.catalog.catalogRevision,
                enforcement: "strict" as const,
            },
        } : {},
        createdAt: now,
        updatedAt: now,
    };
    const projectLock = { ...projectLockBase, contentHash: await hashProjectGenerationLock(projectLockBase) };
    const grantBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        grantId: `generation-grant-${input.projectId}-${input.connection.connectionId}`,
        projectId: input.projectId,
        engineId: input.connection.engineId,
        connectionId: input.connection.connectionId,
        ...(input.connection.accountBindingRef ? { accountBindingRef: input.connection.accountBindingRef } : {}),
        connectionInstanceRef: input.connection.connectionInstanceRef,
        status: "active" as const,
        bindingRevision: 1,
        allowedModelIds: input.route.modelId ? [input.route.modelId] : [],
        allowedTaskKinds: [input.taskKind],
        maxTasks: input.maxTasks,
        maxTotalCost: { unit: input.costUnit, amountMicrounits: maxTotalCostMicrounits },
        expiresAt,
        grantedByActorRef: "local-project-owner",
        brokerGrantId: `project-budget-broker-grant-${input.projectId}`,
        confirmationId: `project-budget-confirmation-${input.projectId}`,
        createdAt: now,
        updatedAt: now,
    };
    const grant = { ...grantBase, contentHash: await hashEnvelope("generation-budget-grant", grantBase) };
    const ledgerBase = {
        schemaVersion: 1 as const,
        entityVersion: 1,
        ledgerId: `generation-ledger-${input.projectId}-${input.connection.connectionId}`,
        grantId: grant.grantId,
        projectId: input.projectId,
        engineId: input.connection.engineId,
        connectionId: input.connection.connectionId,
        ...(input.connection.accountBindingRef ? { accountBindingRef: input.connection.accountBindingRef } : {}),
        connectionInstanceRef: input.connection.connectionInstanceRef,
        costUnit: input.costUnit,
        reservedTasks: 0,
        reservedCostMicrounits: "0",
        consumedTasks: 0,
        consumedCostMicrounits: "0",
        openReservationIds: [],
        lastEventSequence: 0,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
    };
    const ledger = { ...ledgerBase, contentHash: await hashEnvelope("budget-ledger", ledgerBase) };
    return { brainPolicy, connection: input.connection, catalog: input.catalog, projectPolicy, projectLock, grant, ledger };
}

function selectedDescriptor(catalog: GenerationCatalogSnapshot, route: GenerationDefaultRoute) {
    if (route.modelId) {
        const matches = catalog.models.filter((item) => item.modelId === route.modelId);
        if (matches.length !== 1) throw new Error(matches.length ? "GENERATION_DESCRIPTOR_DUPLICATE" : "GENERATION_DESCRIPTOR_NOT_FOUND");
        return { kind: "model" as const, value: matches[0] };
    }
    if (route.workflowId) {
        const matches = catalog.workflows.filter((item) => item.workflowId === route.workflowId);
        if (matches.length !== 1) throw new Error(matches.length ? "GENERATION_DESCRIPTOR_DUPLICATE" : "GENERATION_DESCRIPTOR_NOT_FOUND");
        return { kind: "workflow" as const, value: matches[0] };
    }
    if (route.skillId) {
        const matches = catalog.skills.filter((item) => item.skillId === route.skillId);
        if (matches.length !== 1) throw new Error(matches.length ? "GENERATION_DESCRIPTOR_DUPLICATE" : "GENERATION_DESCRIPTOR_NOT_FOUND");
        return { kind: "skill" as const, value: matches[0] };
    }
    throw new Error("GENERATION_ROUTE_DESCRIPTOR_REQUIRED");
}

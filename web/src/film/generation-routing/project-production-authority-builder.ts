import {
    canonicalUnsignedMicrounits,
    hashEnvelope,
    hashProjectGenerationLock,
    hashProjectGenerationPolicy,
    type BudgetLedger,
    type GenerationCatalogSnapshot,
    type GenerationBudgetGrant,
    type GenerationDefaultRoute,
    type GenerationEngineConnection,
    type GenerationTaskKind,
    type GenerationDefaultPolicy,
    type ProjectBrainPolicy,
    type ProjectGenerationPolicyV2,
    type ProjectGenerationTaskLock,
    type UserSelectableBrainProfileId,
} from "@filmos/generation-contracts";

import type { ProjectProductionBindings, ProjectProductionBindingsV2 } from "./project-production-runtime";

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

export type ProjectGenerationConnectionPolicyInput = {
    connection: GenerationEngineConnection;
    catalog: GenerationCatalogSnapshot;
    externalProjectId?: string;
    maxTasks: number;
    maxTotalCostMicrounits: string;
    costUnit: string;
    existingGrant?: GenerationBudgetGrant;
    existingLedger?: BudgetLedger;
};

/**
 * Rehydrates the V2 builder inputs without collapsing connections, budgets or
 * external bindings. Project settings uses this when one task route is edited
 * so sequential UI edits cannot silently replace the rest of Policy V2.
 */
export function projectGenerationConnectionPolicyInputs(
    bindings: ProjectProductionBindingsV2,
): ProjectGenerationConnectionPolicyInput[] {
    return bindings.connections.map((connection) => {
        const catalog = bindings.catalogs.find((item) => item.engineId === connection.engineId && item.connectionId === connection.connectionId);
        const grantId = bindings.projectPolicy.budgetGrantIdsByConnection[connection.connectionId];
        const grant = bindings.grants.find((item) => item.grantId === grantId && item.connectionId === connection.connectionId);
        const ledger = bindings.ledgers.find((item) => item.grantId === grantId && item.connectionId === connection.connectionId);
        if (!catalog) throw new Error("PROJECT_GENERATION_CATALOG_CONNECTION_MISMATCH");
        if (!grant || !ledger) throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
        const externalProjectId = bindings.projectPolicy.externalProjectBindings[connection.engineId]
            ?.find((item) => item.connectionId === connection.connectionId)?.externalProjectId;
        return {
            connection: structuredClone(connection),
            catalog: structuredClone(catalog),
            ...(externalProjectId ? { externalProjectId } : {}),
            maxTasks: grant.maxTasks,
            maxTotalCostMicrounits: grant.maxTotalCost?.amountMicrounits ?? "0",
            costUnit: grant.maxTotalCost?.unit ?? ledger.costUnit ?? "unknown",
            existingGrant: structuredClone(grant),
            existingLedger: structuredClone(ledger),
        };
    });
}

export async function buildProjectProductionBindingsV2(input: {
    projectId: string;
    connections: ProjectGenerationConnectionPolicyInput[];
    defaultRoutes: GenerationDefaultPolicy;
    defaultBrainProfileId?: UserSelectableBrainProfileId;
    allowedBrainProfileIds: UserSelectableBrainProfileId[];
    strictLockTaskKinds: GenerationTaskKind[];
    allowProviderUpload: boolean;
    now?: string;
}): Promise<ProjectProductionBindingsV2> {
    const now = input.now || new Date().toISOString();
    if (!input.connections.length) throw new Error("PROJECT_POLICY_ALLOWED_CONNECTION_REQUIRED");
    const connectionKeys = new Set<string>();
    for (const item of input.connections) {
        const key = `${item.connection.engineId}\0${item.connection.connectionId}`;
        if (connectionKeys.has(key)) throw new Error("PROJECT_POLICY_ALLOWED_CONNECTION_INVALID");
        connectionKeys.add(key);
        if (item.connection.engineId !== item.catalog.engineId || item.connection.connectionId !== item.catalog.connectionId) {
            throw new Error("PROJECT_GENERATION_CATALOG_CONNECTION_MISMATCH");
        }
        if (!Number.isSafeInteger(item.maxTasks) || item.maxTasks < 1) throw new Error("PROJECT_BUDGET_MAX_TASKS_INVALID");
        const maxCost = canonicalUnsignedMicrounits(item.maxTotalCostMicrounits);
        if (item.existingGrant || item.existingLedger) {
            if (!item.existingGrant || !item.existingLedger) throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
            if (item.existingGrant.projectId !== input.projectId || item.existingLedger.projectId !== input.projectId
                || item.existingGrant.engineId !== item.connection.engineId || item.existingLedger.engineId !== item.connection.engineId
                || item.existingGrant.connectionId !== item.connection.connectionId || item.existingLedger.connectionId !== item.connection.connectionId
                || item.existingLedger.grantId !== item.existingGrant.grantId) {
                throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
            }
            if (item.existingGrant.connectionInstanceRef !== item.connection.connectionInstanceRef
                || item.existingLedger.connectionInstanceRef !== item.connection.connectionInstanceRef
                || item.existingGrant.accountBindingRef !== item.connection.accountBindingRef
                || item.existingLedger.accountBindingRef !== item.connection.accountBindingRef) {
                throw new Error("PROJECT_GENERATION_BUDGET_BINDING_ROTATED");
            }
            if (item.existingGrant.status !== "active" || item.existingLedger.status !== "active") throw new Error("PROJECT_GENERATION_BUDGET_CLOSED");
            if (item.maxTasks < item.existingLedger.consumedTasks + item.existingLedger.reservedTasks
                || BigInt(maxCost) < BigInt(item.existingLedger.consumedCostMicrounits) + BigInt(item.existingLedger.reservedCostMicrounits)) {
                throw new Error("PROJECT_GENERATION_BUDGET_BELOW_USAGE");
            }
        }
    }
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
    const grants = [];
    const ledgers = [];
    const budgetGrantIdsByConnection: Record<string, string> = {};
    const expiresAt = new Date(Date.parse(now) + 365 * 24 * 60 * 60_000).toISOString();
    for (const item of input.connections) {
        const routes = Object.entries(input.defaultRoutes).filter(([, route]) => route?.connectionId === item.connection.connectionId);
        const grantId = item.existingGrant?.grantId ?? `generation-grant-${input.projectId}-${item.connection.connectionId}`;
        budgetGrantIdsByConnection[item.connection.connectionId] = grantId;
        const grantBase = {
            schemaVersion: 1 as const,
            entityVersion: (item.existingGrant?.entityVersion ?? 0) + 1,
            grantId,
            projectId: input.projectId,
            engineId: item.connection.engineId,
            connectionId: item.connection.connectionId,
            ...(item.connection.accountBindingRef ? { accountBindingRef: item.connection.accountBindingRef } : {}),
            connectionInstanceRef: item.connection.connectionInstanceRef,
            status: "active" as const,
            bindingRevision: (item.existingGrant?.bindingRevision ?? 0) + 1,
            allowedModelIds: [...new Set(routes.flatMap(([, route]) => route?.modelId ? [route.modelId] : []))],
            allowedTaskKinds: routes.map(([taskKind]) => taskKind as GenerationTaskKind),
            maxTasks: item.maxTasks,
            maxTotalCost: { unit: item.costUnit, amountMicrounits: canonicalUnsignedMicrounits(item.maxTotalCostMicrounits) },
            expiresAt: item.existingGrant?.expiresAt ?? expiresAt,
            grantedByActorRef: item.existingGrant?.grantedByActorRef ?? "local-project-owner",
            brokerGrantId: item.existingGrant?.brokerGrantId ?? `project-budget-broker-grant-${input.projectId}-${item.connection.connectionId}`,
            confirmationId: item.existingGrant?.confirmationId ?? `project-budget-confirmation-${input.projectId}-${item.connection.connectionId}`,
            createdAt: item.existingGrant?.createdAt ?? now,
            updatedAt: now,
        };
        const grant = { ...grantBase, contentHash: await hashEnvelope("generation-budget-grant", grantBase) };
        grants.push(grant);
        const ledgerBase = {
            schemaVersion: 1 as const,
            entityVersion: (item.existingLedger?.entityVersion ?? 0) + 1,
            ledgerId: item.existingLedger?.ledgerId ?? `generation-ledger-${input.projectId}-${item.connection.connectionId}`,
            grantId,
            projectId: input.projectId,
            engineId: item.connection.engineId,
            connectionId: item.connection.connectionId,
            ...(item.connection.accountBindingRef ? { accountBindingRef: item.connection.accountBindingRef } : {}),
            connectionInstanceRef: item.connection.connectionInstanceRef,
            costUnit: item.costUnit,
            reservedTasks: item.existingLedger?.reservedTasks ?? 0,
            reservedCostMicrounits: item.existingLedger?.reservedCostMicrounits ?? "0",
            consumedTasks: item.existingLedger?.consumedTasks ?? 0,
            consumedCostMicrounits: item.existingLedger?.consumedCostMicrounits ?? "0",
            openReservationIds: [...(item.existingLedger?.openReservationIds ?? [])],
            lastEventSequence: item.existingLedger?.lastEventSequence ?? 0,
            status: "active" as const,
            createdAt: item.existingLedger?.createdAt ?? now,
            updatedAt: now,
        };
        ledgers.push({ ...ledgerBase, contentHash: await hashEnvelope("budget-ledger", ledgerBase) });
    }
    const strictTaskKinds = new Set(input.strictLockTaskKinds);
    const modelLocksByTask: Partial<Record<GenerationTaskKind, ProjectGenerationTaskLock>> = {};
    for (const [taskKind, route] of Object.entries(input.defaultRoutes)) {
        if (!route) continue;
        const authority = input.connections.find((item) => item.connection.engineId === route.engineId && item.connection.connectionId === route.connectionId);
        if (!authority) throw new Error("PROJECT_POLICY_DEFAULT_ROUTE_NOT_ALLOWED");
        if (!strictTaskKinds.has(taskKind as GenerationTaskKind)) continue;
        const selected = selectedDescriptor(authority.catalog, route);
        modelLocksByTask[taskKind as GenerationTaskKind] = {
            engineId: route.engineId,
            connectionId: route.connectionId,
            ...(route.modelId ? { modelId: route.modelId, providerModelId: selected.kind === "model" ? selected.value.providerModelId : undefined, modelVersion: selected.kind === "model" ? selected.value.modelVersion : undefined, modelDescriptorHash: selected.value.descriptorHash } : {}),
            ...(route.workflowId ? { workflowId: route.workflowId, workflowVersion: selected.kind === "workflow" ? selected.value.version : undefined, workflowDescriptorHash: selected.value.descriptorHash } : {}),
            ...(route.skillId ? { skillId: route.skillId, skillVersion: selected.kind === "skill" ? selected.value.version : undefined, skillDescriptorHash: selected.value.descriptorHash } : {}),
            catalogRevision: authority.catalog.catalogRevision,
            enforcement: "strict",
        };
    }
    const externalProjectBindings: ProjectGenerationPolicyV2["externalProjectBindings"] = {};
    for (const item of input.connections) {
        if (!item.externalProjectId?.trim()) continue;
        (externalProjectBindings[item.connection.engineId] ??= []).push({
            connectionId: item.connection.connectionId,
            externalProjectId: item.externalProjectId.trim(),
            bindingVersion: 1,
        });
    }
    const policyBase: Omit<ProjectGenerationPolicyV2, "contentHash"> = {
        schemaVersion: 2,
        entityVersion: 1,
        projectId: input.projectId,
        allowedConnections: input.connections.map((item) => ({ engineId: item.connection.engineId, connectionId: item.connection.connectionId })),
        defaultRoutes: structuredClone(input.defaultRoutes),
        externalProjectBindings,
        budgetGrantIdsByConnection,
        modelLocksByTask,
        uploadPolicy: { allowProviderUpload: input.allowProviderUpload, requirePerSubmitPreview: true },
        createdAt: now,
        updatedAt: now,
    };
    const projectPolicy = { ...policyBase, contentHash: await hashProjectGenerationPolicy(policyBase) };
    return {
        schemaVersion: 2,
        brainPolicy,
        connections: input.connections.map((item) => structuredClone(item.connection)),
        catalogs: input.connections.map((item) => structuredClone(item.catalog)),
        projectPolicy,
        grants,
        ledgers,
    };
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

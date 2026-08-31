import { hashEnvelope, hashProjection } from "./canonical.js";
import { assertRouteDescriptorExact } from "./route.js";
import type {
    GenerationRouteSnapshot,
    GenerationTaskKind,
    ProjectGenerationLock,
    ProjectGenerationPolicy,
    ProjectGenerationPolicyV1,
    ProjectGenerationPolicyV2,
    ProjectGenerationTaskLock,
    SelectedGenerationDescriptorRef,
} from "./types.js";

export async function hashProjectGenerationPolicy(
    policy: Omit<ProjectGenerationPolicyV1, "contentHash"> | Omit<ProjectGenerationPolicyV2, "contentHash">,
): Promise<string> {
    return hashEnvelope("project-generation-policy", policy as unknown as Record<string, unknown>);
}

export async function hashProjectGenerationLock(
    lock: Omit<ProjectGenerationLock, "contentHash">,
): Promise<string> {
    return hashEnvelope("project-generation-lock", lock as unknown as Record<string, unknown>);
}

export function assertProjectGenerationPolicy(
    policy: ProjectGenerationPolicy,
    route: Pick<GenerationRouteSnapshot, "engineId" | "connectionId" | "taskKind" | "modelId" | "workflowId" | "skillId">,
): void {
    if (policy.schemaVersion === 1) {
        if (!policy.allowedEngineIds.includes(route.engineId)) throw new Error("PROJECT_ENGINE_NOT_ALLOWED");
    } else {
        assertProjectGenerationPolicyV2(policy);
        if (!policy.allowedConnections.some((item) => item.engineId === route.engineId && item.connectionId === route.connectionId)) {
            throw new Error("PROJECT_CONNECTION_NOT_ALLOWED");
        }
    }
    const declaredDefault = policy.defaultRoutes[route.taskKind];
    if (declaredDefault?.engineId === route.engineId && declaredDefault.connectionId !== route.connectionId) {
        throw new Error("PROJECT_DEFAULT_CONNECTION_MISMATCH");
    }
}

export function assertProjectGenerationPolicyV2(policy: ProjectGenerationPolicyV2): void {
    if (policy.schemaVersion !== 2) throw new Error("PROJECT_POLICY_V2_REQUIRED");
    if (!policy.allowedConnections.length) throw new Error("PROJECT_POLICY_ALLOWED_CONNECTION_REQUIRED");
    const allowed = new Set<string>();
    for (const item of policy.allowedConnections) {
        const key = connectionKey(item.engineId, item.connectionId);
        if (!item.engineId || !item.connectionId || allowed.has(key)) throw new Error("PROJECT_POLICY_ALLOWED_CONNECTION_INVALID");
        allowed.add(key);
        const grantId = policy.budgetGrantIdsByConnection[item.connectionId];
        if (!grantId?.trim()) throw new Error("PROJECT_POLICY_CONNECTION_BUDGET_REQUIRED");
    }
    for (const [taskKind, route] of Object.entries(policy.defaultRoutes)) {
        if (!route || !allowed.has(connectionKey(route.engineId, route.connectionId))) throw new Error("PROJECT_POLICY_DEFAULT_ROUTE_NOT_ALLOWED");
        const lock = policy.modelLocksByTask[taskKind as GenerationTaskKind];
        if (lock && (lock.engineId !== route.engineId || (lock.connectionId !== undefined && lock.connectionId !== route.connectionId))) {
            throw new Error("PROJECT_POLICY_TASK_LOCK_ROUTE_MISMATCH");
        }
    }
    for (const [engineId, bindings] of Object.entries(policy.externalProjectBindings)) {
        const connectionIds = new Set<string>();
        for (const binding of bindings) {
            if (!binding.externalProjectId.trim() || !Number.isSafeInteger(binding.bindingVersion) || binding.bindingVersion < 1) {
                throw new Error("PROJECT_POLICY_EXTERNAL_PROJECT_BINDING_INVALID");
            }
            if (!allowed.has(connectionKey(engineId, binding.connectionId)) || connectionIds.has(binding.connectionId)) {
                throw new Error("PROJECT_POLICY_EXTERNAL_PROJECT_CONNECTION_INVALID");
            }
            connectionIds.add(binding.connectionId);
        }
    }
    for (const connectionId of Object.keys(policy.budgetGrantIdsByConnection)) {
        if (!policy.allowedConnections.some((item) => item.connectionId === connectionId)) throw new Error("PROJECT_POLICY_BUDGET_CONNECTION_NOT_ALLOWED");
    }
}

export function projectGenerationTaskLockFromPolicy(
    policy: ProjectGenerationPolicy,
    taskKind: GenerationTaskKind,
    legacyLock?: ProjectGenerationLock,
): ProjectGenerationTaskLock | undefined {
    return policy.schemaVersion === 2 ? policy.modelLocksByTask[taskKind] : legacyLock?.taskLocks[taskKind];
}

function connectionKey(engineId: string, connectionId: string): string {
    return `${engineId}\0${connectionId}`;
}

function assertExactField(label: string, locked: string | undefined, actual: string | undefined): void {
    if (locked !== undefined && locked !== actual) throw new Error(label);
}

export function assertProjectGenerationLock(
    projectLock: ProjectGenerationLock,
    taskKind: GenerationTaskKind,
    route: GenerationRouteSnapshot,
    descriptors: readonly SelectedGenerationDescriptorRef[],
    descriptorDetails: {
        providerModelId?: string;
        modelVersion?: string;
        workflowVersion?: string;
        skillVersion?: string;
        catalogRevision?: string;
    },
): { enforcement: "none" | "warn" | "strict"; warnings: string[] } {
    const lock = projectLock.taskLocks[taskKind];
    if (!lock) return { enforcement: "none", warnings: [] };
    return assertProjectGenerationTaskLock(lock, route, descriptors, descriptorDetails);
}

export function assertProjectGenerationTaskLock(
    lock: ProjectGenerationTaskLock,
    route: GenerationRouteSnapshot,
    descriptors: readonly SelectedGenerationDescriptorRef[],
    descriptorDetails: {
        providerModelId?: string;
        modelVersion?: string;
        workflowVersion?: string;
        skillVersion?: string;
        catalogRevision?: string;
    },
): { enforcement: "warn" | "strict"; warnings: string[] } {
    const violations: string[] = [];
    const check = (label: string, locked: string | undefined, actual: string | undefined) => {
        try { assertExactField(label, locked, actual); } catch { violations.push(label); }
    };
    check("LOCKED_ENGINE_UNAVAILABLE", lock.engineId, route.engineId);
    check("LOCKED_CONNECTION_UNAVAILABLE", lock.connectionId, route.connectionId);
    check("LOCKED_MODEL_UNAVAILABLE", lock.modelId, route.modelId);
    check("LOCKED_MODEL_VERSION_CHANGED", lock.providerModelId, descriptorDetails.providerModelId);
    check("LOCKED_MODEL_VERSION_CHANGED", lock.modelVersion, descriptorDetails.modelVersion);
    check("LOCKED_WORKFLOW_UNAVAILABLE", lock.workflowId, route.workflowId);
    check("LOCKED_WORKFLOW_UNAVAILABLE", lock.workflowVersion, descriptorDetails.workflowVersion);
    check("LOCKED_SKILL_UNAVAILABLE", lock.skillId, route.skillId);
    check("LOCKED_SKILL_UNAVAILABLE", lock.skillVersion, descriptorDetails.skillVersion);
    check("LOCKED_CATALOG_REVISION_CHANGED", lock.catalogRevision, descriptorDetails.catalogRevision);
    try { assertRouteDescriptorExact(route, descriptors); } catch { violations.push("LOCKED_DESCRIPTOR_SELECTION_CHANGED"); }
    const descriptorByKind = new Map(descriptors.map((item) => [item.descriptorKind, item.descriptorHash]));
    check("LOCKED_MODEL_VERSION_CHANGED", lock.modelDescriptorHash, descriptorByKind.get("model"));
    check("LOCKED_WORKFLOW_UNAVAILABLE", lock.workflowDescriptorHash, descriptorByKind.get("workflow"));
    check("LOCKED_SKILL_UNAVAILABLE", lock.skillDescriptorHash, descriptorByKind.get("skill"));
    const unique = [...new Set(violations)];
    if (unique.length && lock.enforcement === "strict") throw new Error(unique[0]);
    return { enforcement: lock.enforcement, warnings: unique };
}

export async function projectGenerationTaskLockSemanticHash(
    taskKind: GenerationTaskKind,
    lock: ProjectGenerationTaskLock,
): Promise<string> {
    return hashProjection("project-generation-lock", "semantic", { taskKind, lock });
}

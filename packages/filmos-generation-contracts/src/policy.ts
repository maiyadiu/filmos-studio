import { hashEnvelope, hashProjection } from "./canonical.js";
import { assertRouteDescriptorExact } from "./route.js";
import type {
    GenerationRouteSnapshot,
    GenerationTaskKind,
    ProjectGenerationLock,
    ProjectGenerationPolicy,
    ProjectGenerationTaskLock,
    SelectedGenerationDescriptorRef,
} from "./types.js";

export async function hashProjectGenerationPolicy(
    policy: Omit<ProjectGenerationPolicy, "contentHash">,
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
    if (!policy.allowedEngineIds.includes(route.engineId)) throw new Error("PROJECT_ENGINE_NOT_ALLOWED");
    const declaredDefault = policy.defaultRoutes[route.taskKind];
    if (declaredDefault?.engineId === route.engineId && declaredDefault.connectionId !== route.connectionId) {
        throw new Error("PROJECT_DEFAULT_CONNECTION_MISMATCH");
    }
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

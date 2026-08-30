import { canonicalSort, hashEnvelope, hashProjection } from "./canonical.js";
import type { GenerationReferenceBinding, GenerationRouteSnapshot } from "./types.js";

export async function hashGenerationReferences(references: readonly GenerationReferenceBinding[]): Promise<string> {
    const normalized = canonicalSort(references, (item) => `${String(item.ordinal).padStart(8, "0")}:${item.role}:${item.assetVersionId}`);
    if (new Set(normalized.map((item) => item.bindingId)).size !== normalized.length) throw new Error("GENERATION_REFERENCE_BINDING_DUPLICATE");
    if (normalized.some((item, index) => !Number.isInteger(item.ordinal) || item.ordinal !== index)) throw new Error("GENERATION_REFERENCE_ORDINAL_INVALID");
    for (const item of normalized) {
        if ((item.preparedRepresentationId === undefined) !== (item.preparedRepresentationContentHash === undefined)) throw new Error("GENERATION_REFERENCE_PREPARED_REPRESENTATION_INCOMPLETE");
        if (item.weightMicrounits !== undefined && (!Number.isInteger(item.weightMicrounits) || item.weightMicrounits < 0 || item.weightMicrounits > 1_000_000)) throw new Error("GENERATION_REFERENCE_WEIGHT_INVALID");
        if (typeof item.hardLock !== "boolean") throw new Error("GENERATION_REFERENCE_HARD_LOCK_REQUIRED");
    }
    return hashProjection("generation-references", "semantic", normalized.map(({ bindingId: _bindingId, ...item }) => item));
}

export async function createGenerationRouteSnapshot(input: Omit<GenerationRouteSnapshot, "contentHash" | "routeContentHash">): Promise<GenerationRouteSnapshot> {
    if (input.descriptorReceiptContentHash === input.descriptorSemanticHash) throw new Error("DESCRIPTOR_HASH_PURPOSE_COLLISION");
    const routeProjection = {
        engineId: input.engineId, connectionId: input.connectionId,
        ...(input.accountBindingRef ? { accountBindingRef: input.accountBindingRef } : {}), connectionInstanceRef: input.connectionInstanceRef,
        capability: input.capability, taskKind: input.taskKind,
        descriptorSemanticHash: input.descriptorSemanticHash,
        ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.skillId ? { skillId: input.skillId } : {}),
        normalizedParameters: input.normalizedParameters, parameterHash: input.parameterHash,
        references: canonicalSort(input.references, (item) => `${String(item.ordinal).padStart(8, "0")}:${item.role}:${item.assetVersionId}`), referenceHash: input.referenceHash,
        promptDraftVersion: input.promptDraftVersion, promptDraftContentHash: input.promptDraftContentHash,
        compiledPromptSemanticHash: input.compiledPromptSemanticHash, compiledPromptTextHash: input.compiledPromptTextHash,
        compilerVersion: input.compilerVersion, templateVersion: input.templateVersion,
        userConfigRevision: input.userConfigRevision, projectPolicyVersion: input.projectPolicyVersion, projectPolicyHash: input.projectPolicyHash,
        ...(input.projectLockVersion !== undefined ? { projectLockVersion: input.projectLockVersion, projectLockHash: input.projectLockHash } : {}),
        nodeDraftVersion: input.nodeDraftVersion, selectionSource: input.selectionSource,
    };
    const routeContentHash = await hashProjection("generation-route", "semantic", routeProjection);
    const envelope = { ...input, routeContentHash };
    const contentHash = await hashEnvelope("generation-route", envelope as unknown as Record<string, unknown>);
    return { ...envelope, contentHash };
}

export async function verifyGenerationRouteSnapshot(route: GenerationRouteSnapshot): Promise<void> {
    const { contentHash: _contentHash, routeContentHash: _routeContentHash, ...input } = route;
    const rebuilt = await createGenerationRouteSnapshot(input);
    if (rebuilt.routeContentHash !== route.routeContentHash || rebuilt.contentHash !== route.contentHash) throw new Error("GENERATION_ROUTE_SNAPSHOT_TAMPERED");
}

export function assertRouteDescriptorExact(route: GenerationRouteSnapshot, refs: readonly { descriptorKind: string; descriptorId: string }[]): void {
    const selected = [route.modelId && `model:${route.modelId}`, route.workflowId && `workflow:${route.workflowId}`, route.skillId && `skill:${route.skillId}`].filter(Boolean);
    const expected = refs.map((ref) => `${ref.descriptorKind}:${ref.descriptorId}`);
    if (selected.length !== expected.length || selected.some((item) => !expected.includes(item as string))) throw new Error("GENERATION_ROUTE_DESCRIPTOR_MISMATCH");
}

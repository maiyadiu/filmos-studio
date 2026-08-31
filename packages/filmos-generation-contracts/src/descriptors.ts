import { canonicalize, hashEnvelope, hashProjection, sha256Hex } from "./canonical.js";
import type {
    CatalogEvidence, GenerationCatalogSnapshot, GenerationModelDescriptor, GenerationSkillDescriptor,
    GenerationWorkflowDescriptor, NonEmptyReadonlyArray, ResolvedGenerationDescriptorReceipt,
    SelectedGenerationDescriptor, SelectedGenerationDescriptorRef,
} from "./types.js";

type Selection = { descriptorKind: "model" | "workflow" | "skill"; descriptorId: string };

function descriptorId(item: SelectedGenerationDescriptor): string {
    if (item.descriptorKind === "model") return item.descriptor.modelId;
    if (item.descriptorKind === "workflow") return item.descriptor.workflowId;
    return item.descriptor.skillId;
}

function descriptorHash(item: SelectedGenerationDescriptor): string {
    return item.descriptor.descriptorHash;
}

export function exactSelectedDescriptors(catalog: GenerationCatalogSnapshot, selections: readonly Selection[]): NonEmptyReadonlyArray<SelectedGenerationDescriptor> {
    if (!selections.length) throw new Error("DESCRIPTOR_SELECTION_EMPTY");
    const keys = new Set<string>();
    const selected = selections.map((selection): SelectedGenerationDescriptor => {
        const key = `${selection.descriptorKind}:${selection.descriptorId}`;
        if (keys.has(key)) throw new Error("DESCRIPTOR_SELECTION_DUPLICATE");
        keys.add(key);
        if (selection.descriptorKind === "model") {
            const matches = catalog.models.filter((item) => item.modelId === selection.descriptorId);
            if (matches.length !== 1) throw new Error(matches.length ? "DESCRIPTOR_ID_AMBIGUOUS" : "DESCRIPTOR_NOT_FOUND");
            return { descriptorKind: "model", descriptorId: selection.descriptorId, descriptorHash: matches[0].descriptorHash, descriptor: matches[0] };
        }
        if (selection.descriptorKind === "workflow") {
            const matches = catalog.workflows.filter((item) => item.workflowId === selection.descriptorId);
            if (matches.length !== 1) throw new Error(matches.length ? "DESCRIPTOR_ID_AMBIGUOUS" : "DESCRIPTOR_NOT_FOUND");
            return { descriptorKind: "workflow", descriptorId: selection.descriptorId, descriptorHash: matches[0].descriptorHash, descriptor: matches[0] };
        }
        const matches = catalog.skills.filter((item) => item.skillId === selection.descriptorId);
        if (matches.length !== 1) throw new Error(matches.length ? "DESCRIPTOR_ID_AMBIGUOUS" : "DESCRIPTOR_NOT_FOUND");
        return { descriptorKind: "skill", descriptorId: selection.descriptorId, descriptorHash: matches[0].descriptorHash, descriptor: matches[0] };
    });
    return selected as unknown as NonEmptyReadonlyArray<SelectedGenerationDescriptor>;
}

export function selectedDescriptorRefs(selected: NonEmptyReadonlyArray<SelectedGenerationDescriptor>): NonEmptyReadonlyArray<SelectedGenerationDescriptorRef> {
    return selected.map(({ descriptorKind, descriptorId, descriptorHash }) => ({ descriptorKind, descriptorId, descriptorHash })) as unknown as NonEmptyReadonlyArray<SelectedGenerationDescriptorRef>;
}

export function descriptorBlobProjection(selected: NonEmptyReadonlyArray<SelectedGenerationDescriptor>) {
    return { format: "filmos-selected-generation-descriptors-v1", selectedDescriptors: selected };
}

export async function descriptorBlobContentHash(selected: NonEmptyReadonlyArray<SelectedGenerationDescriptor>): Promise<string> {
    return sha256Hex(canonicalize(descriptorBlobProjection(selected)));
}

export function validateExactDescriptorBlob(input: { selectedDescriptors: readonly SelectedGenerationDescriptor[]; selectedDescriptorRefs: readonly SelectedGenerationDescriptorRef[] }): void {
    if (!input.selectedDescriptors.length || input.selectedDescriptors.length !== input.selectedDescriptorRefs.length) throw new Error("DESCRIPTOR_BLOB_SELECTION_MISMATCH");
    const blobs = new Map(input.selectedDescriptors.map((item) => [`${item.descriptorKind}:${descriptorId(item)}`, item]));
    if (blobs.size !== input.selectedDescriptors.length) throw new Error("DESCRIPTOR_BLOB_DUPLICATE");
    for (const ref of input.selectedDescriptorRefs) {
        const item = blobs.get(`${ref.descriptorKind}:${ref.descriptorId}`);
        if (!item || descriptorHash(item) !== ref.descriptorHash || item.descriptorHash !== ref.descriptorHash) throw new Error("DESCRIPTOR_BLOB_REF_MISMATCH");
    }
}

function stableCatalogEvidence(evidence: CatalogEvidence): Record<string, unknown> {
    if (evidence.source === "runtime_discovery") return { source: evidence.source, runtimeVersion: evidence.runtimeVersion };
    if (evidence.source === "remote_catalog") return { source: evidence.source, ...(evidence.etag ? { etag: evidence.etag } : {}) };
    if (evidence.source === "verified_static_version_bound") return {
        source: evidence.source, adapterVersion: evidence.adapterVersion,
        supportedCliVersionRange: evidence.supportedCliVersionRange, manifestHash: evidence.manifestHash,
        cliVersion: evidence.cliVersion, cliCommit: evidence.cliCommit, cliBuildTime: evidence.cliBuildTime,
        executableSha256: evidence.executableSha256, sourceLocatorId: evidence.sourceLocatorId, catalogHash: evidence.catalogHash,
        expiresAt: evidence.expiresAt,
    };
    return { source: evidence.source, enteredByActorRef: evidence.enteredByActorRef };
}

export async function createInlineDescriptorReceipt(input: {
    descriptorReceiptId: string;
    selected: NonEmptyReadonlyArray<SelectedGenerationDescriptor>;
    catalog: GenerationCatalogSnapshot;
    createdAt: string;
}): Promise<ResolvedGenerationDescriptorReceipt> {
    for (const item of input.selected) {
        if (item.descriptor.engineId !== input.catalog.engineId || item.descriptor.connectionId !== input.catalog.connectionId) throw new Error("DESCRIPTOR_CONNECTION_SCOPE_MISMATCH");
        if (descriptorId(item) !== item.descriptorId || descriptorHash(item) !== item.descriptorHash) throw new Error("DESCRIPTOR_EXACT_SELECTION_MISMATCH");
    }
    const semanticProjection = {
        engineId: input.catalog.engineId, connectionId: input.catalog.connectionId,
        ...(input.catalog.accountBindingRef ? { accountBindingRef: input.catalog.accountBindingRef } : {}),
        connectionInstanceRef: input.catalog.connectionInstanceRef,
        selectedDescriptors: input.selected,
        catalogSnapshotContentHash: input.catalog.contentHash,
        catalogRevision: input.catalog.catalogRevision,
        catalogValidUntil: input.catalog.catalogValidUntil,
        catalogEvidence: stableCatalogEvidence(input.catalog.evidence),
    };
    const descriptorSemanticHash = await hashProjection("resolved-generation-descriptor", "semantic", semanticProjection);
    const envelope: Omit<ResolvedGenerationDescriptorReceipt, "contentHash"> = {
        schemaVersion: 1, descriptorReceiptId: input.descriptorReceiptId,
        engineId: input.catalog.engineId, connectionId: input.catalog.connectionId,
        ...(input.catalog.accountBindingRef ? { accountBindingRef: input.catalog.accountBindingRef } : {}),
        connectionInstanceRef: input.catalog.connectionInstanceRef,
        payload: { storage: "inline", selectedDescriptors: input.selected },
        catalogSnapshotId: input.catalog.snapshotId, catalogSnapshotContentHash: input.catalog.contentHash,
        catalogRevision: input.catalog.catalogRevision, catalogValidUntil: input.catalog.catalogValidUntil,
        catalogEvidence: input.catalog.evidence, descriptorSemanticHash, createdAt: input.createdAt,
    };
    return { ...envelope, contentHash: await hashEnvelope("resolved-generation-descriptor", envelope as unknown as Record<string, unknown>) };
}

export function descriptorRefsFromReceipt(receipt: ResolvedGenerationDescriptorReceipt): NonEmptyReadonlyArray<SelectedGenerationDescriptorRef> {
    return receipt.payload.storage === "inline" ? selectedDescriptorRefs(receipt.payload.selectedDescriptors) : receipt.payload.selectedDescriptorRefs;
}

export type AnyDescriptor = GenerationModelDescriptor | GenerationWorkflowDescriptor | GenerationSkillDescriptor;

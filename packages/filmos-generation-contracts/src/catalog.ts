import { hashEnvelope, hashProjection } from "./canonical.js";
import { descriptorRefsFromReceipt } from "./descriptors.js";
import type { CatalogValidationReceipt, GenerationCatalogSnapshot, ResolvedGenerationDescriptorReceipt } from "./types.js";

export async function createCatalogValidationReceipt(input: {
    id: string;
    descriptorReceipt: ResolvedGenerationDescriptorReceipt;
    route: { routeSnapshotId: string; contentHash: string; routeContentHash: string };
    catalog: GenerationCatalogSnapshot;
    validationMode: CatalogValidationReceipt["validationMode"];
    validatedAt: string;
    submitNotAfter: string;
}): Promise<CatalogValidationReceipt> {
    const { descriptorReceipt, catalog } = input;
    if (descriptorReceipt.catalogSnapshotId !== catalog.snapshotId || descriptorReceipt.catalogSnapshotContentHash !== catalog.contentHash) throw new Error("CATALOG_VALIDATION_SNAPSHOT_MISMATCH");
    if (descriptorReceipt.engineId !== catalog.engineId || descriptorReceipt.connectionId !== catalog.connectionId) throw new Error("CATALOG_VALIDATION_CONNECTION_MISMATCH");
    if (descriptorReceipt.accountBindingRef !== catalog.accountBindingRef || descriptorReceipt.connectionInstanceRef !== catalog.connectionInstanceRef) throw new Error("CATALOG_VALIDATION_BINDING_MISMATCH");
    if (catalog.evidence.source === "manual_unverified") throw new Error("CATALOG_VALIDATION_MANUAL_UNVERIFIED");
    const validUntil = Date.parse(catalog.catalogValidUntil);
    const validatedAt = Date.parse(input.validatedAt);
    const submitNotAfter = Date.parse(input.submitNotAfter);
    if (![validUntil, validatedAt, submitNotAfter].every(Number.isFinite) || validatedAt > submitNotAfter || submitNotAfter > validUntil) throw new Error("CATALOG_VALIDATION_WINDOW_INVALID");
    const refs = descriptorRefsFromReceipt(descriptorReceipt);
    const semanticProjection = {
        descriptorReceiptId: descriptorReceipt.descriptorReceiptId, descriptorReceiptContentHash: descriptorReceipt.contentHash,
        descriptorSemanticHash: descriptorReceipt.descriptorSemanticHash,
        routeSnapshotId: input.route.routeSnapshotId, routeSnapshotContentHash: input.route.contentHash, routeContentHash: input.route.routeContentHash,
        engineId: catalog.engineId, connectionId: catalog.connectionId,
        ...(catalog.accountBindingRef ? { accountBindingRef: catalog.accountBindingRef } : {}), connectionInstanceRef: catalog.connectionInstanceRef,
        catalogSnapshotContentHash: catalog.contentHash, catalogRevision: catalog.catalogRevision, catalogValidUntil: catalog.catalogValidUntil,
        selectedDescriptorRefs: refs, validationMode: input.validationMode, submitNotAfter: input.submitNotAfter,
    };
    const catalogValidationSemanticHash = await hashProjection("catalog-validation", "semantic", semanticProjection);
    const envelope: Omit<CatalogValidationReceipt, "contentHash"> = {
        schemaVersion: 1, catalogValidationReceiptId: input.id,
        descriptorReceiptId: descriptorReceipt.descriptorReceiptId, descriptorReceiptContentHash: descriptorReceipt.contentHash,
        descriptorSemanticHash: descriptorReceipt.descriptorSemanticHash,
        routeSnapshotId: input.route.routeSnapshotId, routeSnapshotContentHash: input.route.contentHash, routeContentHash: input.route.routeContentHash,
        engineId: catalog.engineId, connectionId: catalog.connectionId,
        ...(catalog.accountBindingRef ? { accountBindingRef: catalog.accountBindingRef } : {}), connectionInstanceRef: catalog.connectionInstanceRef,
        catalogSnapshotId: catalog.snapshotId, catalogSnapshotContentHash: catalog.contentHash, catalogRevision: catalog.catalogRevision,
        catalogValidUntil: catalog.catalogValidUntil, selectedDescriptorRefs: refs, validationMode: input.validationMode,
        validatedAt: input.validatedAt, submitNotAfter: input.submitNotAfter, result: "valid", catalogValidationSemanticHash,
        createdAt: input.validatedAt,
    };
    return { ...envelope, contentHash: await hashEnvelope("catalog-validation", envelope as unknown as Record<string, unknown>) };
}

export function assertCatalogValidationSubmitReady(receipt: CatalogValidationReceipt, input: {
    now: string; routeContentHash: string; descriptorSemanticHash: string; accountBindingRef?: string; connectionInstanceRef: string;
}): void {
    if (Date.parse(input.now) > Date.parse(receipt.submitNotAfter)) throw new Error("CATALOG_VALIDATION_STALE");
    if (receipt.routeContentHash !== input.routeContentHash || receipt.descriptorSemanticHash !== input.descriptorSemanticHash) throw new Error("CATALOG_VALIDATION_STALE");
    if (receipt.accountBindingRef !== input.accountBindingRef || receipt.connectionInstanceRef !== input.connectionInstanceRef) throw new Error("CATALOG_VALIDATION_STALE");
}

import { canonicalize } from "json-canonicalize";

export const FILM_ASSET_LOCK_FEATURE = "film.asset_lock" as const;
export const DEFAULT_FILM_ASSET_LOCK_ENABLED = false;

export const FILM_ASSET_SEMANTICS = ["character", "scene", "prop", "costume", "voice", "style", "architecture", "lighting", "motion", "other"] as const;
export type FilmAssetSemantic = (typeof FILM_ASSET_SEMANTICS)[number];

export const BINDING_PURPOSES = [
    "character_identity",
    "costume_reference",
    "scene_appearance",
    "spatial_reference",
    "composition_reference",
    "lighting_reference",
    "prop_reference",
    "first_frame",
    "middle_frame",
    "end_frame",
    "motion_reference",
    "continuity_reference",
    "final_output",
] as const;
export type BindingPurpose = (typeof BINDING_PURPOSES)[number];

export type AssetBindingTarget = {
    kind: "project" | "host_unit" | "film_scene" | "director_unit" | "host_shot";
    id: string;
};

export type HostAssetVersionReference = {
    hostAssetId: string;
    hostAssetVersionId: string;
    hostRepresentationId?: string;
    hostResourceId?: string;
    contentHash: string;
};

export type MediaLocator = { kind: "host_resource"; hostResourceId: string } | { kind: "managed_copy"; workspaceObjectId: string } | { kind: "linked_external"; bookmarkId: string } | { kind: "regenerable_cache"; cacheKey: string };

export type MediaIntegrity = { state: "verified"; observedContentHash: string; verifiedAt: string } | { state: "unchecked" } | { state: "missing" } | { state: "changed"; observedContentHash: string };

export type AuthorizationEvidence = { state: "verified"; evidenceId: string; scope: string } | { state: "not_required"; reason: string } | { state: "unverified" };

export type AssetProvenance = {
    kind: "host_import" | "manual_import" | "provider_result" | "legacy_import";
    sourceReceiptId: string;
};

export type HostAssetVersionProjection = {
    schemaVersion: 1;
    semantic: FilmAssetSemantic;
    host: HostAssetVersionReference;
    media: MediaLocator;
    integrity: MediaIntegrity;
    authorization: AuthorizationEvidence;
    provenance: AssetProvenance;
};

export type CandidateAssetBinding = {
    schemaVersion: 1;
    id: string;
    hostProjectId: string;
    target: AssetBindingTarget;
    purpose: BindingPurpose;
    asset: HostAssetVersionProjection;
    lifecycle: "candidate";
    version: number;
    createdAt: string;
    createdBy: string;
};

export type ApprovedAssetBinding = {
    schemaVersion: 1;
    id: string;
    sourceCandidateId: string;
    hostProjectId: string;
    target: AssetBindingTarget;
    purpose: BindingPurpose;
    asset: HostAssetVersionProjection;
    lifecycle: "approved";
    version: number;
    approval: {
        reviewId: string;
        qcReportId: string;
        actorId: string;
        approvedAt: string;
    };
};

export type AssetAuditEvent = Readonly<{
    schemaVersion: 1;
    id: string;
    entityType: "film_asset_binding";
    entityId: string;
    action: "asset_binding.candidate_created" | "asset_binding.approved";
    actorId: string;
    occurredAt: string;
    entityVersion: number;
    sourceCandidateId?: string;
    hostAssetId: string;
    hostAssetVersionId: string;
    purpose: BindingPurpose;
    contentHash: string;
}>;

export type AssetLayerGate = { enabled?: boolean };

export type VersionedLockReference = {
    entityId: string;
    versionId: string;
    contentHash: string;
};

export type ApprovedBindingLockReference = {
    lifecycle: "approved";
    bindingId: string;
    bindingVersion: number;
    purpose: BindingPurpose;
    hostAssetVersionId: string;
    contentHash: string;
    reviewId: string;
};

export type VisualLockComponents = {
    styleProfileSnapshot?: VersionedLockReference;
    architectureVersion?: VersionedLockReference;
    sceneTwinVersion?: VersionedLockReference;
    characterIdentityVersions?: readonly VersionedLockReference[];
    costumeVersions?: readonly VersionedLockReference[];
    propStateVersions?: readonly VersionedLockReference[];
    lightingProfileVersion?: VersionedLockReference;
    cameraVersion?: VersionedLockReference;
    blockingVersion?: VersionedLockReference;
    compositionVersion?: VersionedLockReference;
    continuityStateVersion?: VersionedLockReference;
    referenceRoleMap?: Readonly<Record<string, ApprovedBindingLockReference>>;
};

export const VISUAL_LOCK_COMPONENT_KEYS = [
    "styleProfileSnapshot",
    "architectureVersion",
    "sceneTwinVersion",
    "characterIdentityVersions",
    "costumeVersions",
    "propStateVersions",
    "lightingProfileVersion",
    "cameraVersion",
    "blockingVersion",
    "compositionVersion",
    "continuityStateVersion",
    "referenceRoleMap",
] as const;
export type VisualLockComponentKey = (typeof VISUAL_LOCK_COMPONENT_KEYS)[number];

export type VisualLockSet = {
    schemaVersion: 1;
    id: string;
    scopeId: string;
    version: number;
    createdAt: string;
    components: VisualLockComponents;
    componentHashes: Partial<Record<VisualLockComponentKey, string>>;
    dependencyHashes: Readonly<Record<string, string>>;
    visualLockHash: string;
};

export type VisualLockConsumer = {
    entityId: string;
    dependencies: readonly string[];
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ABSOLUTE_PATH_OR_PUBLIC_URL = /^(?:\/|~[\\/]|file:|https?:|[a-zA-Z]:[\\/])/;

export class FilmAssetLayerDisabledError extends Error {
    constructor() {
        super(`${FILM_ASSET_LOCK_FEATURE} is disabled`);
        this.name = "FilmAssetLayerDisabledError";
    }
}

export class FilmAssetValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FilmAssetValidationError";
    }
}

export function projectHostAssetVersion(input: HostAssetVersionProjection): HostAssetVersionProjection {
    assertSemantic(input.semantic);
    const host = normalizeHostReference(input.host);
    const media = normalizeMediaLocator(input.media);
    const integrity = normalizeIntegrity(input.integrity);
    const authorization = normalizeAuthorization(input.authorization);
    const provenance = normalizeProvenance(input.provenance);
    if (media.kind === "host_resource" && media.hostResourceId !== host.hostResourceId) {
        throw new FilmAssetValidationError("Host resource locator requires the same Host resource id on the asset version reference");
    }
    return Object.freeze({ schemaVersion: 1, semantic: input.semantic, host, media, integrity, authorization, provenance });
}

export async function createCandidateAssetBinding(
    input: Omit<CandidateAssetBinding, "schemaVersion" | "lifecycle" | "version" | "asset"> & { asset: HostAssetVersionProjection; auditEventId: string },
    gate: AssetLayerGate = {},
): Promise<{ binding: CandidateAssetBinding; audit: AssetAuditEvent }> {
    assertEnabled(gate);
    assertUuidV4(input.id, "candidate binding id");
    assertUuidV4(input.auditEventId, "audit event id");
    assertText(input.hostProjectId, "host project id");
    assertTarget(input.target);
    assertPurpose(input.purpose);
    assertTimestamp(input.createdAt, "createdAt");
    assertText(input.createdBy, "createdBy");
    const asset = projectHostAssetVersion(input.asset);
    const binding: CandidateAssetBinding = Object.freeze({
        schemaVersion: 1,
        id: input.id,
        hostProjectId: input.hostProjectId,
        target: Object.freeze({ ...input.target }),
        purpose: input.purpose,
        asset,
        lifecycle: "candidate",
        version: 1,
        createdAt: input.createdAt,
        createdBy: input.createdBy,
    });
    return {
        binding,
        audit: assetAuditEvent({
            id: input.auditEventId,
            entityId: binding.id,
            action: "asset_binding.candidate_created",
            actorId: binding.createdBy,
            occurredAt: binding.createdAt,
            entityVersion: binding.version,
            binding,
        }),
    };
}

export async function approveCandidateAssetBinding(
    candidate: CandidateAssetBinding,
    input: {
        approvedBindingId: string;
        auditEventId: string;
        expectedVersion: number;
        reviewId: string;
        qcReportId: string;
        qcOutcome: "pass" | "fail";
        actorId: string;
        approvedAt: string;
    },
    gate: AssetLayerGate = {},
): Promise<{ binding: ApprovedAssetBinding; audit: AssetAuditEvent }> {
    assertEnabled(gate);
    if (candidate.lifecycle !== "candidate") throw new FilmAssetValidationError("Only a Candidate binding can be approved");
    assertUuidV4(candidate.id, "candidate binding id");
    assertText(candidate.hostProjectId, "host project id");
    assertTarget(candidate.target);
    assertPurpose(candidate.purpose);
    assertTimestamp(candidate.createdAt, "candidate createdAt");
    assertText(candidate.createdBy, "candidate actor id");
    if (!Number.isInteger(candidate.version) || candidate.version < 1) throw new FilmAssetValidationError("Candidate version must be a positive integer");
    if (input.expectedVersion !== candidate.version) throw new FilmAssetValidationError("expected_version conflict");
    if (input.qcOutcome !== "pass") throw new FilmAssetValidationError("A passing QC result is required before approval");
    assertUuidV4(input.approvedBindingId, "approved binding id");
    assertUuidV4(input.auditEventId, "audit event id");
    assertText(input.reviewId, "review id");
    assertText(input.qcReportId, "QC report id");
    assertText(input.actorId, "approval actor id");
    assertTimestamp(input.approvedAt, "approvedAt");
    if (input.approvedBindingId === candidate.id) throw new FilmAssetValidationError("Approved binding must not overwrite its Candidate source");
    const asset = projectHostAssetVersion(candidate.asset);
    assertApprovalEvidence(asset);

    const binding: ApprovedAssetBinding = Object.freeze({
        schemaVersion: 1,
        id: input.approvedBindingId,
        sourceCandidateId: candidate.id,
        hostProjectId: candidate.hostProjectId,
        target: candidate.target,
        purpose: candidate.purpose,
        asset,
        lifecycle: "approved",
        version: 1,
        approval: Object.freeze({
            reviewId: input.reviewId,
            qcReportId: input.qcReportId,
            actorId: input.actorId,
            approvedAt: input.approvedAt,
        }),
    });
    return {
        binding,
        audit: assetAuditEvent({
            id: input.auditEventId,
            entityId: binding.id,
            action: "asset_binding.approved",
            actorId: input.actorId,
            occurredAt: input.approvedAt,
            entityVersion: binding.version,
            sourceCandidateId: candidate.id,
            binding,
        }),
    };
}

export function approvedBindingLockReference(binding: ApprovedAssetBinding): ApprovedBindingLockReference {
    if (binding.lifecycle !== "approved") throw new FilmAssetValidationError("VisualLock requires an Approved binding");
    assertUuidV4(binding.id, "approved binding id");
    if (!Number.isInteger(binding.version) || binding.version < 1) throw new FilmAssetValidationError("approved binding version must be positive");
    assertPurpose(binding.purpose);
    assertText(binding.approval.reviewId, "review id");
    assertHash(binding.asset.host.contentHash);
    return Object.freeze({
        lifecycle: "approved",
        bindingId: binding.id,
        bindingVersion: binding.version,
        purpose: binding.purpose,
        hostAssetVersionId: binding.asset.host.hostAssetVersionId,
        contentHash: binding.asset.host.contentHash,
        reviewId: binding.approval.reviewId,
    });
}

export async function createVisualLockSet(input: { id: string; scopeId: string; version: number; createdAt: string; components: VisualLockComponents }, gate: AssetLayerGate = {}): Promise<VisualLockSet> {
    assertEnabled(gate);
    assertUuidV4(input.id, "VisualLock id");
    assertText(input.scopeId, "VisualLock scope id");
    if (!Number.isInteger(input.version) || input.version < 1) throw new FilmAssetValidationError("VisualLock version must be a positive integer");
    assertTimestamp(input.createdAt, "VisualLock createdAt");
    const components = normalizeVisualLockComponents(input.components);
    const presentKeys = VISUAL_LOCK_COMPONENT_KEYS.filter((key) => components[key] !== undefined);
    if (!presentKeys.length) throw new FilmAssetValidationError("VisualLock requires at least one component");

    const componentHashes: Partial<Record<VisualLockComponentKey, string>> = {};
    const dependencyHashes: Record<string, string> = {};
    for (const key of presentKeys) {
        const value = components[key];
        componentHashes[key] = await sha256Canonical(value);
        await addDependencyHashes(dependencyHashes, key, value);
    }
    const visualLockHash = await sha256Canonical({ schemaVersion: 1, componentHashes });
    return Object.freeze({
        schemaVersion: 1,
        id: input.id,
        scopeId: input.scopeId,
        version: input.version,
        createdAt: input.createdAt,
        components,
        componentHashes: Object.freeze(componentHashes),
        dependencyHashes: Object.freeze(dependencyHashes),
        visualLockHash,
    });
}

export function diffVisualLockSets(previous: VisualLockSet, next: VisualLockSet, consumers: readonly VisualLockConsumer[]) {
    if (previous.scopeId !== next.scopeId) throw new FilmAssetValidationError("VisualLock scopes do not match");
    const dependencyKeys = new Set([...Object.keys(previous.dependencyHashes), ...Object.keys(next.dependencyHashes)]);
    const changedDependencies = [...dependencyKeys].filter((key) => previous.dependencyHashes[key] !== next.dependencyHashes[key]).sort();
    const changed = new Set(changedDependencies);
    const staleEntityIds = consumers
        .filter((consumer) => consumer.dependencies.some((dependency) => changed.has(dependency)))
        .map((consumer) => consumer.entityId)
        .filter((entityId, index, values) => values.indexOf(entityId) === index)
        .sort();
    return Object.freeze({
        changedDependencies: Object.freeze(changedDependencies),
        staleEntityIds: Object.freeze(staleEntityIds),
    });
}

function assertEnabled(gate: AssetLayerGate) {
    if (gate.enabled !== true) throw new FilmAssetLayerDisabledError();
}

function assertSemantic(value: string): asserts value is FilmAssetSemantic {
    if (!(FILM_ASSET_SEMANTICS as readonly string[]).includes(value)) throw new FilmAssetValidationError("Unsupported Film asset semantic");
}

function assertPurpose(value: string): asserts value is BindingPurpose {
    if (!(BINDING_PURPOSES as readonly string[]).includes(value)) throw new FilmAssetValidationError("Unsupported binding purpose");
}

function assertText(value: string, label: string) {
    if (!value || !value.trim()) throw new FilmAssetValidationError(`${label} is required`);
}

function assertOpaqueReference(value: string, label: string) {
    assertText(value, label);
    if (ABSOLUTE_PATH_OR_PUBLIC_URL.test(value.trim())) throw new FilmAssetValidationError(`${label} must be an opaque reference, not a path or public URL`);
}

function assertUuidV4(value: string, label: string) {
    if (!UUID_V4.test(value)) throw new FilmAssetValidationError(`${label} must be a lower-case UUIDv4`);
}

function assertHash(value: string, label = "content hash") {
    if (!SHA_256.test(value)) throw new FilmAssetValidationError(`${label} must be a lower-case SHA-256 hex digest`);
}

function assertTimestamp(value: string, label: string) {
    if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new FilmAssetValidationError(`${label} must be an ISO timestamp`);
}

function assertTarget(target: AssetBindingTarget) {
    if (!["project", "host_unit", "film_scene", "director_unit", "host_shot"].includes(target.kind)) throw new FilmAssetValidationError("Unsupported binding target");
    assertText(target.id, "binding target id");
}

function normalizeHostReference(input: HostAssetVersionReference): HostAssetVersionReference {
    assertText(input.hostAssetId, "host asset id");
    assertText(input.hostAssetVersionId, "host asset version id");
    assertHash(input.contentHash);
    if (input.hostRepresentationId !== undefined) assertText(input.hostRepresentationId, "host representation id");
    if (input.hostResourceId !== undefined) assertText(input.hostResourceId, "host resource id");
    return Object.freeze({
        hostAssetId: input.hostAssetId,
        hostAssetVersionId: input.hostAssetVersionId,
        ...(input.hostRepresentationId ? { hostRepresentationId: input.hostRepresentationId } : {}),
        ...(input.hostResourceId ? { hostResourceId: input.hostResourceId } : {}),
        contentHash: input.contentHash,
    });
}

function normalizeMediaLocator(input: MediaLocator): MediaLocator {
    switch (input.kind) {
        case "host_resource":
            assertText(input.hostResourceId, "host resource id");
            return Object.freeze({ kind: input.kind, hostResourceId: input.hostResourceId });
        case "managed_copy":
            assertOpaqueReference(input.workspaceObjectId, "workspace object id");
            return Object.freeze({ kind: input.kind, workspaceObjectId: input.workspaceObjectId });
        case "linked_external":
            assertOpaqueReference(input.bookmarkId, "external bookmark id");
            return Object.freeze({ kind: input.kind, bookmarkId: input.bookmarkId });
        case "regenerable_cache":
            assertOpaqueReference(input.cacheKey, "cache key");
            return Object.freeze({ kind: input.kind, cacheKey: input.cacheKey });
        default:
            throw new FilmAssetValidationError("Unsupported media locator");
    }
}

function normalizeIntegrity(input: MediaIntegrity): MediaIntegrity {
    if (input.state === "verified") {
        assertHash(input.observedContentHash, "observed content hash");
        assertTimestamp(input.verifiedAt, "integrity verifiedAt");
        return Object.freeze({ state: input.state, observedContentHash: input.observedContentHash, verifiedAt: input.verifiedAt });
    }
    if (input.state === "changed") {
        assertHash(input.observedContentHash, "observed content hash");
        return Object.freeze({ state: input.state, observedContentHash: input.observedContentHash });
    }
    if (input.state === "unchecked" || input.state === "missing") return Object.freeze({ state: input.state });
    throw new FilmAssetValidationError("Unsupported media integrity state");
}

function normalizeAuthorization(input: AuthorizationEvidence): AuthorizationEvidence {
    if (input.state === "verified") {
        assertOpaqueReference(input.evidenceId, "authorization evidence id");
        assertText(input.scope, "authorization scope");
        return Object.freeze({ state: input.state, evidenceId: input.evidenceId, scope: input.scope });
    }
    if (input.state === "not_required") {
        assertText(input.reason, "authorization exception reason");
        return Object.freeze({ state: input.state, reason: input.reason });
    }
    if (input.state === "unverified") return Object.freeze({ state: input.state });
    throw new FilmAssetValidationError("Unsupported authorization state");
}

function normalizeProvenance(input: AssetProvenance): AssetProvenance {
    if (!["host_import", "manual_import", "provider_result", "legacy_import"].includes(input.kind)) throw new FilmAssetValidationError("Unsupported asset provenance");
    assertOpaqueReference(input.sourceReceiptId, "source receipt id");
    return Object.freeze({ kind: input.kind, sourceReceiptId: input.sourceReceiptId });
}

function assertApprovalEvidence(asset: HostAssetVersionProjection) {
    if (asset.authorization.state === "unverified") throw new FilmAssetValidationError("Authorization evidence is required before approval");
    if (asset.integrity.state !== "verified") throw new FilmAssetValidationError("Verified media integrity is required before approval");
    if (asset.integrity.observedContentHash !== asset.host.contentHash) throw new FilmAssetValidationError("Observed media hash does not match the bound Host version");
    if (asset.media.kind === "regenerable_cache") throw new FilmAssetValidationError("A regenerable cache cannot be the sole Approved media source");
}

function assetAuditEvent(input: {
    id: string;
    entityId: string;
    action: AssetAuditEvent["action"];
    actorId: string;
    occurredAt: string;
    entityVersion: number;
    sourceCandidateId?: string;
    binding: CandidateAssetBinding | ApprovedAssetBinding;
}): AssetAuditEvent {
    return Object.freeze({
        schemaVersion: 1,
        id: input.id,
        entityType: "film_asset_binding",
        entityId: input.entityId,
        action: input.action,
        actorId: input.actorId,
        occurredAt: input.occurredAt,
        entityVersion: input.entityVersion,
        ...(input.sourceCandidateId ? { sourceCandidateId: input.sourceCandidateId } : {}),
        hostAssetId: input.binding.asset.host.hostAssetId,
        hostAssetVersionId: input.binding.asset.host.hostAssetVersionId,
        purpose: input.binding.purpose,
        contentHash: input.binding.asset.host.contentHash,
    });
}

function normalizeVisualLockComponents(input: VisualLockComponents): VisualLockComponents {
    const result: VisualLockComponents = {};
    for (const key of VISUAL_LOCK_COMPONENT_KEYS) {
        const value = input[key];
        if (value === undefined) continue;
        if (key === "referenceRoleMap") {
            const normalized: Record<string, ApprovedBindingLockReference> = {};
            const roles = Object.keys(value as Record<string, ApprovedBindingLockReference>).sort();
            if (!roles.length) throw new FilmAssetValidationError("referenceRoleMap cannot be empty");
            for (const role of roles) {
                assertText(role, "reference role");
                const reference = (value as Record<string, ApprovedBindingLockReference>)[role];
                if (reference.lifecycle !== "approved") throw new FilmAssetValidationError("VisualLock reference roles require Approved bindings");
                assertUuidV4(reference.bindingId, "approved binding id");
                if (!Number.isInteger(reference.bindingVersion) || reference.bindingVersion < 1) throw new FilmAssetValidationError("approved binding version must be positive");
                assertPurpose(reference.purpose);
                assertText(reference.hostAssetVersionId, "host asset version id");
                assertHash(reference.contentHash);
                assertText(reference.reviewId, "review id");
                normalized[role] = Object.freeze({ ...reference });
            }
            result.referenceRoleMap = Object.freeze(normalized);
            continue;
        }
        if (Array.isArray(value)) {
            const normalized = value.map(normalizeLockReference).sort(compareLockReferences);
            if (!normalized.length) throw new FilmAssetValidationError(`${key} cannot be empty`);
            const ids = new Set<string>();
            for (const reference of normalized) {
                if (ids.has(reference.entityId)) throw new FilmAssetValidationError(`${key} contains duplicate entity ids`);
                ids.add(reference.entityId);
            }
            (result as Record<string, unknown>)[key] = Object.freeze(normalized);
            continue;
        }
        (result as Record<string, unknown>)[key] = normalizeLockReference(value as VersionedLockReference);
    }
    return Object.freeze(result);
}

function normalizeLockReference(reference: VersionedLockReference): VersionedLockReference {
    assertText(reference.entityId, "lock entity id");
    assertText(reference.versionId, "lock version id");
    assertHash(reference.contentHash);
    return Object.freeze({ entityId: reference.entityId, versionId: reference.versionId, contentHash: reference.contentHash });
}

function compareLockReferences(left: VersionedLockReference, right: VersionedLockReference) {
    return `${left.entityId}\0${left.versionId}\0${left.contentHash}`.localeCompare(`${right.entityId}\0${right.versionId}\0${right.contentHash}`);
}

async function addDependencyHashes(target: Record<string, string>, key: VisualLockComponentKey, value: unknown) {
    target[key] = await sha256Canonical(value);
    if (key === "referenceRoleMap") {
        for (const [role, reference] of Object.entries(value as Record<string, ApprovedBindingLockReference>)) target[`${key}:${role}`] = await sha256Canonical(reference);
        return;
    }
    if (Array.isArray(value)) {
        for (const reference of value as VersionedLockReference[]) target[`${key}:${reference.entityId}`] = await sha256Canonical(reference);
        return;
    }
}

async function sha256Canonical(value: unknown) {
    const serialized = canonicalize(value);
    if (serialized === undefined) throw new FilmAssetValidationError("VisualLock component cannot be canonicalized");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DEFAULT_FILM_ASSET_LOCK_ENABLED,
    FilmAssetLayerDisabledError,
    FilmAssetValidationError,
    approveCandidateAssetBinding,
    approvedBindingLockReference,
    createCandidateAssetBinding,
    createVisualLockSet,
    diffVisualLockSets,
    projectHostAssetVersion,
    type HostAssetVersionProjection,
    type VersionedLockReference,
} from "./asset-layer";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const CREATED_AT = "2026-08-28T08:00:00.000Z";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_AUDIT_ID = "22222222-2222-4222-8222-222222222222";
const APPROVED_ID = "33333333-3333-4333-8333-333333333333";
const APPROVED_AUDIT_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QC_REPORT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCOPE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHARACTER_1_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHARACTER_1_VERSION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CHARACTER_2_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CHARACTER_2_VERSION = "11111111-2222-4111-8111-111111111111";
const PROP_ID = "22222222-3333-4222-8222-222222222222";
const PROP_V1_ID = "33333333-4444-4333-8333-333333333333";
const PROP_V2_ID = "44444444-5555-4444-8444-444444444444";
const CONSUMER_PROP_ID = "55555555-6666-4555-8555-555555555555";
const CONSUMER_ALL_PROPS_ID = "66666666-7777-4666-8666-666666666666";
const CONSUMER_CHARACTER_ID = "77777777-8888-4777-8777-777777777777";
const CONSUMER_UNRELATED_ID = "88888888-9999-4888-8888-888888888888";

function projection(overrides: Partial<HostAssetVersionProjection> = {}): HostAssetVersionProjection {
    return {
        schemaVersion: 1,
        semantic: "character",
        host: {
            hostAssetId: "host-asset-1",
            hostAssetVersionId: "host-version-1",
            hostResourceId: "host-resource-1",
            contentHash: HASH_A,
        },
        media: { kind: "host_resource", hostResourceId: "host-resource-1" },
        integrity: { state: "verified", observedContentHash: HASH_A, verifiedAt: CREATED_AT },
        authorization: { state: "verified", evidenceId: "rights-receipt-1", scope: "project-production" },
        provenance: { kind: "host_import", sourceReceiptId: "source-receipt-1" },
        ...overrides,
    };
}

function candidateInput(asset = projection()) {
    return {
        id: CANDIDATE_ID,
        auditEventId: CANDIDATE_AUDIT_ID,
        hostProjectId: "host-project-1",
        target: { kind: "host_shot" as const, id: "host-shot-1" },
        purpose: "character_identity" as const,
        asset,
        createdAt: CREATED_AT,
        createdBy: "user-1",
    };
}

test("asset layer stays disabled until film.asset_lock is explicitly enabled", async () => {
    assert.equal(DEFAULT_FILM_ASSET_LOCK_ENABLED, false);
    await assert.rejects(createCandidateAssetBinding(candidateInput()), FilmAssetLayerDisabledError);
});

test("Host projection keeps only stable references, source evidence, and hashes", () => {
    const value = projection({
        media: { kind: "linked_external", bookmarkId: "bookmark-1", absolutePath: "/Users/example/secret.png" } as never,
        provenance: { kind: "manual_import", sourceReceiptId: "receipt-1", sourceUrl: "https://private.invalid/file" } as never,
    });
    const projected = projectHostAssetVersion(value);
    const serialized = JSON.stringify(projected);
    assert.equal(projected.host.hostAssetId, "host-asset-1");
    assert.equal(projected.host.hostAssetVersionId, "host-version-1");
    assert.equal(serialized.includes("absolutePath"), false);
    assert.equal(serialized.includes("/Users/example"), false);
    assert.equal(serialized.includes("sourceUrl"), false);
    assert.equal(serialized.includes("private.invalid"), false);
});

test("opaque media references reject absolute paths and public URLs", () => {
    assert.throws(() => projectHostAssetVersion(projection({ media: { kind: "linked_external", bookmarkId: "/Users/example/asset.png" } })), FilmAssetValidationError);
    assert.throws(() => projectHostAssetVersion(projection({ media: { kind: "linked_external", bookmarkId: "https://example.invalid/asset.png" } })), FilmAssetValidationError);
    assert.throws(() => projectHostAssetVersion(projection({ media: { kind: "linked_external", bookmarkId: "../outside/asset.png" } })), FilmAssetValidationError);
});

test("Host resource projection requires the same stable Resource id on both references", () => {
    assert.throws(
        () =>
            projectHostAssetVersion(
                projection({
                    host: { hostAssetId: "host-asset-1", hostAssetVersionId: "host-version-1", contentHash: HASH_A },
                }),
            ),
        /same Host resource id/,
    );
});

test("Candidate creation is auditable but never implies approval", async () => {
    const result = await createCandidateAssetBinding(candidateInput(), { enabled: true });
    assert.equal(result.binding.lifecycle, "candidate");
    assert.equal(result.binding.version, 1);
    assert.equal(result.binding.asset.host.hostAssetVersionId, "host-version-1");
    assert.equal(result.audit.action, "asset_binding.candidate_created");
    assert.equal(result.audit.entityId, CANDIDATE_ID);
    assert.equal(Object.isFrozen(result.audit), true);
});

test("approval requires expected_version, passing QC, integrity, and authorization", async () => {
    const { binding: candidate } = await createCandidateAssetBinding(candidateInput(), { enabled: true });
    const approval = {
        approvedBindingId: APPROVED_ID,
        auditEventId: APPROVED_AUDIT_ID,
        expectedVersion: candidate.version,
        reviewId: REVIEW_ID,
        qcReportId: QC_REPORT_ID,
        qcOutcome: "pass" as const,
        actorId: "reviewer-1",
        approvedAt: "2026-08-28T08:05:00.000Z",
    };

    await assert.rejects(approveCandidateAssetBinding(candidate, { ...approval, expectedVersion: 9 }, { enabled: true }), /expected_version conflict/);
    await assert.rejects(approveCandidateAssetBinding(candidate, { ...approval, qcOutcome: "fail" }, { enabled: true }), /passing QC/);

    const unverified = await createCandidateAssetBinding(candidateInput(projection({ authorization: { state: "unverified" } })), { enabled: true });
    await assert.rejects(approveCandidateAssetBinding(unverified.binding, approval, { enabled: true }), /Authorization evidence/);

    const changed = await createCandidateAssetBinding(candidateInput(projection({ integrity: { state: "changed", observedContentHash: HASH_B } })), { enabled: true });
    await assert.rejects(approveCandidateAssetBinding(changed.binding, approval, { enabled: true }), /Verified media integrity/);

    const cache = await createCandidateAssetBinding(candidateInput(projection({ media: { kind: "regenerable_cache", cacheKey: "resource-cache-1" } })), { enabled: true });
    await assert.rejects(approveCandidateAssetBinding(cache.binding, approval, { enabled: true }), /regenerable cache/);
});

test("approval creates a separate immutable projection and preserves Candidate history", async () => {
    const { binding: candidate } = await createCandidateAssetBinding(candidateInput(), { enabled: true });
    const result = await approveCandidateAssetBinding(
        candidate,
        {
            approvedBindingId: APPROVED_ID,
            auditEventId: APPROVED_AUDIT_ID,
            expectedVersion: 1,
            reviewId: REVIEW_ID,
            qcReportId: QC_REPORT_ID,
            qcOutcome: "pass",
            actorId: "reviewer-1",
            approvedAt: "2026-08-28T08:05:00.000Z",
        },
        { enabled: true },
    );

    assert.notEqual(result.binding.id, candidate.id);
    assert.equal(result.binding.sourceCandidateId, candidate.id);
    assert.equal(result.binding.lifecycle, "approved");
    assert.equal(candidate.lifecycle, "candidate");
    assert.equal(result.audit.action, "asset_binding.approved");
    assert.equal(result.audit.sourceCandidateId, candidate.id);
});

test("VisualLock hash is canonical across map and collection insertion order", async () => {
    const { binding: candidate } = await createCandidateAssetBinding(candidateInput(), { enabled: true });
    const { binding: approved } = await approveCandidateAssetBinding(
        candidate,
        {
            approvedBindingId: APPROVED_ID,
            auditEventId: APPROVED_AUDIT_ID,
            expectedVersion: 1,
            reviewId: REVIEW_ID,
            qcReportId: QC_REPORT_ID,
            qcOutcome: "pass",
            actorId: "reviewer-1",
            approvedAt: "2026-08-28T08:05:00.000Z",
        },
        { enabled: true },
    );
    const firstCharacter = { entityId: CHARACTER_1_ID, versionId: CHARACTER_1_VERSION, contentHash: HASH_A } satisfies VersionedLockReference;
    const secondCharacter = { entityId: CHARACTER_2_ID, versionId: CHARACTER_2_VERSION, contentHash: HASH_B } satisfies VersionedLockReference;
    const reference = approvedBindingLockReference(approved);
    const first = await createVisualLockSet(
        {
            id: "55555555-5555-4555-8555-555555555555",
            scopeId: SCOPE_ID,
            version: 1,
            createdAt: CREATED_AT,
            components: {
                characterIdentityVersions: [firstCharacter, secondCharacter],
                referenceRoleMap: { hero: reference, foreground: reference },
            },
        },
        { enabled: true },
    );
    const second = await createVisualLockSet(
        {
            id: "66666666-6666-4666-8666-666666666666",
            scopeId: SCOPE_ID,
            version: 2,
            createdAt: "2026-08-28T09:00:00.000Z",
            components: {
                referenceRoleMap: { foreground: reference, hero: reference },
                characterIdentityVersions: [secondCharacter, firstCharacter],
            },
        },
        { enabled: true },
    );
    assert.equal(first.visualLockHash, second.visualLockHash);
    assert.equal(first.visualLockHash.length, 64);
});

test("VisualLock diff marks only consumers of changed dependency leaves as STALE", async () => {
    const oldProp = { entityId: PROP_ID, versionId: PROP_V1_ID, contentHash: HASH_A };
    const newProp = { entityId: PROP_ID, versionId: PROP_V2_ID, contentHash: HASH_B };
    const character = { entityId: CHARACTER_1_ID, versionId: CHARACTER_1_VERSION, contentHash: HASH_C };
    const previous = await createVisualLockSet(
        {
            id: "77777777-7777-4777-8777-777777777777",
            scopeId: SCOPE_ID,
            version: 1,
            createdAt: CREATED_AT,
            components: { propStateVersions: [oldProp], characterIdentityVersions: [character] },
        },
        { enabled: true },
    );
    const next = await createVisualLockSet(
        {
            id: "88888888-8888-4888-8888-888888888888",
            scopeId: SCOPE_ID,
            version: 2,
            createdAt: "2026-08-28T09:00:00.000Z",
            components: { characterIdentityVersions: [character], propStateVersions: [newProp] },
        },
        { enabled: true },
    );
    const impact = diffVisualLockSets(previous, next, [
        { entityId: CONSUMER_PROP_ID, dependencies: [`propStateVersions:${PROP_ID}`] },
        { entityId: CONSUMER_ALL_PROPS_ID, dependencies: ["propStateVersions"] },
        { entityId: CONSUMER_CHARACTER_ID, dependencies: [`characterIdentityVersions:${CHARACTER_1_ID}`] },
        { entityId: CONSUMER_UNRELATED_ID, dependencies: ["cameraVersion"] },
    ]);

    assert.deepEqual(impact.staleEntityIds, [CONSUMER_PROP_ID, CONSUMER_ALL_PROPS_ID].sort());
    assert.equal(impact.changedDependencies.includes("propStateVersions"), true);
    assert.equal(impact.changedDependencies.includes(`propStateVersions:${PROP_ID}`), true);
    assert.equal(impact.changedDependencies.includes(`characterIdentityVersions:${CHARACTER_1_ID}`), false);
});

test("VisualLock rejects non-approved role references at runtime", async () => {
    await assert.rejects(
        createVisualLockSet(
            {
                id: "99999999-9999-4999-8999-999999999999",
                scopeId: SCOPE_ID,
                version: 1,
                createdAt: CREATED_AT,
                components: {
                    referenceRoleMap: {
                        hero: {
                            lifecycle: "candidate",
                            bindingId: CANDIDATE_ID,
                            bindingVersion: 1,
                            purpose: "character_identity",
                            hostAssetVersionId: "host-version-1",
                            contentHash: HASH_A,
                            reviewId: REVIEW_ID,
                        } as never,
                    },
                },
            },
            { enabled: true },
        ),
        /require Approved bindings/,
    );
});

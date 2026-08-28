import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProjectDetail } from "@/services/api/projects";

import fixture from "./fixtures/golden-b.json";
import { runGoldenBLocalFixture } from "./golden-b.node";
import { DEFAULT_FILM_HOST_ASSET_READONLY_ENABLED, projectHostAssetInventory, projectProjectDetailAssetInventory, resolveHostAssetReadonlyEnabled, type HostAssetInventorySnapshot } from "./host-inventory";

const goldenFixture = fixture as HostAssetInventorySnapshot;

test("Host Asset read-only projection has its own explicit default-off feature flag", () => {
    assert.equal(DEFAULT_FILM_HOST_ASSET_READONLY_ENABLED, false);
    assert.equal(resolveHostAssetReadonlyEnabled({}), false);
    assert.equal(resolveHostAssetReadonlyEnabled({ VITE_FILM_HOST_ASSET_READONLY: "1" }), false);
    assert.equal(resolveHostAssetReadonlyEnabled({ VITE_FILM_HOST_ASSET_READONLY: "true" }), true);
});

test("Golden B fixture replays the complete Host four-layer projection without persistence or Provider calls", () => {
    const receipt = runGoldenBLocalFixture();
    assert.equal(receipt.testStatus, "PASSED_LOCAL_FIXTURE");
    assert.equal(receipt.prepared, true);
    assert.equal(receipt.persisted, false);
    assert.equal(receipt.externalProviderCalls, 0);
    assert.equal(receipt.hostOwnsMedia, true);
    assert.equal(receipt.projection.asset.id, "host-asset-golden-b");
    assert.equal(receipt.projection.version.id, "host-asset-version-golden-b-v3");
    assert.equal(receipt.projection.version.contentHash, "a".repeat(64));
    assert.equal(receipt.projection.representations[0]?.id, "host-representation-golden-b-primary");
    assert.equal(receipt.projection.representations[0]?.resource.id, "host-resource-golden-b-primary");
    assert.equal(receipt.projection.integrity?.state, "verified");
    assert.equal(receipt.projection.authorization?.state, "verified");
    assert.equal(receipt.projection.provenance?.kind, "manual_import");
    assert.equal(receipt.projection.bindings.candidates.length, 1);
    assert.equal(receipt.projection.bindings.approved.length, 1);
});

test("Host confirmed status never fabricates a Film Approved purpose binding", () => {
    const snapshot = structuredClone(goldenFixture);
    snapshot.bindings = [];
    const projection = projectHostAssetInventory(snapshot);
    assert.equal(projection.asset.status, "confirmed");
    assert.equal(projection.bindings.candidates.length, 0);
    assert.equal(projection.bindings.approved.length, 0);
});

test("binding guards and representation metadata fail closed on drift, locators, or secrets", () => {
    const stale = structuredClone(goldenFixture);
    stale.bindings[0]!.contentHash = "b".repeat(64);
    assert.throws(() => projectHostAssetInventory(stale), /does not match/);

    const secret = structuredClone(goldenFixture);
    secret.representations[0]!.metadata = { apiKey: "hidden" };
    assert.throws(() => projectHostAssetInventory(secret), /secret field/);

    const locator = structuredClone(goldenFixture);
    locator.representations[0]!.metadata = { source: "data:image/png;base64,AAAA" };
    assert.throws(() => projectHostAssetInventory(locator), /path, URL, or data payload/);

    const locatorKey = structuredClone(goldenFixture);
    locatorKey.representations[0]!.metadata = { sourceUrl: "opaque" };
    assert.throws(() => projectHostAssetInventory(locatorKey), /locator field/);
});

test("current ProjectDetail projects only known Host IDs and explicitly reports missing hashes and evidence", () => {
    const projection = projectProjectDetailAssetInventory(projectDetail())[0]!;
    assert.equal(projection.completeness, "partial_host_summary");
    assert.equal(projection.asset.id, "host-asset-1");
    assert.equal(projection.version.id, "host-version-1");
    assert.equal(projection.version.number, 3);
    assert.equal(projection.version.contentHash, null);
    assert.deepEqual(projection.missingFields, ["version.contentHash", "representation.metadata", "authorization", "provenance"]);
    assert.equal(projection.representations[0]?.id, "host-representation-1");
    assert.equal(projection.representations[0]?.resource.id, "host-resource-1");
});

function projectDetail(): ProjectDetail {
    return {
        project: {
            id: "host-project-1",
            userId: "host-user-1",
            name: "Golden B",
            type: "short-drama",
            aspectRatio: "9:16",
            sourceType: "blank",
            description: "",
            stylePresetId: "",
            status: "active",
            revision: 1,
            createdAt: "2026-08-28T00:00:00Z",
            updatedAt: "2026-08-28T00:00:00Z",
        },
        units: [],
        canvases: [],
        canvasUnitLinks: [],
        assets: [
            {
                id: "host-asset-1",
                title: "女主定妆",
                mediaType: "entity",
                category: "character",
                status: "confirmed",
                primaryVersionId: "host-version-1",
                versionCount: 3,
                usages: [],
                position: 0,
                updatedAt: "2026-08-28T00:00:00Z",
                character: {
                    versionId: "host-version-1",
                    version: 3,
                    definition: {},
                    representations: [{ id: "host-representation-1", resourceId: "host-resource-1", mediaType: "image", role: "primary" }],
                    visualStatus: "ready",
                    voiceStatus: "missing",
                },
            },
        ],
        assetFolders: [],
        workflows: [],
        shots: [],
        shotReferences: [],
        assetCandidates: [],
    };
}

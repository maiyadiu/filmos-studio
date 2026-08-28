import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import fixture from "./fixtures/golden-b.json";
import { FilmHostAssetReadonlyEntry, HostAssetInventoryPanel } from "./host-inventory-panel";
import { projectHostAssetInventory, type HostAssetInventorySnapshot } from "./host-inventory";

test("flag-off produces no Film Asset DOM and performs no request", () => {
    let requestCount = 0;
    const detail = new Proxy({} as never, {
        get() {
            requestCount += 1;
            throw new Error("disabled entry must not inspect ProjectDetail");
        },
    });
    const html = renderToStaticMarkup(<FilmHostAssetReadonlyEntry detail={detail} env={{}} />);
    assert.equal(html, "");
    assert.equal(requestCount, 0);
});

test("enabled ProjectDetail entry renders only known Host facts and names missing fields", () => {
    const html = renderToStaticMarkup(<FilmHostAssetReadonlyEntry detail={projectDetail()} env={{ VITE_FILM_HOST_ASSET_READONLY: "true" }} />);
    assert.match(html, /Host Asset \/ Version \/ Representation \/ Resource/);
    assert.match(html, /host-asset-1/);
    assert.match(html, /host-version-1/);
    assert.match(html, /Host summary 未提供/);
    assert.match(html, /事实缺口/);
    assert.doesNotMatch(html, /已批准/);
});

test("complete Golden B projection displays hashes, representation metadata, authorization, provenance, and separate binding counts", () => {
    const projection = projectHostAssetInventory(fixture as HostAssetInventorySnapshot);
    const html = renderToStaticMarkup(<HostAssetInventoryPanel projections={[projection]} />);
    assert.match(html, new RegExp("a".repeat(64)));
    assert.match(html, /host-representation-golden-b-primary/);
    assert.match(html, /host-resource-golden-b-primary/);
    assert.match(html, /identityLock/);
    assert.match(html, /rights-golden-b/);
    assert.match(html, /source-receipt-golden-b/);
    assert.match(html, /1 Candidate \/ 1 Approved/);
});

function projectDetail() {
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
        assets: [{ id: "host-asset-1", title: "道具门", mediaType: "image", category: "prop", status: "confirmed", primaryVersionId: "host-version-1", versionCount: 2, usages: [], position: 0, updatedAt: "2026-08-28T00:00:00Z" }],
        assetFolders: [],
        workflows: [],
        shots: [],
        shotReferences: [],
        assetCandidates: [],
    };
}

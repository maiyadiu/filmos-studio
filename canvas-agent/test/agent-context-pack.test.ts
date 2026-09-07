import assert from "node:assert/strict";
import test from "node:test";

import type { BrainSession } from "../src/brains/contracts.js";
import { AgentContextBroker } from "../src/brains/context-broker.js";

test("context broker emits stable IDs and rejects stale or cross-session receipts", () => {
    const broker = new AgentContextBroker();
    const first = session("session-1");
    const second = session("session-2");
    const snapshot = {
        projectId: "project-1",
        domainProjectId: "film-1",
        contentUnitId: "unit-1",
        sceneId: "scene-1",
        directorUnitId: "director-1",
        shotId: "shot-1",
        canvasId: "canvas-1",
        canvasRevision: 9,
        canvasStateHash: "sha256:canvas-9",
        nodes: [{ id: "node-1", type: "shot", title: "镜头 1" }],
        connections: [],
        selectedNodeIds: ["node-1"],
        visibleNodeIds: ["node-1"],
        assets: [{ id: "asset-version-1", type: "asset" }],
        filmExpectedVersion: 4,
        filmContentHash: "sha256:film-4",
    };

    const { pack, receipt } = broker.capture(first, snapshot);

    assert.equal(pack.route.sceneId, "scene-1");
    assert.equal(pack.canvas.selectedSummaries[0]?.id, "node-1");
    assert.deepEqual(receipt.assetVersionIds, ["asset-version-1"]);
    assert.equal(broker.validate(receipt.receiptId, first, snapshot).receiptId, receipt.receiptId);
    assert.throws(() => broker.validate(receipt.receiptId, second, snapshot), /SESSION_MISMATCH/);
    assert.throws(() => broker.validate(receipt.receiptId, first, { ...snapshot, canvasRevision: 10 }), /CANVAS_STALE/);
    assert.throws(() => broker.validate(receipt.receiptId, first, { ...snapshot, filmExpectedVersion: 5 }), /FILM_STALE/);
});

function session(id: string): BrainSession {
    return {
        id,
        conversationId: `conversation-${id}`,
        brainProfileId: "codex.subscription",
        connectionId: "codex.subscription",
        projectId: "project-1",
        domainProjectId: "film-1",
        canvasId: "canvas-1",
        permissionGrantId: "grant-1",
        status: "ready",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };
}

test("project receipt cannot be reused across projects, pages, chapters or a canvas", () => {
    const broker = new AgentContextBroker();
    const current = { ...session("project-page"), domainProjectId: "project-1", canvasId: null, contentUnitId: "unit-1" };
    const snapshot = { projectId: "project-1", domainProjectId: "project-1", canvasId: null, contentUnitId: "unit-1", canvasRevision: 1, canvasStateHash: "project-page-hash", nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [], activePanel: "chapters" };
    const { pack, receipt } = broker.capture(current, snapshot);
    assert.equal(pack.canvas.id, null);
    assert.equal(pack.route.unitId, "unit-1");
    assert.deepEqual(pack.permissions.readableScopes, ["project", "assets"]);
    assert.deepEqual(pack.permissions.previewableScopes, []);
    assert.equal(broker.validate(receipt.receiptId, current, snapshot).domainProjectId, "project-1");
    for (const patch of [{ projectId: "other" }, { domainProjectId: undefined }, { contentUnitId: "other-unit" }, { contentUnitId: undefined }, { canvasId: "old-canvas" }, { canvasStateHash: "another-page" }]) {
        assert.throws(() => broker.validate(receipt.receiptId, current, { ...snapshot, ...patch }), /AGENT_CONTEXT_/);
    }
    assert.throws(() => broker.capture(current, { ...snapshot, nodes: [{ id: "old-node", type: "text" }] }), /PROJECT_CONTEXT_HAS_CANVAS_DATA/);
    assert.throws(() => broker.capture(current, { ...snapshot, contentUnitId: "other-unit" }), /SCOPE_MISMATCH/);
});

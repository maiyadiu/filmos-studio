import assert from "node:assert/strict";
import test from "node:test";

import { CanvasSession } from "../src/canvas-session.js";

test("workbench context returns explicit project mapping and canonical canvas guards", () => {
    const session = new CanvasSession();
    const update = session.updateState({
        projectId: "canvas-1",
        domainProjectId: "project-1",
        contentUnitId: "unit-1",
        sceneId: "scene-1",
        directorUnitId: "director-1",
        shotId: "shot-1",
        selectedNodeIds: ["node-1"],
        visibleNodeIds: ["node-1", "node-2"],
        assetVersionIds: ["asset-version-1"],
        nodes: [],
        connections: [],
        revision: 7,
    });

    const context = session.workbenchContext();

    assert.equal(update.accepted, true);
    assert.equal(context.projectId, "canvas-1");
    assert.equal(context.domainProjectId, "project-1");
    assert.equal(context.contentUnitId, "unit-1");
    assert.equal(context.canvasRevision, 7);
    assert.match(context.canvasStateHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(context.assetVersionIds, ["asset-version-1"]);
});

test("workbench context keeps an unlinked Host canvas explicit without inventing a Film project", () => {
    const session = new CanvasSession();
    session.updateState({ projectId: "canvas-1", nodes: [], connections: [] });
    const context = session.workbenchContext();
    assert.equal(context.projectId, "canvas-1");
    assert.equal("domainProjectId" in context, false);
});

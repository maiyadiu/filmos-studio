import assert from "node:assert/strict";
import test from "node:test";

import type { BrainSession } from "../src/brains/contracts.js";
import { contextSnapshotForSession } from "../src/brains/generic-agent-runtime.js";

test("review coordinator captures a deterministic issue-scoped context without an active canvas", () => {
    const session: BrainSession = {
        id: "review-session-1",
        conversationId: "review:FILMOS-ISSUE-test",
        brainProfileId: "codex.subscription",
        connectionId: "codex.subscription",
        projectId: "project-background",
        canvasId: "review-project-background",
        workspacePath: "/tmp/filmos-review-background",
        executionProfile: "review_coordinator",
        permissionGrantId: "grant-review-1",
        status: "ready",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const snapshot = contextSnapshotForSession(session, () => {
        throw new Error("当前没有已连接画布");
    });

    assert.equal(snapshot.projectId, session.projectId);
    assert.equal(snapshot.domainProjectId, session.projectId);
    assert.equal(snapshot.canvasId, session.canvasId);
    assert.equal(snapshot.canvasRevision, 0);
    assert.match(snapshot.canvasStateHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(snapshot.nodes, []);
    assert.deepEqual(snapshot.blockers, ["NO_ACTIVE_CANVAS_REQUIRED_FOR_REVIEW_COORDINATOR"]);
});

test("ordinary sessions still require the real live workbench snapshot", () => {
    const session = {
        id: "ordinary-session-1",
        conversationId: "ordinary",
        brainProfileId: "codex.subscription",
        connectionId: "codex.subscription",
        projectId: "project-1",
        canvasId: "canvas-1",
        permissionGrantId: "grant-1",
        status: "ready",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
    } satisfies BrainSession;

    assert.throws(() => contextSnapshotForSession(session, () => {
        throw new Error("当前没有已连接画布");
    }), /当前没有已连接画布/);
});

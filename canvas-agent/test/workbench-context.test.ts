import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CanvasSession } from "../src/canvas-session.js";
import { hashState } from "../src/canvas-context.js";
import { ensureProjectAgentWorkspace } from "../src/config.js";

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

test("project page context has no canvas, hashes its kind and cannot carry stale canvas state", async () => {
    const session = new CanvasSession();
    const state = { contextKind: "project" as const, projectId: "project-1", domainProjectId: "project-1", contentUnitId: "unit-1", nodes: [], connections: [], selectedNodeIds: [], activePanel: "chapters" };
    session.updateState(state);
    const context = session.agentContextSnapshot();
    assert.equal(session.health().hasCanvas, false);
    assert.equal(context.projectId, "project-1");
    assert.equal(context.domainProjectId, "project-1");
    assert.equal(context.canvasId, null);
    assert.equal(context.contentUnitId, "unit-1");
    assert.notEqual(hashState(state), hashState({ ...state, contextKind: "canvas" }));
    for (const patch of [{ projectId: "" }, { domainProjectId: undefined }, { domainProjectId: "other" }, { nodes: [{}] }, { connections: [{}] }, { selectedNodeIds: ["old-node"] }, { visibleNodeIds: ["old-node"] }, { contextKind: "unknown" }]) {
        assert.throws(() => session.updateState({ ...state, ...patch }), /AGENT_/);
        assert.deepEqual(session.agentContextSnapshot(), context);
    }
    for (const name of ["canvas_get_state", "canvas_apply_ops", "project_sync_storyboard", "project_save_prompt", "project_read_shot_image"]) {
        await assert.rejects(session.callTool(name, {}), /AGENT_TOOL_REQUIRES_CANVAS_CONTEXT/);
    }
    session.dispose();
});

test("project tools route only to the exact page client, never another open canvas", async () => {
    const session = new CanvasSession();
    const first: string[] = [], second: string[] = [];
    const response = (events: string[]) => Object.assign(new EventEmitter(), { writeHead() {}, write(value: string) { events.push(value); }, end() {} });
    try {
        session.openEvents(new URL("http://localhost/events?clientId=project-page"), response(first) as never);
        session.openEvents(new URL("http://localhost/events?clientId=other-canvas"), response(second) as never);
        const state = { contextKind: "project", projectId: "project-1", domainProjectId: "project-1", nodes: [], connections: [] };
        session.updateState(state, "project-page");
        const call = session.callTool("project_get_context", {});
        const event = first.find(value => value.startsWith("event: tool_call"))!;
        const payload = JSON.parse(event.split("data: ")[1]);
        assert.equal(payload.input.projectId, "project-1");
        assert.equal(second.some(value => value.startsWith("event: tool_call")), false);
        session.resolveResult({ requestId: payload.requestId, result: { projectId: "project-1" } });
        assert.deepEqual(await call, { projectId: "project-1" });
        await assert.rejects(session.callTool("project_get_context", { projectId: "other" }), /DOMAIN_PROJECT_MISMATCH/);
        session.updateState(state, "missing-client");
        await assert.rejects(session.callTool("project_get_context", {}), /当前没有已连接画布/);
        assert.equal(first.filter(value => value.startsWith("event: tool_call")).length, 1);
        assert.equal(second.some(value => value.startsWith("event: tool_call")), false);
    } finally { session.dispose(); }
});

test("project scratch workspace never creates canvas configuration or aliases unsafe IDs", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-scope-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = ensureProjectAgentWorkspace("project-1", root);
    assert.equal(workspace, path.join(root, "project-workspaces", "project-1"));
    assert.equal(ensureProjectAgentWorkspace("project-1", root), workspace);
    assert.deepEqual(fs.readdirSync(root), ["project-workspaces"]);
    assert.deepEqual(fs.readdirSync(workspace), []);
    for (const id of ["", "../project-1", "/project-1", "project/1", ".", "..", "p".repeat(121)]) {
        assert.throws(() => ensureProjectAgentWorkspace(id, root), /AGENT_CONTEXT_PROJECT_REQUIRED/);
    }
});

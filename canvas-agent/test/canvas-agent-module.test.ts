import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type Server } from "node:http";
import { test } from "node:test";

import { buildCanvasContext } from "../src/canvas-context.js";
import { CanvasSession } from "../src/canvas-session.js";
import { publicAgentRuntimeFailure } from "../src/local-runtime-security.js";
import { createLocalRuntimeApp } from "../src/local-runtime.js";
import { LocalRuntimeSessionManager } from "../src/local-runtime-session.js";
import { createCanvasAgentHttpModule, trustedCreateSessionInput } from "../src/modules/canvas-agent-http.js";
import { toolDescriptions, toolInputSchemas, toolNames } from "../src/schemas.js";
import type { LocalRuntimeConfig } from "../src/config.js";
import { AGENT_FEATURE_FLAG_IDS } from "../src/brains/feature-flags.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import { CodexApprovalCoordinator } from "../src/brains/codex-approval-coordinator.js";
import { accountCanvasFixture } from "./fixtures/account-canvas.js";

const authority = "127.0.0.1:41743";
const endpoint = `http://${authority}`;
const origin = "http://127.0.0.1:3001";
const token = "legacy-canvas-token-fixture";

test("generic HTTP decisions return native approvals to their owner, not the business broker", async () => {
    const config = fixtureConfig();
    config.agentFeatureFlags = Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map(id => [id, true]));
    const store = new MemoryBrainSessionStore();
    let confirmationId = "";
    const approvals = new CodexApprovalCoordinator(undefined, (_type, payload) => {
        const event = payload as { confirmation?: { id: string } };
        if (event.confirmation) confirmationId = event.confirmation.id;
    }, 5_000);
    const fixture = accountCanvasFixture(config, new CanvasSession(), { brainSessionStore: store, codexApprovals: approvals });
    const module = fixture.module;
    const account = await fixture.bind("fixture-owner");
    for (const id of ["native-session", "other-session"]) await store.saveSession({
        id, conversationId: id, brainProfileId: "codex.subscription", connectionId: "codex.subscription",
        accountScopeId: account.binding.accountScopeId,
        projectId: "project-1", canvasId: "canvas-1", permissionGrantId: "fixture-grant", status: "ready",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const route = module.routes.find(item => item.path === "/agent/confirmations/:confirmationId/decision")!;
    const decide = (sessionId: string, approved: boolean, id = confirmationId) => new Promise<Record<string, unknown>>((resolve, reject) => {
        route.handler({ params: { confirmationId: id }, body: Buffer.from(JSON.stringify({ sessionId, approved, content: { choice: "fixture" } })) } as never, { locals: { runtimeSession: account.principal }, json: resolve } as never, reject);
    });
    try {
        assert.equal(route.scope, "agent:confirmations:decide");
        assert.equal(route.legacy, false);
        for (const approved of [true, false]) {
            const pending = approvals.request({ sessionId: "native-session", turnId: "workbench-turn", contextReceiptId: "receipt-1", request: { id: `native-${approved}`, method: "mcpServer/elicitation/request", params: {}, threadId: "thread-1", turnId: "provider-turn" } });
            const read = module.routes.find(item => item.path === "/agent/sessions/:sessionId")!;
            const view = await new Promise<{ session: { execution: { pendingConfirmations: Array<{ id: string; turnId: string }> } } }>((resolve, reject) => {
                read.handler({ params: { sessionId: "native-session" } } as never, { locals: { runtimeSession: account.principal }, json: resolve } as never, reject);
            });
            assert.deepEqual(view.session.execution.pendingConfirmations.map(item => ({ id: item.id, turnId: item.turnId })), [{ id: confirmationId, turnId: "workbench-turn" }]);
            await assert.rejects(decide("other-session", approved), /SESSION_MISMATCH/);
            const response = await decide("native-session", approved);
            assert.equal(response.ok, true);
            assert.equal((response.confirmation as { status: string }).status, approved ? "approved" : "rejected");
            assert.deepEqual(await pending, approved ? { approved, content: { choice: "fixture" } } : { approved });
            assert.deepEqual(approvals.pendingForSession("native-session"), []);
            await assert.rejects(decide("native-session", approved), /CONFIRMATION_NOT_FOUND/);
        }
        // An ID not owned by the native coordinator still follows the broker path.
        await assert.rejects(decide("native-session", true, "business-missing"), /CONFIRMATION_NOT_FOUND/);
    } finally { await module.dispose?.(); }
});

test("workspace HTTP identity and snapshot use the Runtime owner without a browser project substitute", async () => {
    const config = fixtureConfig();
    config.agentFeatureFlags = Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map(id => [id, true]));
    const session = new CanvasSession();
    const fixture = accountCanvasFixture(config, session);
    const module = fixture.module;
    const account = await fixture.bind("workspace-user");
    await fixture.connect(account.principal, "workspace-client");
    const invoke = (routePath: string, body = {}, query = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const route = module.routes.find(route => route.path === routePath)!;
        route.handler({ body: Buffer.from(JSON.stringify(body)), query: { ...query, ...(routePath === "/canvas/state" ? { clientId: "workspace-client" } : {}) } } as never, { locals: { runtimeSession: account.principal }, json: resolve } as never, reject);
    });
    try {
        const route = module.routes.find(route => route.path === "/agent/workspace")!;
        assert.equal(route.scope, "agent:profiles:read");
        assert.equal(route.legacy, false);
        assert.deepEqual(await invoke("/agent/workspace"), { ok: true, workspaceId: config.ownerId });
        const state = { contextKind: "workspace", projectId: null, activePanel: "assets", nodes: [], connections: [] };
        assert.equal((await invoke("/canvas/state", state)).accepted, true);
        assert.equal(session.withAccountScope(account.binding.accountScopeId, () => session.agentContextSnapshot()).workspaceId, config.ownerId);
        await assert.rejects(invoke("/canvas/state", { ...state, workspaceId: "spoofed-workspace" }), /WORKSPACE_REQUIRED/);
        assert.equal(session.withAccountScope(account.binding.accountScopeId, () => session.agentContextSnapshot()).workspaceId, config.ownerId);
        await assert.rejects(invoke("/agent/sessions", {}, { workspaceId: config.ownerId, projectId: "old-project" }), /WORKSPACE_PROJECT_MIXED/);
    } finally { await module.dispose?.(); }
});

test("MCP manifest exposes the semantic canvas read tools with schemas and descriptions", () => {
    const expected = [
        "canvas_get_context",
        "canvas_find_nodes",
        "canvas_get_node",
        "canvas_get_connection",
        "canvas_get_generation_tasks",
        "canvas_get_resources",
        "canvas_validate_ops",
    ];
    for (const name of expected) {
        assert.ok(toolNames.includes(name as typeof toolNames[number]), `${name} is missing from toolNames`);
        assert.ok(toolDescriptions[name as keyof typeof toolDescriptions], `${name} is missing a description`);
        assert.ok(toolInputSchemas[name as keyof typeof toolInputSchemas], `${name} is missing an input schema`);
    }
    assert.deepEqual(
        toolNames.filter((name) => name.startsWith("canvas_")).slice(0, 10),
        [
            "canvas_get_state",
            "canvas_get_context",
            "canvas_find_nodes",
            "canvas_get_node",
            "canvas_get_connection",
            "canvas_get_generation_tasks",
            "canvas_get_resources",
            "canvas_validate_ops",
            "canvas_get_selection",
            "canvas_export_snapshot",
        ],
    );
});

test("Canvas module declares signed Agent scopes and constructs default-off without CLI side effects", () => {
    const calls: string[] = [];
    const module = createCanvasAgentHttpModule(fixtureConfig(), sessionFixture(calls));

    assert.deepEqual(module.descriptor, {
        id: "canvas-agent",
        displayName: "Canvas Agent",
        apiVersion: 1,
        scopes: ["canvas:connect", "agent:profiles:read", "agent:sessions:read", "agent:sessions:manage", "agent:turns:run", "agent:confirmations:decide", "agent:tools:execute", "agent:handoff:manage"],
    });
    assert.ok(module.routes.some((route) => route.path === "/events" && route.lastEventId));
    assert.ok(module.routes.every((route) => route.scope === "canvas:connect" && route.legacy));
    assert.equal(module.routes.some((route) => route.path === "/agent/connections"), false, "generic runtime is default-off");
    assert.deepEqual(calls, []);
});

test("complete feature set registers generic routes without legacy browser authorization", async () => {
    const config = fixtureConfig();
    config.agentFeatureFlags = Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map((id) => [id, true]));
    const module = createCanvasAgentHttpModule(config, new CanvasSession(), { brainSessionStore: new MemoryBrainSessionStore() });
    try {
        assert.equal(module.routes.some((route) => route.path === "/agent/connections"), true);
        assert.equal(module.routes.some((route) => route.path === "/agent/sessions/:sessionId/resume"), true);
        assert.equal(module.routes.some((route) => route.path === "/agent/codex/turn"), true);
        assert.equal(module.routes.find((route) => route.path === "/agent/connections")?.legacy, false);
        assert.equal(module.routes.find((route) => route.path === "/agent/sessions/:sessionId/tools")?.scope, "agent:tools:execute");
        assert.equal(module.routes.find((route) => route.path === "/agent/sessions/:sessionId/history")?.scope, "agent:sessions:read");
    } finally {
        await module.dispose?.();
    }
});

test("generic session input ignores model-supplied identity and uses the live workbench scope", () => {
    const input = trustedCreateSessionInput({
        conversationId: "conversation-1",
        brainProfileId: "codex.subscription",
        actorId: "spoofed-actor",
        projectId: "spoofed-project",
        canvasId: "spoofed-canvas",
        billingMode: "none",
    }, {
        projectId: "host-project",
        domainProjectId: "film-project",
        contentUnitId: "unit-1",
        sceneId: "scene-1",
        directorUnitId: "director-1",
        shotId: "shot-1",
        canvasId: "canvas-1",
        canvasRevision: 4,
        canvasStateHash: "sha256:canvas",
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        visibleNodeIds: [],
        assets: [],
    }, "trusted-owner");

    assert.deepEqual(input, {
        conversationId: "conversation-1",
        brainProfileId: "codex.subscription",
        projectId: "host-project",
        domainProjectId: "film-project",
        contentUnitId: "unit-1",
        sceneId: "scene-1",
        directorUnitId: "director-1",
        shotId: "shot-1",
        canvasId: "canvas-1",
        actorId: "trusted-owner",
    });
});

test("generic project-page session keeps null canvas despite a caller supplying a canvas ID", () => {
    const current = { projectId: "business-1", domainProjectId: "business-1", canvasId: null, contentUnitId: "unit-1", canvasRevision: 2, canvasStateHash: "project-page", nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
    const input = trustedCreateSessionInput({ conversationId: "conversation-1", brainProfileId: "codex.subscription", projectId: "other-project", canvasId: "old-canvas", contentUnitId: "other-unit", workspacePath: "/spoofed" }, current, "trusted-owner");
    assert.equal(input.canvasId, null);
    assert.equal(input.projectId, "business-1");
    assert.equal(input.domainProjectId, "business-1");
    assert.equal(input.contentUnitId, "unit-1");
    assert.equal(input.workspacePath, undefined);
    assert.equal(input.actorId, "trusted-owner");
});

test("Canvas legacy guard strips token before core handlers and rejects the wrong token", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = sessionFixture(calls);
    const module = createCanvasAgentHttpModule(fixtureConfig(), session);
    const manager = new LocalRuntimeSessionManager({
        endpoint,
        trustedOrigins: [origin],
        registrations: [],
    });
    const app = createLocalRuntimeApp({
        authority,
        endpoint,
        version: "0.1.0",
        sessionManager: manager,
        modules: [module],
        legacyMasterToken: token,
        legacyOrigins: [origin],
    });
    const server = app.listen(0, "127.0.0.1");
    await listening(server);
    try {
        const accepted = await request(server, {
            method: "POST",
            path: `/canvas/state?clientId=fixture&token=${token}`,
            headers: jsonHeaders(),
            body: '{"nodes":[]}',
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(calls.at(-1), { name: "state", value: { nodes: [] } });

        const event = await request(server, {
            path: `/events?clientId=fixture&token=${token}`,
            headers: { Host: authority, Origin: origin },
        });
        assert.equal(event.status, 204);
        assert.deepEqual(calls.at(-1), {
            name: "events",
            value: { clientId: "fixture", token: null },
        });

        const before = calls.length;
        const rejected = await request(server, {
            method: "POST",
            path: "/canvas/state?token=wrong",
            headers: jsonHeaders(),
            body: '{"nodes":[]}',
        });
        assert.equal(rejected.status, 401);
        assert.equal(calls.length, before);
    } finally {
        manager.dispose();
        await close(server);
    }
});

test("CanvasSession dispose closes streams and a replaced stream cannot clear the active client", () => {
    const session = new CanvasSession();
    const first = eventResponse();
    const second = eventResponse();

    session.openEvents(new URL("http://127.0.0.1/events?clientId=fixture"), first.response as never);
    session.updateState({ nodes: [] }, "fixture");
    session.openEvents(new URL("http://127.0.0.1/events?clientId=fixture"), second.response as never);
    first.response.emit("close");
    assert.deepEqual(session.health(), { ok: true, hasCanvas: true, clients: 1 });

    session.dispose();
    assert.equal(second.ended(), 1);
    assert.deepEqual(session.health(), { ok: true, hasCanvas: false, clients: 0 });
    second.response.emit("close");
});

test("CanvasSession exposes precise node and connection reads", async () => {
    const session = new CanvasSession();
    const response = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=precise-read"), response.response as never);
    session.updateState({
        nodes: [
            { id: "node-a", type: "text", title: "A", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "node-b", type: "image", title: "B", position: { x: 400, y: 0 }, width: 320, height: 320, metadata: { status: "success", storageKey: "resource:b" } },
        ],
        connections: [{ id: "connection-1", fromNodeId: "node-a", toNodeId: "node-b" }],
    }, "precise-read");
    assert.equal((await session.callTool("canvas_get_node", { id: "node-b" }) as { found: boolean }).found, true);
    assert.equal((await session.callTool("canvas_get_connection", { id: "connection-1" }) as { found: boolean }).found, true);
    assert.equal((await session.callTool("canvas_get_node", { id: "missing" }) as { found: boolean }).found, false);
    session.dispose();
});

test("CanvasSession closes only streams owned by a revoked Runtime session", async context => {
    const session = new CanvasSession();
    context.after(() => session.dispose());
    const closeRuntimeSession = (session as CanvasSession & {
        closeRuntimeSession?: (sessionId: string) => void;
    }).closeRuntimeSession;
    assert.equal(typeof closeRuntimeSession, "function");
    if (!closeRuntimeSession) return;

    const first = eventResponse();
    const second = eventResponse();
    const legacy = eventResponse();
    const openEvents = session.openEvents as unknown as (
        url: URL,
        response: EventEmitter,
        runtimeSessionId?: string,
    ) => void;
    openEvents.call(session, new URL("http://127.0.0.1/events?clientId=first"), first.response, "session-a");
    openEvents.call(session, new URL("http://127.0.0.1/events?clientId=second"), second.response, "session-b");
    openEvents.call(session, new URL("http://127.0.0.1/events?clientId=legacy"), legacy.response);
    session.updateState({ nodes: [] }, "first", undefined, "session-a");
    const pending = session.callTool("canvas_apply_ops", { ops: [] });

    closeRuntimeSession.call(session, "session-a");

    assert.equal(first.ended(), 1);
    assert.equal(second.ended(), 0);
    assert.equal(legacy.ended(), 0);
    assert.deepEqual(session.health(), { ok: true, hasCanvas: false, clients: 2 });
    await assert.rejects(pending, /会话已撤销/);
    session.dispose();
});

test("Canvas tool bridge retains backend failures but never accepts invalid failure payloads as success", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=errors"), events.response as never);
    session.updateState({ nodes: [] }, "errors");
    try {
        for (const status of [404, 409, 503, "404", 200]) {
            const pending = session.callTool("canvas_apply_ops", { ops: [] });
            const call = latestToolCall(events.writes());
            session.resolveResult({ requestId: call.requestId, backendStatus: status, error: "SECRET backend details", result: { ok: true } });
            await assert.rejects(pending, error => {
                const failure = publicAgentRuntimeFailure(error);
                if (typeof status === "number" && status >= 400) {
                    assert.equal(failure?.statusCode, status);
                    assert.doesNotMatch(failure!.message, /SECRET/);
                } else assert.equal(failure, undefined);
                return true;
            });
        }
        for (const visualError of ["canvas_image_target_missing", "canvas_image_scope_mismatch", "canvas_image_stale", "canvas_image_unavailable", "canvas_image_invalid", "canvas_image_too_large", "unknown", true]) {
            const pending = session.callTool("project_read_shot_image", { projectId: "fixture", nodeId: "n", rowId: "project-shot:s" });
            const call = latestToolCall(events.writes());
            session.resolveResult({ requestId: call.requestId, visualError, error: "SECRET details", result: { ok: true } });
            await assert.rejects(pending, error => {
                const failure = publicAgentRuntimeFailure(error);
                if (typeof visualError === "string" && visualError.startsWith("canvas_image_")) {
                    assert.equal(failure?.code, visualError);
                    assert.doesNotMatch(failure!.message, /SECRET/);
                } else assert.equal(failure, undefined);
                return true;
            });
        }
        for (const localConflict of ["canvas_local_prompt_conflict", "unknown", true]) {
            const pending = session.callTool("canvas_apply_ops", { ops: [] });
            const call = latestToolCall(events.writes());
            session.resolveResult({ requestId: call.requestId, localConflict, error: "SECRET details", result: { ok: true } });
            await assert.rejects(pending, error => {
                const failure = publicAgentRuntimeFailure(error);
                if (localConflict === "canvas_local_prompt_conflict") {
                    assert.equal(failure?.code, localConflict);
                    assert.equal(failure?.statusCode, 409);
                    assert.doesNotMatch(failure!.message, /SECRET/);
                } else assert.equal(failure, undefined);
                return true;
            });
        }
    } finally { session.dispose(); }
});

test("expired browser session clears context and exposes recoverable status until authenticated reconnect", () => {
    const session = new CanvasSession();
    const first = eventResponse(), second = eventResponse();
    const state = { projectId: "canvas-fixture", domainProjectId: "project-fixture", contentUnitId: "unit-fixture", revision: 1, nodes: [], connections: [], selectedNodeIds: [] };
    try {
        session.openEvents(new URL("http://127.0.0.1/events?clientId=lease-fixture"), first.response as never, "old-lease");
        session.updateState(state, "lease-fixture", undefined, "old-lease");
        const before = session.agentContextSnapshot();
        session.closeRuntimeSession("old-lease");
        assert.equal(session.hasConnectedBrowser(), false);
        assert.throws(() => session.agentContextSnapshot(), error => {
            assert.equal(publicAgentRuntimeFailure(error)?.code, "canvas_context_unavailable");
            assert.equal(publicAgentRuntimeFailure(error)?.statusCode, 503);
            return true;
        });
        session.openEvents(new URL("http://127.0.0.1/events?clientId=lease-fixture"), second.response as never, "new-lease");
        assert.throws(() => session.agentContextSnapshot(), /CANVAS_CONTEXT_UNAVAILABLE/);
        session.updateState(state, "lease-fixture", undefined, "new-lease");
        assert.deepEqual(session.agentContextSnapshot(), before);
        assert.equal(session.hasConnectedBrowser(), true);
        assert.equal(first.writes().concat(second.writes()).some(value => value.includes("event: tool_call")), false);
    } finally { session.dispose(); }
});

test("Canvas generation tool continuation survives a browser stream reconnect until the same request is resolved", async () => {
    const session = new CanvasSession();
    const first = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-client-before-refresh"), first.response as never);
    session.updateState({
        nodes: [{ id: "existing-image", type: "image", title: "Existing", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { generationMode: "image", taskId: "dreamina:prior-task-0001" } }],
    }, "agent-client-before-refresh");

    try {
        const pending = session.callTool("canvas_run_generation", { nodeId: "existing-image", mode: "image", prompt: "Retry image", retry: true });
        const call = latestToolCall(first.writes());
        first.response.emit("close");
        let settled = false;
        void pending.finally(() => { settled = true; }).catch(() => undefined);
        await Promise.resolve();
        assert.equal(settled, false, "generation tool must remain resumable across a browser refresh");

        const second = eventResponse();
        session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-client-after-refresh"), second.response as never);
        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        assert.deepEqual(await pending, { accepted: true });
    } finally {
        session.dispose();
    }
});

test("CanvasSession expands a workflow into semantic nodes, non-overlapping layout, real edges, and selective generation", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-workflow"), events.response as never);
    session.updateState({
        nodes: [{ id: "existing-character", type: "image", title: "角色原画", position: { x: 0, y: 0 }, width: 560, height: 380, metadata: { status: "success", storageKey: "resource:character" } }],
        connections: [],
    }, "agent-workflow");

    try {
        const pending = session.callTool("canvas_create_workflow", {
            title: "搞笑修仙小说流水线",
            nodes: [
                { ref: "cards", kind: "character_cards", title: "角色拆分图片卡片", referenceNodeIds: ["existing-character"] },
                { ref: "views", kind: "character_three_view", title: "角色三视图", prompt: "基于角色卡片生成正面、侧面、背面三视图", referenceRefs: ["cards"] },
                { ref: "storyboard", kind: "storyboard_video", title: "分镜剧情视频", prompt: "基于三视图制作分镜剧情视频", referenceRefs: ["views"], runGeneration: true },
            ],
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        const added = ops.filter((op) => op.type === "add_node");
        const edges = ops.filter((op) => op.type === "connect_nodes");
        const runs = ops.filter((op) => op.type === "run_generation");

        assert.deepEqual(added.map((op) => op.nodeType), ["image", "image", "video"]);
        assert.match(String((added[0]?.metadata as Record<string, unknown>)?.prompt), /拆分主要角色/);
        assert.equal(edges.length, 3, "two workflow edges plus one existing reference edge");
        assert.equal(runs.length, 1, "runGeneration only affects the explicitly requested node");
        assert.equal(runs[0]?.nodeId, added[2]?.id);
        assert.ok(Number((added[1]?.position as { x: number }).x) > Number((added[0]?.position as { x: number }).x) + Number(added[0]?.width));
        assert.ok(Number((added[2]?.position as { x: number }).x) > Number((added[1]?.position as { x: number }).x) + Number(added[1]?.width));
        assert.ok(edges.some((op) => op.fromNodeId === "existing-character" && op.toNodeId === added[0]?.id));

        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        assert.deepEqual(await pending, { accepted: true });
    } finally {
        session.dispose();
    }
});

test("CanvasSession rejects media workflow nodes without real creative content", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-workflow-invalid"), events.response as never);
    session.updateState({ nodes: [] }, "agent-workflow-invalid");
    try {
        await assert.rejects(
            session.callTool("canvas_create_workflow", {
                nodes: [{ ref: "empty-image", kind: "image", title: "空图片节点" }],
            }),
            /缺少 prompt\/content/,
        );
        assert.equal(events.writes().some((value) => value.includes("event: tool_call")), false);
    } finally {
        session.dispose();
    }
});

test("Canvas Dreamina image generation preserves the shared product model and auto quality before run_generation", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-dreamina-product"), events.response as never);
    session.updateState({ nodes: [] }, "agent-dreamina-product");

    try {
        const generated = session.callTool("canvas_generate_image", {
            prompt: "A cinematic city at night",
            model: "local:dreamina-cli:5.0",
            quality: "auto",
            size: "16:9",
            count: 1,
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        const target = ops.find((op) => op.type === "add_node" && op.nodeType === "image");
        const metadata = target?.metadata as Record<string, unknown> | undefined;
        const run = ops.find((op) => op.type === "run_generation");
        assert.equal(metadata?.model, "local:dreamina-cli:5.0");
        assert.equal(metadata?.quality, "auto");
        assert.equal(metadata?.size, "16:9");
        assert.deepEqual(run && { type: run.type, nodeId: run.nodeId, mode: run.mode }, {
            type: "run_generation",
            nodeId: target?.id,
            mode: "image",
        });
        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        await generated;
    } finally {
        session.dispose();
    }
});

test("CanvasSession keeps ordinary tool timeout at 30s and generation continuation at 35min with one settlement", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const delays: number[] = [];
    const cleared = new Set<unknown>();
    let nextHandle = 0;
    Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: ((_: (...args: unknown[]) => void, delay?: number) => {
            delays.push(Number(delay));
            return { id: ++nextHandle, unref() {} };
        }) as typeof setTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: ((handle: unknown) => { cleared.add(handle); }) as typeof clearTimeout,
    });
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=timeout-client"), events.response as never);
    session.updateState({ nodes: [] }, "timeout-client");
    try {
        const ordinary = session.callTool("canvas_apply_ops", { ops: [{ type: "select_nodes", ids: [] }] });
        const ordinaryCall = latestToolCall(events.writes());
        assert.equal(delays.at(-1), 30_000);
        session.resolveResult({ requestId: ordinaryCall.requestId, result: { accepted: "ordinary" } });
        assert.deepEqual(await ordinary, { accepted: "ordinary" });

        const generation = session.callTool("canvas_generate_image", {
            prompt: "A safe fixture",
            model: "local:dreamina-cli:5.0",
            quality: "auto",
            size: "16:9",
            count: 1,
        });
        const generationCall = latestToolCall(events.writes());
        assert.equal(delays.at(-1), 35 * 60 * 1_000);
        let settlements = 0;
        void generation.then(() => { settlements += 1; }, () => { settlements += 1; });
        session.resolveResult({ requestId: generationCall.requestId, result: { accepted: "generation" } });
        assert.deepEqual(await generation, { accepted: "generation" });
        await Promise.resolve();
        assert.equal(settlements, 1);
        session.resolveResult({ requestId: generationCall.requestId, result: { accepted: "duplicate" } });
        await Promise.resolve();
        assert.equal(settlements, 1);
        assert.equal(cleared.size, 2);
    } finally {
        Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout });
        Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: originalClearTimeout });
        session.dispose();
    }
});

test("Canvas generation tools emit generic run operations and preserve product configuration values", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-client"), events.response as never);
    session.updateState({
        nodes: [{ id: "existing-image", type: "image", title: "Existing", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { generationMode: "image" } }],
    }, "agent-client");

    try {
        const generated = session.callTool("canvas_generate_video", { prompt: "A short test clip", seconds: "4", vquality: "720" });
        const generateCall = latestToolCall(events.writes());
        const generateOps = (generateCall.input as { ops: Array<Record<string, unknown>> }).ops;
        const target = generateOps.find((op) => op.type === "add_node" && op.nodeType === "video");
        const run = generateOps.find((op) => op.type === "run_generation");
        assert.equal((target?.metadata as Record<string, unknown>)?.vquality, "720");
        assert.deepEqual(run && { type: run.type, nodeId: run.nodeId, mode: run.mode }, { type: "run_generation", nodeId: target?.id, mode: "video" });
        session.resolveResult({ requestId: generateCall.requestId, result: { accepted: true } });
        await generated;

        const rerun = session.callTool("canvas_run_generation", { nodeId: "existing-image", mode: "image", prompt: "Retry image", retry: true });
        const rerunCall = latestToolCall(events.writes());
        assert.deepEqual(rerunCall.input, { ops: [{ type: "run_generation", nodeId: "existing-image", mode: "image", prompt: "Retry image", retry: true }] });
        session.resolveResult({ requestId: rerunCall.requestId, result: { accepted: true } });
        await rerun;
    } finally {
        session.dispose();
    }
});

function fixtureConfig(): LocalRuntimeConfig {
    return {
        url: endpoint,
        token,
        ownerId: "owner-canvas-fixture-001",
        origins: [origin],
        trustedWebOrigins: [origin],
        browserRegistrations: [],
        canvases: {},
    };
}

function sessionFixture(calls: Array<string | { name: string; value?: unknown }>) {
    return {
        health: () => ({ ok: true, hasCanvas: false, clients: 0 }),
        workbenchContext: () => ({ schemaVersion: "1" as const, projectId: "canvas-1", domainProjectId: "project-1", canvasId: "canvas-1", selectedNodeIds: [], visibleNodeIds: [], assetVersionIds: [], canvasRevision: 0, canvasStateHash: "hash" }),
        agentContextSnapshot: () => ({ projectId: "canvas-1", domainProjectId: "project-1", canvasId: "canvas-1", canvasRevision: 0, canvasStateHash: "hash", nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] }),
        openEvents: (url: URL, res: { status(code: number): unknown; end(): void }) => {
            calls.push({
                name: "events",
                value: { clientId: url.searchParams.get("clientId"), token: url.searchParams.get("token") },
            });
            res.status(204);
            res.end();
        },
        updateState: (value: unknown) => { calls.push({ name: "state", value }); },
        resolveResult: (value: unknown) => { calls.push({ name: "result", value }); },
        emitAll: () => undefined,
        callTool: async (name: unknown, value: unknown) => {
            calls.push({ name: String(name), value });
            return { accepted: true };
        },
        closeRuntimeSession: (sessionId: string) => { calls.push({ name: "revoke", value: sessionId }); },
        dispose: () => { calls.push("dispose"); },
    };
}

function jsonHeaders() {
    return { Host: authority, Origin: origin, "Content-Type": "application/json" };
}

function request(
    server: Server,
    options: { method?: string; path: string; headers: Record<string, string>; body?: string },
) {
    const address = server.address();
    assert(address && typeof address === "object");
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port: address.port,
            method: options.method ?? "GET",
            path: options.path,
            headers: options.headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.once("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

function eventResponse() {
    const writes: string[] = [];
    const response = new EventEmitter() as EventEmitter & {
        writeHead(): void;
        write(chunk: unknown): void;
        end(): void;
    };
    let ended = 0;
    response.writeHead = () => undefined;
    response.write = (chunk) => { writes.push(String(chunk)); };
    response.end = () => { ended += 1; };
    return { response, ended: () => ended, writes: () => [...writes] };
}

test("signed canvas client identity cannot be replaced or published by another session", () => {
    const session = new CanvasSession();
    const original = eventResponse();
    const attacker = eventResponse();
    const url = new URL("http://127.0.0.1/events?clientId=owned-client");
    try {
        session.openEvents(url, original.response as never, "signed-a");
        session.updateState({ projectId: "canvas-owned", nodes: [] }, "owned-client", undefined, "signed-a");
        for (const identity of ["signed-b", undefined]) {
            assert.throws(() => session.openEvents(url, attacker.response as never, identity), /不匹配/);
            assert.throws(() => session.updateState({ projectId: "canvas-substituted" }, "owned-client", undefined, identity), /不匹配/);
        }
        assert.throws(() => session.updateState({ projectId: "canvas-substituted" }, "missing-client", undefined, "signed-a"), /不匹配/);
        assert.throws(() => session.updateState({ projectId: "canvas-substituted" }, undefined, undefined, "signed-a"), /不匹配/);
        assert.equal(session.workbenchContext().projectId, "canvas-owned");
        assert.equal(original.ended(), 0);
        assert.deepEqual(attacker.writes(), []);
        const replacement = eventResponse();
        session.openEvents(url, replacement.response as never, "signed-a");
        original.response.emit("close");
        assert.equal(session.hasConnectedBrowser(), true);
        assert.equal(original.ended(), 1);
    } finally { session.dispose(); }
});

test("signed results require both the original session and client without consuming the pending request", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    try {
        session.openEvents(new URL("http://127.0.0.1/events?clientId=owned-client"), events.response as never, "signed-a");
        session.updateState({ nodes: [] }, "owned-client", undefined, "signed-a");
        const pending = session.callTool("canvas_apply_ops", { ops: [{ type: "select_nodes", ids: [] }] });
        const { requestId } = latestToolCall(events.writes());
        for (const [clientId, identity] of [["owned-client", "signed-b"], ["other-client", "signed-a"], [undefined, "signed-a"], ["owned-client", undefined]]) {
            assert.throws(() => session.resolveResult({ requestId, result: "forged" }, clientId, identity), /不匹配/);
        }
        session.resolveResult({ requestId, result: "original" }, "owned-client", "signed-a");
        assert.equal(await pending, "original");
        session.resolveResult({ requestId, result: "duplicate" }, "owned-client", "signed-a");
    } finally { session.dispose(); }
});

test("recoverable generation retains signed ownership across SSE loss and is rejected on revocation", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    const url = new URL("http://127.0.0.1/events?clientId=generation-client");
    try {
        session.openEvents(url, events.response as never, "signed-a");
        session.updateState({ nodes: [] }, "generation-client", undefined, "signed-a");
        const pending = session.callTool("canvas_generate_image", { prompt: "Fixture only", model: "fixture", quality: "auto", size: "1:1", count: 1 });
        const result = assert.rejects(pending, /本机会话已撤销/);
        const { requestId } = latestToolCall(events.writes());
        events.response.emit("close");
        assert.equal(session.hasConnectedBrowser(), false);
        const other = eventResponse();
        assert.throws(() => session.openEvents(url, other.response as never, "signed-b"), /不匹配/);
        assert.throws(() => session.resolveResult({ requestId, result: "forged" }, "generation-client", "signed-b"), /不匹配/);
        session.closeRuntimeSession("signed-a");
        await result;
        session.resolveResult({ requestId, result: "late" }, "generation-client", "signed-a");
        assert.deepEqual(other.writes(), []);
    } finally { session.dispose(); }
});

test("same signed client can recover a result after transient SSE loss without replaying generation", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    const url = new URL("http://127.0.0.1/events?clientId=recover-client");
    try {
        session.openEvents(url, events.response as never, "signed-a");
        session.updateState({ nodes: [] }, "recover-client", undefined, "signed-a");
        const pending = session.callTool("canvas_generate_image", { prompt: "Fixture only", model: "fixture", quality: "auto", size: "1:1", count: 1 });
        const { requestId } = latestToolCall(events.writes());
        events.response.emit("close");
        const resumed = eventResponse();
        session.openEvents(url, resumed.response as never, "signed-a");
        session.resolveResult({ requestId, result: "recovered" }, "recover-client", "signed-a");
        assert.equal(await pending, "recovered");
        assert.equal(resumed.writes().filter(item => item.startsWith("event: tool_call")).length, 0);
    } finally { session.dispose(); }
});

test("canvas requests never fall back to another connected tab", async () => {
    const session = new CanvasSession();
    const other = eventResponse();
    try {
        session.openEvents(new URL("http://127.0.0.1/events?clientId=unrelated"), other.response as never);
        session.updateState({ projectId: "canvas-original", nodes: [] }, "unavailable");
        assert.equal(session.hasConnectedBrowser(), false);
        await assert.rejects(session.request({ channel: "model", operation: "probe", profileId: "fixture", payload: {} }), /没有已连接画布/);
        assert.equal(other.writes().filter(item => item.startsWith("event: browser_runtime_request")).length, 0);
    } finally { session.dispose(); }
});

test("browser result can settle synchronously during dispatch and failed dispatch leaves no pending request", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    try {
        session.openEvents(new URL("http://127.0.0.1/events?clientId=dispatch"), events.response as never, "signed-a");
        session.updateState({ nodes: [] }, "dispatch", undefined, "signed-a");
        const originalWrite = events.response.write;
        events.response.write = chunk => {
            originalWrite(chunk);
            session.resolveResult({ requestId: latestToolCall(events.writes()).requestId, result: "immediate" }, "dispatch", "signed-a");
        };
        assert.equal(await session.callTool("canvas_apply_ops", { ops: [{ type: "select_nodes", ids: [] }] }), "immediate");
        events.response.write = () => { throw new Error("fixture-write-failed"); };
        await assert.rejects(session.callTool("canvas_apply_ops", { ops: [{ type: "select_nodes", ids: [] }] }), /fixture-write-failed/);
        session.closeRuntimeSession("signed-a");
    } finally { session.dispose(); }
});

function latestToolCall(writes: string[]) {
    const event = [...writes].reverse().find((value) => value.startsWith("event: tool_call\n"));
    assert.ok(event);
    const data = event.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data);
    return JSON.parse(data.slice("data: ".length)) as { requestId: string; name: string; input: unknown };
}

function listening(server: Server) {
    if (server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
}

function close(server: Server) {
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("CanvasSession rejects stale state revisions and accepts idempotent retries", () => {
    const session = new CanvasSession();
    const first = session.updateState({ projectId: "canvas-1", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, "fixture");
    assert.equal(first.accepted, true);
    assert.equal(first.revision, 0);

    const idempotent = session.updateState({ projectId: "canvas-1", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 }, "fixture");
    assert.equal(idempotent.accepted, true);
    assert.equal(idempotent.idempotent, true);

    const conflict = session.updateState({ projectId: "canvas-1", nodes: [{ id: "n-1", type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 }], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 }, "fixture");
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, "revision_conflict");

    const next = session.updateState({ projectId: "canvas-1", nodes: [{ id: "n-1", type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 }], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 1 }, "fixture");
    assert.equal(next.accepted, true);
    assert.equal(next.revision, 1);

    const stale = session.updateState({ projectId: "canvas-1", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 }, "fixture");
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, "stale_revision");
    session.dispose();
});


test("canvas_apply_ops enforces expected revision and state hash before dispatch", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=guarded-write"), events.response as never);
    session.updateState({ nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, "guarded-write");
    const context = buildCanvasContext({ nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 });
    try {
        const accepted = session.callTool("canvas_apply_ops", { ops: [], expectedRevision: 0, expectedStateHash: context.stateHash });
        const call = latestToolCall(events.writes());
        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        assert.deepEqual(await accepted, { accepted: true });

        const writeCount = events.writes().length;
        await assert.rejects(
            session.callTool("canvas_apply_ops", { ops: [], expectedRevision: 1 }),
            /revision.*重新读取 canvas_get_context/
        );
        assert.equal(events.writes().length, writeCount);
        await assert.rejects(
            session.callTool("canvas_apply_ops", { ops: [], expectedRevision: 0, expectedStateHash: "bad-hash" }),
            /画布状态已变化.*重新读取 canvas_get_context/
        );
        assert.equal(events.writes().length, writeCount);
    } finally {
        session.dispose();
    }
});

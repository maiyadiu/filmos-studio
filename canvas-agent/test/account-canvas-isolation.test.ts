import assert from "node:assert/strict";
import test from "node:test";
import { accountCanvasFixture } from "./fixtures/account-canvas.js";
import { AGENT_FEATURE_FLAG_IDS } from "../src/brains/feature-flags.js";
import { LocalRuntimeSessionError } from "../src/local-runtime-session.js";

const config = { url: "http://127.0.0.1:41743", token: "fixture", ownerId: "runtime-owner", trustedWebOrigins: ["http://127.0.0.1:3001"], browserRegistrations: [], agentFeatureFlags: Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map(id => [id, true])) };
const failure = (code: string) => (error: unknown) => error instanceof LocalRuntimeSessionError && error.code === code;
const state = (name: string) => ({ projectId: `canvas-${name}`, title: name, nodes: [{ id: "shared-node", type: "text", title: "same-title", position: { x: 0, y: 0 }, width: 320, height: 200, metadata: { content: `private-${name}` } }], connections: [], revision: 0 });

test("unbound or expired identity cannot read private endpoints or publish canvas state", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose());
    for (const path of ["/agent/workspace", "/agent/connections", "/agent/sessions", "/agent/context", "/agent/codex/account", "/agent/diagnostics"]) await assert.rejects(f.invoke(path), failure("agent_account_signed_session_required"));
    const a = await f.bind("user-a");
    f.advance(61_000);
    await assert.rejects(f.invoke("/agent/sessions", { principal: a.principal }), failure("agent_account_binding_required"));
    await assert.rejects(f.invoke("/canvas/state", { body: state("a"), query: { clientId: "a" }, principal: a.principal }), failure("agent_account_binding_required"));
});

test("two users on one Runtime keep separate context, same-named nodes and event streams", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose());
    const a = await f.bind("user-a"), b = await f.bind("user-b");
    const sa = await f.connect(a.principal, "client-a"), sb = await f.connect(b.principal, "client-b");
    for (const [account, clientId, name] of [[a, "client-a", "a"], [b, "client-b", "b"]] as const) {
        await f.invoke("/canvas/state", { body: state(name), query: { clientId }, principal: account.principal });
    }
    for (const [account, name] of [[a, "a"], [b, "b"]] as const) {
        const result = await f.invoke<{ context: { projectId: string } }>("/agent/context", { principal: account.principal });
        assert.equal(result.context.projectId, `canvas-${name}`);
        const node = await f.canvas.withAccountScope(account.binding.accountScopeId, () => f.canvas.callTool("canvas_get_node", { id: "shared-node" }));
        assert.match(JSON.stringify(node), new RegExp(`private-${name}`));
    }
    f.canvas.withAccountScope(a.binding.accountScopeId, () => f.canvas.emitAll("agent_log", { text: "private-event-a" }));
    assert.match(sa.writes.join(""), /private-event-a/); assert.doesNotMatch(sb.writes.join(""), /private-event-a/);
    f.canvas.emitAll("agent_log", { text: "unscoped-secret" });
    assert.doesNotMatch(sa.writes.join("") + sb.writes.join(""), /unscoped-secret/);
    assert.throws(() => f.canvas.agentContextSnapshot(), /CONTEXT_UNAVAILABLE/);
    await assert.rejects(f.invoke("/canvas/state", { body: state("stolen"), query: { clientId: "client-a" }, principal: b.principal }), failure("canvas_client_session_mismatch"));
});

test("a foreign or unclaimed session is invisible on every read and mutation entry, with no side effects", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose());
    const a = await f.bind("user-a"), b = await f.bind("user-b");
    for (const [id, scope] of [["session-a", a.binding.accountScopeId], ["session-b", b.binding.accountScopeId], ["old-unclaimed", undefined]]) {
        await f.store.saveSession({ id: id!, conversationId: id!, brainProfileId: "human.only", connectionId: "human.only", projectId: "same-project", canvasId: "same-canvas", permissionGrantId: "fixture", status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(scope ? { accountScopeId: scope } : {}) });
    }
    const list = await f.invoke<{ sessions: Array<{ id: string }> }>("/agent/sessions", { principal: a.principal });
    assert.deepEqual(list.sessions.map(s => s.id), ["session-a"]);
    for (const id of ["session-b", "old-unclaimed", "missing"]) for (const [path, method] of [["/agent/sessions/:sessionId", "GET"], ["/agent/sessions/:sessionId/history", "GET"], ["/agent/sessions/:sessionId/resume", "POST"], ["/agent/sessions/:sessionId/context", "POST"], ["/agent/sessions/:sessionId/turns", "POST"], ["/agent/sessions/:sessionId/tools", "POST"], ["/agent/sessions/:sessionId/tool-proposals", "POST"], ["/agent/sessions/:sessionId/turns/:turnId/cancel", "POST"], ["/agent/sessions/:sessionId/close", "POST"]] as const) {
        await assert.rejects(f.invoke(path, { method, principal: a.principal, params: { sessionId: id, turnId: "turn" }, body: {} }), failure("agent_account_session_unavailable"));
    }
    for (const path of ["/agent/confirmations/:confirmationId/decision", "/agent/confirmations/:confirmationId/resolve"]) await assert.rejects(f.invoke(path, { principal: a.principal, params: { confirmationId: "foreign" }, body: { sessionId: "session-b", approved: true, actorId: "user-b" } }), failure("agent_account_session_unavailable"));
    assert.equal((await f.store.getSession("old-unclaimed"))?.accountScopeId, undefined);
    assert.equal((await f.store.getSession("session-b"))?.status, "ready");
});

test("Generic mode rejects unscoped legacy provider history and dispatch routes", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose()); const a = await f.bind("user-a");
    for (const path of ["/agent/codex/workspace", "/agent/codex/threads", "/agent/codex/threads/new", "/agent/codex/threads/:threadId", "/agent/codex/threads/:threadId/resume", "/agent/codex/threads/:threadId/delete", "/agent/codex/turn", "/agent/claude/turn"]) {
        const route = f.module.routes.find(item => item.path === path)!;
        await assert.rejects(f.invoke(path, { principal: a.principal, method: route.method as "GET" | "POST", body: {}, params: { threadId: "old-thread" } }), failure("agent_legacy_route_disabled"));
    }
});

test("session creation takes the verified account and active scope, ignoring a browser-supplied identity", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose()); const a = await f.bind("user-a"), b = await f.bind("user-b");
    const sa = await f.connect(a.principal, "client-a");
    await f.invoke("/canvas/state", { principal: a.principal, query: { clientId: "client-a" }, body: state("a") });
    const created = await f.invoke<{ session: { id: string; accountScopeId: string; projectId: string; canvasId: string; workspaceId?: string } }>("/agent/sessions", { principal: a.principal, body: { conversationId: "new-conversation", brainProfileId: "human.only", accountScopeId: b.binding.accountScopeId, actorId: "user-b", projectId: "spoofed", canvasId: "spoofed" } });
    assert.equal(created.session.accountScopeId, a.binding.accountScopeId);
    assert.equal(created.session.workspaceId, undefined); assert.equal(created.session.projectId, "canvas-a"); assert.equal(created.session.canvasId, "canvas-a");
    assert.equal((await f.store.getSession(created.session.id))?.accountScopeId, a.binding.accountScopeId);
    await assert.rejects(f.invoke("/agent/sessions/:sessionId", { principal: b.principal, params: { sessionId: created.session.id } }), failure("agent_account_session_unavailable"));
    const sb = await f.connect(b.principal, "client-b");
    await f.invoke("/canvas/state", { principal: b.principal, query: { clientId: "client-b" }, body: state("b") });
    const turn = await f.invoke<{ result: { status: string } }>("/agent/sessions/:sessionId/turns", { principal: a.principal, params: { sessionId: created.session.id }, body: { turnId: "fixture-turn", prompt: "fixture only" } });
    assert.equal(turn.result.status, "completed");
    assert.match(sa.writes.join(""), /Human Only/); assert.doesNotMatch(sb.writes.join(""), /Human Only/);
});

test("async context is preserved across interleaving accounts and browser results cannot cross ownership", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose()); const a = await f.bind("user-a"), b = await f.bind("user-b");
    const sa = await f.connect(a.principal, "client-a"); await f.connect(b.principal, "client-b");
    for (const [account, name] of [[a, "a"], [b, "b"]] as const) await f.invoke("/canvas/state", { body: state(name), query: { clientId: `client-${name}` }, principal: account.principal });
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const readA = f.canvas.withAccountScope(a.binding.accountScopeId, async () => { await barrier; return f.canvas.agentContextSnapshot(); });
    assert.equal(f.canvas.withAccountScope(b.binding.accountScopeId, () => f.canvas.agentContextSnapshot()).projectId, "canvas-b");
    release(); assert.equal((await readA).projectId, "canvas-a");
    const pending = f.canvas.withAccountScope(a.binding.accountScopeId, () => f.canvas.request({ channel: "model", operation: "probe", profileId: "fixture-only", payload: {} }));
    const chunk = sa.writes.find(value => value.includes("event: browser_runtime_request"))!;
    const { requestId } = JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6));
    await assert.rejects(f.invoke("/canvas/result", { principal: b.principal, query: { clientId: "client-a" }, body: { requestId, result: "forged" } }), failure("canvas_client_session_mismatch"));
    await f.invoke("/canvas/result", { principal: a.principal, query: { clientId: "client-a" }, body: { requestId, result: "owned-result" } });
    assert.equal(await pending, "owned-result");
    f.module.onRuntimeSessionRevoked?.(a.principal.sessionId);
    assert.equal(f.canvas.withAccountScope(b.binding.accountScopeId, () => f.canvas.agentContextSnapshot()).projectId, "canvas-b");
});

test("expired account stops context reads and private events without closing a still-valid account", async t => {
    const f = accountCanvasFixture(config); t.after(() => f.dispose()); const a = await f.bind("user-a");
    const sa = await f.connect(a.principal, "client-a");
    await f.invoke("/canvas/state", { body: state("a"), query: { clientId: "client-a" }, principal: a.principal });
    f.advance(30_000); const b = await f.bind("user-b"); const sb = await f.connect(b.principal, "client-b");
    await f.invoke("/canvas/state", { body: state("b"), query: { clientId: "client-b" }, principal: b.principal });
    f.advance(31_000);
    assert.throws(() => f.canvas.withAccountScope(a.binding.accountScopeId, () => f.canvas.agentContextSnapshot()), /CONTEXT_UNAVAILABLE/);
    f.canvas.withAccountScope(a.binding.accountScopeId, () => f.canvas.emitAll("agent_log", { text: "expired-content" }));
    assert.doesNotMatch(sa.writes.join(""), /expired-content/);
    f.canvas.withAccountScope(b.binding.accountScopeId, () => f.canvas.emitAll("agent_log", { text: "valid-content" }));
    assert.match(sb.writes.join(""), /valid-content/); assert.doesNotMatch(sa.writes.join(""), /valid-content/);
    assert.equal(f.canvas.withAccountScope(b.binding.accountScopeId, () => f.canvas.agentContextSnapshot()).projectId, "canvas-b");
});

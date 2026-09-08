import assert from "node:assert/strict";
import test from "node:test";
import { SourceMaintenanceWorkspace } from "../src/brains/source-maintenance.js";
import { AGENT_FEATURE_FLAG_IDS } from "../src/brains/feature-flags.js";
import { LocalRuntimeSessionError } from "../src/local-runtime-session.js";
import { accountCanvasFixture } from "./fixtures/account-canvas.js";
import { sourceFixture } from "./fixtures/source-maintenance.js";
import { adapter } from "./brain-test-fixtures.js";
import type { BrainSession } from "../src/brains/contracts.js";

const config = { url: "http://127.0.0.1:41743", token: "fixture", ownerId: "runtime-owner", trustedWebOrigins: ["http://127.0.0.1:3001"], browserRegistrations: [], agentFeatureFlags: Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map(id => [id, true])) };
const failure = (code: string) => (error: unknown) => error instanceof LocalRuntimeSessionError && error.code === code;
const routes = [["/agent/source", undefined], ["/agent/source/files", {}], ["/agent/source/read", { path: "README.md" }]] as const;

test("private maintenance lifecycle uses the original owned session and never sends a model task", async t => {
    const source = sourceFixture(t), native = adapter("codex.subscription");
    let turns = 0; const resumed: string[] = [];
    native.sendTurn = async () => { turns++; throw new Error("MODEL_CALL_FORBIDDEN"); };
    native.resumeSession = async input => { resumed.push(input.providerThreadId!); return { providerThreadId: input.providerThreadId }; };
    const f = accountCanvasFixture(config, undefined, { sourceWorkspace: () => source.workspace, codexAdapter: native }); t.after(() => f.dispose());
    const owner = await f.bind("owner", "desktop_local"), foreign = await f.bind("foreign", "desktop_local"), publicUser = await f.bind("ordinary-admin");
    await f.connect(owner.principal, "source-client");
    await f.invoke("/canvas/state", { principal: owner.principal, query: { clientId: "source-client" }, body: { projectId: "canvas", title: "fixture", nodes: [], connections: [], revision: 1 } });
    const { session } = await f.invoke<{ session: BrainSession }>("/agent/sessions", { principal: owner.principal, body: { conversationId: "source-conversation", brainProfileId: "codex.subscription" } });
    const params = { sessionId: session.id };
    const sourceRoutes = [["/agent/sessions/:sessionId/source-task", undefined], ...["open", "close", "reconcile"].map(operation => [`/agent/sessions/:sessionId/source-task/${operation}`, {}] as const)] as const;
    for (const [path, body] of sourceRoutes) {
        await assert.rejects(f.invoke(path, { principal: foreign.principal, params, body }), failure("agent_account_session_unavailable"));
        assert.equal(f.module.routes.find(route => route.path === path)!.legacy, false);
    }
    const publicSession = { ...session, id: "ordinary", conversationId: "ordinary", accountScopeId: publicUser.binding.accountScopeId };
    await f.store.saveSession(publicSession);
    for (const [path, body] of sourceRoutes) await assert.rejects(f.invoke(path, { principal: publicUser.principal, params: { sessionId: publicSession.id }, body }), failure("agent_source_developer_required"));
    const expectedHash = (await source.workspace.read({ path: "web/src/view.ts" })).contentHash;
    const body = { requestId: "source-task", purpose: "Fixture only", files: [{ path: "web/src/view.ts", expectedHash }] };
    for (const extra of [{ cwd: source.root }, { executionProfile: "review_coordinator" }, { sourceTaskId: "forged" }]) await assert.rejects(f.invoke("/agent/sessions/:sessionId/source-task/open", { principal: owner.principal, params, body: { ...body, ...extra } }), failure("agent_source_task_invalid"));
    await f.invoke("/agent/sessions/:sessionId/source-task/open", { principal: owner.principal, params, body });
    const view = await f.invoke<{ source: { live: boolean; record: { status: string } } }>("/agent/sessions/:sessionId/source-task", { principal: owner.principal, params });
    assert.equal(view.source.live, true);
    assert.equal((await f.store.getSession(session.id))!.providerThreadId, session.providerThreadId);
    await assert.rejects(f.invoke("/agent/sessions/:sessionId/source-task/close", { principal: owner.principal, params, body: { files: [] } }), failure("agent_source_task_invalid"));
    await f.invoke("/agent/sessions/:sessionId/source-task/reconcile", { principal: owner.principal, params, body: {} });
    await f.invoke("/agent/sessions/:sessionId/source-task/close", { principal: owner.principal, params, body: {} });
    assert.equal((await f.store.getSession(session.id))!.sourceMaintenance!.status, "closed");
    assert.equal(turns, 0); assert.deepEqual(resumed, [session.providerThreadId, session.providerThreadId]);
    f.advance(61_000);
    for (const [path, body] of sourceRoutes) await assert.rejects(f.invoke(path, { principal: owner.principal, params, body }), failure("agent_account_binding_required"));
});

test("source endpoints require verified desktop identity, never browser self-declared development mode", async t => {
    let calls = 0;
    const f = accountCanvasFixture(config, undefined, { sourceWorkspace: () => { calls++; return undefined; } }); t.after(() => f.dispose());
    for (const [path, body] of routes) await assert.rejects(f.invoke(path, { body }), failure("agent_account_signed_session_required"));
    const account = await f.bind("ordinary-admin");
    for (const [path, body] of routes) await assert.rejects(f.invoke(path, { principal: account.principal, body }), failure("agent_source_developer_required"));
    await assert.rejects(f.invoke("/agent/source/read", { principal: account.principal, body: { path: "README.md", authMode: "desktop_local", developer: true, cwd: "/" } }), failure("agent_source_developer_required"));
    assert.equal(calls, 0);
    for (const [path] of routes) assert.equal(f.module.routes.find(route => route.path === path)?.legacy, false);
});

test("signed source developer can inspect and read bounded code without canvas, provider or write authority", async t => {
    const source = sourceFixture(t), f = accountCanvasFixture(config, undefined, { sourceWorkspace: () => source.workspace }); t.after(() => f.dispose());
    const { principal } = await f.bind("local-developer", "desktop_local");
    const status = await f.invoke<{ result: Awaited<ReturnType<SourceMaintenanceWorkspace["inspect"]>> }>("/agent/source", { principal });
    assert.equal(status.result.trackedClean, true); assert.equal(status.result.mode, "source-read-only");
    assert.deepEqual(status.result.capabilities, { read: true, edit: false, runChecks: false, reload: false });
    assert.doesNotMatch(JSON.stringify(status), new RegExp(source.root));
    const files = await f.invoke<{ result: { paths: string[] } }>("/agent/source/files", { principal, body: { prefix: "web/src/" } });
    assert.deepEqual(files.result.paths, ["web/src/view.ts"]);
    const read = await f.invoke<{ result: { content: string; contentHash: string } }>("/agent/source/read", { principal, body: { path: "README.md" } });
    assert.equal(read.result.content, "fixture-only repository"); assert.match(read.result.contentHash, /^[a-f0-9]{64}$/);
    for (const body of [{ path: "README.md", cwd: source.root }, { path: "README.md", executionProfile: "review_coordinator" }, [], { path: "x".repeat(5000) }]) await assert.rejects(f.invoke("/agent/source/read", { principal, body }), failure("agent_source_request_invalid"));
    await assert.rejects(f.invoke("/agent/source/read", { principal, body: { path: ".git/config" } }), failure("agent_source_path_denied"));
    assert.deepEqual(await f.store.listSessions(), []);
});

test("App/non-source runtime reports unavailable without disrupting ordinary account endpoints", async t => {
    const f = accountCanvasFixture(config, undefined, { sourceWorkspace: () => undefined }); t.after(() => f.dispose());
    const { principal } = await f.bind("local-developer", "desktop_local");
    for (const [path, body] of routes) await assert.rejects(f.invoke(path, { principal, body }), failure("agent_source_unavailable"));
    assert.equal((await f.invoke("/agent/workspace", { principal })).workspaceId, "runtime-owner");
    assert.ok(!f.module.routes.some(route => /^\/agent\/source\/(?:write|patch|run|reload)$/.test(route.path)));
});

test("expiry or revocation while inspecting blocks the response, not just subsequent requests", async t => {
    const source = sourceFixture(t);
    let invalidate = () => {};
    class DelayedWorkspace extends SourceMaintenanceWorkspace {
        override async inspect() { const result = await super.inspect(); invalidate(); return result; }
    }
    const f = accountCanvasFixture(config, undefined, { sourceWorkspace: () => new DelayedWorkspace(source.root) }); t.after(() => f.dispose());
    let account = await f.bind("local-developer", "desktop_local");
    invalidate = () => f.advance(61_000);
    await assert.rejects(f.invoke("/agent/source", { principal: account.principal }), failure("agent_account_binding_required"));
    account = await f.bind("local-developer", "desktop_local");
    invalidate = () => { f.module.onRuntimeSessionRevoked?.(account.principal.sessionId); };
    await assert.rejects(f.invoke("/agent/source", { principal: account.principal }), failure("agent_account_binding_required"));
});

test("source maintenance is not exposed on the legacy unaffiliated runtime", async t => {
    const f = accountCanvasFixture({ ...config, agentFeatureFlags: {} }, undefined, { sourceWorkspace: () => { throw new Error("must not resolve"); } }); t.after(() => f.dispose());
    assert.ok(!f.module.routes.some(route => route.path.startsWith("/agent/source")));
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentConfirmationStore } from "../src/brains/confirmations.js";
import { AgentContextBroker } from "../src/brains/context-broker.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { BrainProfileRegistry } from "../src/brains/registry.js";
import { AgentSessionManager } from "../src/brains/session-manager.js";
import { JsonBrainSessionStore, MemoryBrainSessionStore } from "../src/brains/session-store.js";
import type { AgentEventSink, AgentTurnPlan, NormalizedBrainEvent } from "../src/brains/contracts.js";
import { MemoryAgentAuditSink } from "../src/brains/agent-audit.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";
import { adapter, profile } from "./brain-test-fixtures.js";
import { isProjectPageTool } from "@filmos/agent-contracts";

const accountA = "account_" + "a".repeat(64);
const accountB = "account_" + "b".repeat(64);

test("account ownership survives the original JSON store while legacy records remain unclaimed", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-account-store-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "sessions.json");
    const registry = new BrainProfileRegistry(); registry.registerProfile(profile("codex.mock")); registry.registerAdapter(adapter("codex.mock"));
    const store = new JsonBrainSessionStore(file);
    const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());
    const base = { brainProfileId: "codex.mock", projectId: "same-project", canvasId: "same-canvas", actorId: "fixture" };
    const a = await manager.createSession({ ...base, conversationId: "a", accountScopeId: accountA });
    const b = await manager.createSession({ ...base, conversationId: "b", accountScopeId: accountB });
    const old = await manager.createSession({ ...base, conversationId: "old" });
    assert.equal(a.accountScopeId, accountA);
    assert.equal((await store.getConversation("a"))?.accountScopeId, accountA);
    assert.equal((await manager.resumeSession(a.id, "fixture")).accountScopeId, accountA);
    const reopened = new JsonBrainSessionStore(file);
    assert.deepEqual((await reopened.listSessions({ projectId: base.projectId, accountScopeId: accountA })).map(s => s.id), [a.id]);
    assert.deepEqual((await reopened.listSessions({ projectId: base.projectId, accountScopeId: accountB })).map(s => s.id), [b.id]);
    assert.deepEqual(await reopened.getSession(old.id), old);
    assert.equal((await reopened.getConversation("old"))?.accountScopeId, undefined);
    await assert.rejects(reopened.saveSession({ ...old, accountScopeId: accountA }), /immutable/);
    await assert.rejects(reopened.listSessions({ accountScopeId: "" }), /ACCOUNT_SCOPE_INVALID/);
    const read = await reopened.getSession(a.id); read!.accountScopeId = accountB;
    assert.equal((await reopened.getSession(a.id))?.accountScopeId, accountA);
});

test("session and conversation ownership cannot be overwritten, patched, imported or cross-linked", async () => {
    const registry = new BrainProfileRegistry(); registry.registerProfile(profile("codex.mock")); registry.registerAdapter(adapter("codex.mock"));
    const store = new MemoryBrainSessionStore();
    const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());
    const base = { brainProfileId: "codex.mock", projectId: "same-project", canvasId: "same-canvas", actorId: "fixture" };
    const a = await manager.createSession({ ...base, conversationId: "a", accountScopeId: accountA });
    const b = await manager.createSession({ ...base, conversationId: "b", accountScopeId: accountB });
    for (const patch of [{ accountScopeId: accountB }, { accountScopeId: undefined }, { id: b.id }, { conversationId: "b" }]) {
        await assert.rejects(store.saveSession({ ...a, ...patch }), /immutable|ACCOUNT_MISMATCH/);
        await assert.rejects(store.updateSession(a.id, patch as never), /immutable/);
        assert.throws(() => store.importSnapshot({ sessions: [{ ...a, ...patch }], conversations: [] }), /immutable|ACCOUNT_MISMATCH/);
    }
    const conversation = (await store.getConversation("a"))!;
    await assert.rejects(store.saveConversation({ ...conversation, accountScopeId: accountB }), /ACCOUNT_MISMATCH/);
    await assert.rejects(store.saveConversation({ ...conversation, sessionIds: [a.id, b.id] }), /ACCOUNT_MISMATCH/);
    assert.throws(() => store.importSnapshot({ sessions: [], conversations: [{ ...conversation, accountScopeId: accountB }] }), /ACCOUNT_MISMATCH/);
    assert.deepEqual(await store.getSession(a.id), a);
    assert.deepEqual(await store.getConversation("a"), conversation);
});

test("adapter patches cannot erase or substitute the Runtime account on create or resume", async () => {
    for (const value of [undefined, accountB]) {
        const registry = new BrainProfileRegistry(); registry.registerProfile(profile("codex.mock"));
        registry.registerAdapter({ ...adapter("codex.mock"), createSession: async () => ({ accountScopeId: value }), resumeSession: async () => ({ accountScopeId: value }) });
        const store = new MemoryBrainSessionStore();
        const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());
        const input = { conversationId: "a", brainProfileId: "codex.mock", projectId: "p", canvasId: "x", actorId: "fixture", accountScopeId: accountA };
        await assert.rejects(manager.createSession(input), /immutable session field: accountScopeId/);
        const failed = (await store.listSessions({ accountScopeId: accountA }))[0];
        assert.equal(failed.status, "failed"); assert.equal(failed.accountScopeId, accountA);
        await assert.rejects(manager.resumeSession(failed.id, "fixture"), /immutable session field: accountScopeId/);
        assert.equal((await store.getSession(failed.id))?.accountScopeId, accountA);
    }
});

test("concurrent account claims on one conversation reject before the second provider call and revoke its grant", async () => {
    const registry = new BrainProfileRegistry(); registry.registerProfile(profile("codex.mock"));
    const calls: string[] = []; registry.registerAdapter(adapter("codex.mock", calls));
    const store = new MemoryBrainSessionStore(), grants = new AgentPermissionGrantStore();
    const issued: string[] = [], issue = grants.issue.bind(grants);
    grants.issue = input => { const grant = issue(input); issued.push(grant.id); return grant; };
    const manager = new AgentSessionManager(registry, store, grants, new AgentConfirmationStore(), new AgentContextBroker());
    const base = { conversationId: "same", brainProfileId: "codex.mock", projectId: "p", canvasId: "x", actorId: "fixture" };
    const results = await Promise.allSettled([accountA, accountB].map(accountScopeId => manager.createSession({ ...base, accountScopeId })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    assert.equal(calls.length, 1);
    assert.equal((await store.listSessions()).length, 1);
    assert.equal(issued.filter(id => grants.get(id)).length, 1);
    await assert.rejects(manager.createSession({ ...base, accountScopeId: "caller-picked-user" }), /ACCOUNT_SCOPE_INVALID/);
    assert.equal(calls.length, 1);
});

test("project page create and restart resume keep the same project scope and never gain canvas tools", async () => {
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    const calls: string[] = [];
    registry.registerAdapter(adapter("codex.mock", calls));
    const store = new MemoryBrainSessionStore();
    const grants = new AgentPermissionGrantStore();
    const manager = new AgentSessionManager(registry, store, grants, new AgentConfirmationStore(), new AgentContextBroker());
    const input = { conversationId: "project-conversation", brainProfileId: "codex.mock", projectId: "business-1", domainProjectId: "business-1", canvasId: null, contentUnitId: "unit-1", actorId: "owner" };
    await assert.rejects(manager.createSession({ ...input, domainProjectId: "other" }), /DOMAIN_PROJECT_MISMATCH/);
    assert.deepEqual(calls, []);
    const created = await manager.createSession(input);
    const before = grants.get(created.permissionGrantId)!;
    assert.equal(created.canvasId, null);
    assert.equal(before.allowedTools.length, 19);
    assert.ok(before.allowedTools.every(isProjectPageTool));
    assert.ok(before.allowedTools.includes("project_create_or_update_shots"));
    assert.ok(!before.allowedTools.includes("project_sync_storyboard"));
    assert.equal((await store.getConversation(input.conversationId))?.canvasId, null);
    const resumed = await manager.resumeSession(created.id, "owner");
    assert.equal(resumed.providerThreadId, created.providerThreadId);
    assert.equal(resumed.canvasId, null);
    assert.equal(resumed.domainProjectId, "business-1");
    assert.equal(resumed.contentUnitId, "unit-1");
    assert.deepEqual(grants.get(resumed.permissionGrantId)?.allowedTools, before.allowedTools);
    assert.throws(() => grants.validate(before.id, { sessionId: created.id, projectId: "business-1", connectionId: "codex.mock" }), /AGENT_GRANT_NOT_FOUND/);
});

test("an adapter cannot erase a bound project or chapter with an explicit undefined patch", async () => {
    for (const key of ["domainProjectId", "contentUnitId"]) {
        const registry = new BrainProfileRegistry();
        registry.registerProfile(profile("codex.mock"));
        registry.registerAdapter({ ...adapter("codex.mock"), createSession: async () => ({ providerThreadId: "mock", [key]: undefined }) });
        const store = new MemoryBrainSessionStore();
        const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());
        await assert.rejects(manager.createSession({ conversationId: "project-scope", brainProfileId: "codex.mock", projectId: "business-1", domainProjectId: "business-1", canvasId: null, contentUnitId: "unit-1", actorId: "owner" }), new RegExp(`immutable session field: ${key}`));
        const failed = (await store.listSessions({ projectId: "business-1" }))[0];
        assert.equal(failed.status, "failed");
        assert.equal(failed.domainProjectId, "business-1");
        assert.equal(failed.contentUnitId, "unit-1");
    }
});

test("mock Codex, API and Hosted adapters create isolated sessions in one registry", async () => {
    const calls: string[] = [];
    const registry = new BrainProfileRegistry();
    const ids = ["codex.mock", "api.mock", "hosted.mock"] as const;
    registry.registerProfile(profile(ids[0], "openai.codex"));
    registry.registerProfile(profile(ids[1], "openai.gpt"));
    registry.registerProfile(profile(ids[2], "openai.chatgpt"));
    for (const id of ids) registry.registerAdapter(adapter(id, calls));
    const store = new MemoryBrainSessionStore();
    const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());

    const sessions = await Promise.all(ids.map((brainProfileId, index) => manager.createSession({
        conversationId: `conversation-${index}`,
        brainProfileId,
        projectId: `project-${index}`,
        canvasId: `canvas-${index}`,
        actorId: "actor-1",
    })));

    assert.equal(new Set(sessions.map((session) => session.id)).size, 3);
    assert.deepEqual(sessions.map((session) => session.providerThreadId), [
        "codex.mock-thread-project-0",
        "api.mock-thread-project-1",
        "hosted.mock-thread-project-2",
    ]);
    assert.deepEqual(calls, [
        "create:codex.mock:project-0:canvas-0",
        "create:api.mock:project-1:canvas-1",
        "create:hosted.mock:project-2:canvas-2",
    ]);
    assert.equal((await store.listSessions({ projectId: "project-0" }))[0]?.brainProfileId, "codex.mock");
});

test("a failed subscription probe never invokes an API adapter", async () => {
    const apiCalls: string[] = [];
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    registry.registerProfile(profile("api.mock", "openai.gpt"));
    registry.registerAdapter({
        ...adapter("codex.mock"),
        probe: async () => ({ profileId: "codex.mock", status: "needs_auth", statusReason: "not logged in", checkedAt: new Date(0).toISOString() }),
    });
    registry.registerAdapter(adapter("api.mock", apiCalls));
    const manager = new AgentSessionManager(registry, new MemoryBrainSessionStore(), new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());

    await assert.rejects(() => manager.createSession({ conversationId: "c", brainProfileId: "codex.mock", projectId: "p", canvasId: "x", actorId: "a" }), /NEEDS_AUTH/);
    assert.deepEqual(apiCalls, []);
});

test("session grants come from the canonical manifest and every turn records profile transport and billing", async () => {
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    registry.registerAdapter(adapter("codex.mock"));
    const grants = new AgentPermissionGrantStore();
    const audit = new MemoryAgentAuditSink();
    const manager = new AgentSessionManager(
        registry,
        new MemoryBrainSessionStore(),
        grants,
        new AgentConfirmationStore(),
        new AgentContextBroker(),
        () => new Date("2026-08-29T00:00:00.000Z"),
        new CanonicalAgentToolManifest(),
        audit,
    );
    const session = await manager.createSession({ conversationId: "conversation", brainProfileId: "codex.mock", projectId: "project", canvasId: "canvas", actorId: "actor" });
    const grant = grants.get(session.permissionGrantId);
    assert.equal(grant?.allowedTools.includes("workbench_get_context"), true);
    assert.equal(grant?.allowedTools.includes("film_command_apply"), true);
    await manager.bindContextReceipt(session.id, "receipt-1");
    await manager.sendTurn(session.id, { turnId: "turn-1", prompt: "read", context: { contextReceiptId: "receipt-1" } as never }, async () => undefined);
    assert.deepEqual(audit.records.map((record) => ({ outcome: record.outcome, profile: record.profileId, transport: record.transport, billing: record.billingMode, tool: record.toolName })), [
        { outcome: "proposed", profile: "codex.mock", transport: "codex_app_server", billing: "subscription", tool: "__brain_turn__" },
        { outcome: "succeeded", profile: "codex.mock", transport: "codex_app_server", billing: "subscription", tool: "__brain_turn__" },
    ]);
});

test("restart resume reissues a scoped grant and preserves the provider thread", async () => {
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    let resumeInput: Record<string, unknown> | undefined;
    registry.registerAdapter({
        ...adapter("codex.mock"),
        resumeSession: async (input) => {
            resumeInput = input as unknown as Record<string, unknown>;
            return { providerThreadId: input.providerThreadId };
        },
    });
    const store = new MemoryBrainSessionStore();
    await store.saveSession({
        id: "session-restart",
        conversationId: "conversation-restart",
        brainProfileId: "codex.mock",
        connectionId: "codex.mock",
        projectId: "project-restart",
        canvasId: "canvas-restart",
        providerThreadId: "thread-preserved",
        permissionGrantId: "expired-grant",
        status: "interrupted",
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
    });
    const grants = new AgentPermissionGrantStore();
    const manager = new AgentSessionManager(registry, store, grants, new AgentConfirmationStore(), new AgentContextBroker());
    const resumed = await manager.resumeSession("session-restart", "trusted-owner");

    assert.equal(resumed.status, "ready");
    assert.equal(resumed.providerThreadId, "thread-preserved");
    assert.notEqual(resumed.permissionGrantId, "expired-grant");
    assert.equal((resumeInput?.grant as { actorId?: string } | undefined)?.actorId, "trusted-owner");
    assert.equal(resumeInput?.canvasId, "canvas-restart");
    assert.equal(grants.get(resumed.permissionGrantId)?.allowedTools.includes("film_command_apply"), true);
});

test("provider progress is persisted in the existing session, scope checked, reset per turn and retained on interruption", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-plan-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "sessions.json");
    const store = new JsonBrainSessionStore(file);
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    let late: AgentEventSink | undefined;
    let firstEvent: Extract<NormalizedBrainEvent, { type: "turn.plan.updated" }> | undefined;
    registry.registerAdapter({ ...adapter("codex.mock"), sendTurn: async (input, sink) => {
        assert.equal((await store.getSession(input.session.id))?.latestPlan, null);
        const plan: AgentTurnPlan = { source: "provider", turnId: input.turnId, steps: [{ step: "只核验当前章节", status: "inProgress" }], updatedAt: new Date().toISOString() };
        const event = { type: "turn.plan.updated" as const, sessionId: input.session.id, turnId: input.turnId, plan, at: plan.updatedAt };
        if (!late) { late = sink; firstEvent = structuredClone(event); }
        void sink({ ...event, sessionId: "foreign-session" });
        void sink({ ...event, turnId: "foreign-turn" });
        void sink(event);
        plan.steps[0].step = "mutation after emission must not alter snapshot";
        if (input.turnId === "interrupt") throw new Error("AGENT_TURN_CANCELLED");
        return { sessionId: input.session.id, turnId: input.turnId, status: "completed" };
    } });
    const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());
    const session = await manager.createSession({ conversationId: "c", brainProfileId: "codex.mock", projectId: "p", canvasId: "x", actorId: "a" });
    await manager.bindContextReceipt(session.id, "receipt");
    const input = { turnId: "first", prompt: "测试", context: { contextReceiptId: "receipt" } as never };
    const received: NormalizedBrainEvent[] = [];
    await manager.sendTurn(session.id, input, async event => { received.push(event); });
    assert.equal(received.length, 1);
    assert.equal((await store.getSession(session.id))?.latestPlan?.steps[0].step, "只核验当前章节");
    const reopened = new JsonBrainSessionStore(file);
    assert.deepEqual((await reopened.getSession(session.id))?.latestPlan, (await store.getSession(session.id))?.latestPlan);
    await assert.rejects(manager.sendTurn(session.id, { ...input, turnId: "interrupt" }, async () => undefined), /AGENT_TURN_CANCELLED/);
    await late!(firstEvent!);
    const interrupted = await store.getSession(session.id);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(interrupted?.latestPlan?.turnId, "interrupt");
    assert.equal(interrupted?.latestPlan?.steps[0].status, "inProgress");
    const resumed = await manager.resumeSession(session.id, "a");
    assert.deepEqual(resumed.latestPlan, interrupted?.latestPlan);
});

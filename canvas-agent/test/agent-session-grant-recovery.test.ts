import assert from "node:assert/strict";
import test from "node:test";

import type { LocalRuntimeConfig } from "../src/config.js";
import type { BrowserRuntimeRequest, BrowserRuntimeTransport } from "../src/brains/browser-runtime-port.js";
import { resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { GenericAgentRuntime } from "../src/brains/generic-agent-runtime.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import type { WorkbenchContextSnapshot } from "../src/brains/context-broker.js";
import type { CanonicalCanvasToolExecutor } from "../src/brains/tool-providers.js";
import { codexProcessManager } from "../src/agents.js";

test("global native turn and recovery bind only the current workspace before calling a provider", async t => {
    t.mock.method(codexProcessManager, "client", async () => { throw new Error("LIVE_CODEX_PROCESS_FORBIDDEN"); });
    t.mock.method(codexProcessManager, "probe", async () => { throw new Error("LIVE_CODEX_PROBE_FORBIDDEN"); });
    let snapshot: WorkbenchContextSnapshot = { projectId: null, workspaceId: "owner-grant-recovery", canvasId: null, activePanel: "settings", canvasRevision: 1, canvasStateHash: "global-page", nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
    const instance = runtime(new MemoryBrainSessionStore(), new AgentPermissionGrantStore(), { hasConnectedBrowser: () => true, request: async () => { throw new Error("MODEL_API_FORBIDDEN"); } }, () => snapshot, { callTool: async () => { throw new Error("BUSINESS_TOOL_FORBIDDEN"); } });
    const adapter = instance.registry.getAdapter("codex.subscription");
    let creates = 0, resumes = 0, turns = 0;
    adapter.probe = async () => ({ profileId: "codex.subscription", status: "ready", checkedAt: new Date().toISOString() });
    adapter.createSession = async () => { creates++; return { providerThreadId: "global-fixture-thread" }; };
    adapter.resumeSession = async input => { resumes++; return { providerThreadId: input.providerThreadId }; };
    adapter.readHistory = async () => [];
    try {
        const { session } = await instance.createSession({ conversationId: "global-conversation", brainProfileId: "codex.subscription", projectId: null, canvasId: null, workspaceId: snapshot.workspaceId, actorId: "owner-grant-recovery" });
        adapter.sendTurn = async input => {
            turns++;
            assert.equal(input.context.project.id, null);
            assert.equal(input.context.route.workspaceId, snapshot.workspaceId);
            const read = await instance.proposeTool({ sessionId: session.id, toolName: "workbench_get_context", toolInput: {} });
            assert.equal(read.status, "completed");
            if (read.status === "completed") assert.equal((read.result.output as WorkbenchContextSnapshot).activePanel, "settings");
            await assert.rejects(instance.proposeTool({ sessionId: session.id, toolName: "project_get_script", toolInput: { projectId: "old", unitId: "old" } }), /REQUIRES_PROJECT_CONTEXT/);
            return { sessionId: session.id, turnId: input.turnId, status: "completed", text: "fixture" };
        };
        await instance.sendTurn(session.id, { turnId: "global-fixture-turn", prompt: "fixture" }, () => undefined);
        const resumed = await instance.resumeSession(session.id, "owner-grant-recovery");
        assert.equal(resumed.session.providerThreadId, session.providerThreadId);
        snapshot = { ...snapshot, workspaceId: "other-workspace" };
        await assert.rejects(instance.resumeSession(session.id, "owner-grant-recovery"), /SCOPE_MISMATCH/);
        await assert.rejects(instance.sendTurn(session.id, { turnId: "blocked-turn", prompt: "fixture" }, () => undefined), /SCOPE_MISMATCH/);
        assert.deepEqual({ creates, resumes, turns }, { creates: 1, resumes: 1, turns: 1 });
    } finally { await instance.dispose(); }
});

test("native Codex project-page turn reuses canonical project tools and stops after a page scope switch", async () => {
    let snapshot: WorkbenchContextSnapshot = { projectId: "business-1", domainProjectId: "business-1", canvasId: null, contentUnitId: "unit-1", activePanel: "chapters", canvasRevision: 1, canvasStateHash: "project-page", nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
    const calls: string[] = [];
    const instance = runtime(new MemoryBrainSessionStore(), new AgentPermissionGrantStore(), { hasConnectedBrowser: () => true, request: async () => { throw new Error("MODEL_API_FORBIDDEN"); } }, () => snapshot, { callTool: async name => { calls.push(String(name)); return { projectId: "business-1", unitId: "unit-1", sourceText: "<p>fixture</p>" }; } });
    const adapter = instance.registry.getAdapter("codex.subscription");
    adapter.probe = async () => ({ profileId: "codex.subscription", status: "ready", checkedAt: new Date().toISOString() });
    adapter.createSession = async () => ({ providerThreadId: "project-fixture-thread" });
    try {
        const { session } = await instance.createSession({ conversationId: "project-page-conversation", brainProfileId: "codex.subscription", projectId: snapshot.projectId, domainProjectId: snapshot.domainProjectId, canvasId: null, contentUnitId: "unit-1", actorId: "owner-grant-recovery" });
        adapter.sendTurn = async input => {
            assert.equal(input.context.canvas.id, null);
            assert.equal(input.context.route.unitId, "unit-1");
            const proposal = { sessionId: session.id, toolName: "project_get_script", toolInput: { unitId: "unit-1" } };
            assert.equal((await instance.proposeTool(proposal)).status, "completed");
            for (const toolName of ["canvas_get_state", "project_sync_storyboard", "film_command_apply"]) {
                await assert.rejects(instance.proposeTool({ ...proposal, toolName, toolInput: {} }), /AGENT_TOOL_REQUIRES_CANVAS_CONTEXT/);
            }
            const write = await instance.proposeTool({ ...proposal, toolName: "project_revise_script", toolInput: { unitId: "unit-1", expectedRevision: 1, requestId: "revise-fixture", note: "fixture", edits: [{ oldText: "fixture", newText: "revised" }] } });
            assert.equal(write.status, "confirmation_required");
            if (write.status !== "confirmation_required") throw new Error("write requires confirmation");
            await instance.decideConfirmation({ confirmationId: write.confirmation.id, sessionId: session.id, actorId: "owner-grant-recovery", approved: false });
            snapshot = { ...snapshot, blockers: ["未保存草稿"], canvasRevision: 2, canvasStateHash: "dirty-project-page" };
            assert.equal((await instance.proposeTool({ ...proposal, toolName: "workbench_get_context", toolInput: {} })).status, "completed");
            assert.equal((await instance.proposeTool(proposal)).status, "completed");
            await assert.rejects(instance.proposeTool({ ...proposal, toolName: "project_revise_script", toolInput: { unitId: "unit-1", expectedRevision: 1, requestId: "dirty-fixture", note: "fixture", edits: [{ oldText: "fixture", newText: "revised" }] } }), /AGENT_PROJECT_PAGE_WRITE_BLOCKED/);
            snapshot = { ...snapshot, projectId: "business-2", domainProjectId: "business-2", canvasRevision: 2, canvasStateHash: "other-project" };
            await assert.rejects(instance.proposeTool(proposal), /AGENT_CONTEXT_SCOPE_MISMATCH/);
            await assert.rejects(instance.proposeTool({ ...proposal, toolName: "workbench_get_context", toolInput: {} }), /AGENT_CONTEXT_SCOPE_MISMATCH/);
            return { sessionId: session.id, turnId: input.turnId, status: "completed", text: "fixture" };
        };
        await instance.sendTurn(session.id, { turnId: "project-page-turn", prompt: "fixture" }, () => undefined);
        assert.deepEqual(calls, ["project_get_script", "project_get_script"]);
    } finally { await instance.dispose(); }
});

test("one-click script scope authorizes only verified new units in its active Codex turn and expires on success or cancel", async () => {
    const store = new MemoryBrainSessionStore();
    const snapshot: WorkbenchContextSnapshot = { projectId: "project-grant-recovery", canvasId: "canvas-grant-recovery", domainProjectId: "domain-script", canvasRevision: 1, canvasStateHash: "a".repeat(64), nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
    const calls: string[] = [];
    const instance = runtime(store, new AgentPermissionGrantStore(), { hasConnectedBrowser: () => true, request: async () => { throw new Error("MODEL_API_FORBIDDEN"); } }, () => snapshot, {
        callTool: async name => {
            calls.push(String(name));
            return { ok: true, data: { receipt: { projectId: "domain-script", requestId: "script-fixture", unitIds: ["new-a", "new-b"] }, verification: { ok: true, persisted: true, matchesCurrent: true } } };
        },
    });
    const adapter = instance.registry.getAdapter("codex.subscription");
    adapter.probe = async () => ({ profileId: "codex.subscription", status: "ready", checkedAt: new Date().toISOString() });
    adapter.createSession = async () => ({ providerThreadId: "fixture-only" });
    let release!: () => void;
    adapter.cancelTurn = async () => { release?.(); };
    try {
        const { session } = await instance.createSession({ conversationId: "script-scope", brainProfileId: "codex.subscription", projectId: snapshot.projectId, canvasId: snapshot.canvasId, domainProjectId: snapshot.domainProjectId, actorId: "owner-grant-recovery" });
        const create = { sessionId: session.id, toolName: "project_create_script", toolInput: { requestId: "script-fixture", expectedProjectRevision: 1, note: "fixture", chapters: [{ title: "a", sourceText: "<p>a</p>" }, { title: "b", sourceText: "<p>b</p>" }] } };
        const revise = { sessionId: session.id, toolName: "project_revise_script", toolInput: { unitId: "new-a", expectedRevision: 1, requestId: "revise-fixture", note: "fixture", edits: [{ oldText: "a", newText: "a2" }] } };
        adapter.sendTurn = async input => {
            assert.equal((await instance.proposeTool(revise)).status, "confirmation_required");
            assert.equal((await instance.proposeTool(create)).status, "completed");
            assert.equal((await instance.proposeTool(revise)).status, "completed");
            assert.equal((await instance.proposeTool({ ...revise, toolInput: { ...revise.toolInput, unitId: "old-unit" }, ordinaryConfirmationEnabled: false })).status, "confirmation_required");
            assert.equal((await instance.proposeTool({ ...revise, toolInput: { ...revise.toolInput, expectedRevision: 2 } })).status, "confirmation_required");
            await assert.rejects(instance.proposeTool({ ...create, turnId: "other-turn" }), /TURN_MISMATCH/);
            return { sessionId: session.id, turnId: input.turnId, status: "completed", text: "fixture" };
        };
        const scriptCreation = { requestId: "script-fixture", chapterCount: 2, polishRounds: 1 };
        await instance.sendTurn(session.id, { turnId: "create-turn", prompt: "fixture", scriptCreation }, () => undefined);
        assert.deepEqual(calls, ["project_create_script", "project_revise_script"]);
        assert.equal((await instance.proposeTool({ ...revise, turnId: "later-proposal" })).status, "confirmation_required");
        let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
        adapter.sendTurn = async input => { await new Promise<void>(resolve => { release = resolve; began(); }); return { sessionId: session.id, turnId: input.turnId, status: "completed", text: "fixture" }; };
        const cancelled = assert.rejects(instance.sendTurn(session.id, { turnId: "cancel-scope", prompt: "fixture", scriptCreation }, () => undefined), /TURN_CANCELLED/);
        await started;
        await instance.cancelTurn(session.id, "cancel-scope"); await cancelled;
        assert.equal((await instance.proposeTool({ ...create, turnId: "after-cancel" })).status, "confirmation_required");
    } finally { release?.(); await instance.dispose(); }
});

test("generic runtime rotates a missing grant for a hydrated and a persisted session", async () => {
    const requests: BrowserRuntimeRequest[] = [];
    const transport: BrowserRuntimeTransport = {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => {
            requests.push(input);
            if (input.operation === "probe") return { status: "ready" } as T;
            if (input.operation === "create_session" || input.operation === "resume_session") {
                return { providerThreadId: `local:${input.sessionId}` } as T;
            }
            if (input.operation === "send_turn") {
                return {
                    result: {
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        providerThreadId: `local:${input.sessionId}`,
                        text: "ok",
                        status: "completed",
                    },
                } as T;
            }
            return { ok: true } as T;
        },
    };
    const store = new MemoryBrainSessionStore();
    const grants = new AgentPermissionGrantStore();
    const first = runtime(store, grants, transport);
    let sessionId = "";
    try {
        const created = await first.createSession({
            conversationId: "grant-recovery",
            brainProfileId: "local.model",
            projectId: "project-grant-recovery",
            canvasId: "canvas-grant-recovery",
            actorId: "owner-grant-recovery",
        });
        sessionId = created.session.id;
        assert.equal(grants.revoke(created.session.permissionGrantId), true);
        const recovered = await first.sendTurn(sessionId, { turnId: "turn-hydrated", prompt: "recover hydrated" }, () => undefined);
        assert.equal(recovered.result.status, "completed");
        assert.notEqual(recovered.session?.permissionGrantId, created.session.permissionGrantId);
        assert.equal(requests.filter((item) => item.operation === "resume_session").length, 1);
    } finally {
        await first.dispose();
    }

    const restarted = runtime(store, new AgentPermissionGrantStore(), transport);
    try {
        const recovered = await restarted.sendTurn(sessionId, { turnId: "turn-restart", prompt: "recover persisted" }, () => undefined);
        assert.equal(recovered.result.status, "completed");
        assert.equal(requests.filter((item) => item.operation === "resume_session").length, 2);
    } finally {
        await restarted.dispose();
    }
});

test("cancel targets exactly one active turn, invalidates pending writes, and permits a fresh continuation", async () => {
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const transport: BrowserRuntimeTransport = {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => {
            if (input.operation === "probe") return { status: "ready" } as T;
            if (["create_session", "resume_session"].includes(input.operation)) return { providerThreadId: `local:${input.sessionId}` } as T;
            if (input.operation === "cancel_turn") release?.();
            if (input.operation === "send_turn") {
                if (input.turnId === "cancel-me") await new Promise<void>(resolve => { release = resolve; began(); });
                return { result: { sessionId: input.sessionId, turnId: input.turnId, text: "fixture result", status: "completed" } } as T;
            }
            return { ok: true } as T;
        },
    };
    const store = new MemoryBrainSessionStore();
    const instance = runtime(store, new AgentPermissionGrantStore(), transport);
    try {
        const { session } = await instance.createSession({ conversationId: "cancel", brainProfileId: "local.model", projectId: "project-grant-recovery", canvasId: "canvas-grant-recovery", actorId: "owner-grant-recovery" });
        const turn = instance.sendTurn(session.id, { turnId: "cancel-me", prompt: "fixture" }, () => undefined);
        const cancelled = assert.rejects(turn, /AGENT_TURN_CANCELLED/);
        await started;
        assert.equal(instance.sessionView((await store.getSession(session.id))!).execution.activeTurnId, "cancel-me");
        const grantBeforeRead = (await store.getSession(session.id))!.permissionGrantId;
        const adapter = instance.registry.getAdapter("local.model");
        adapter.readHistory = async current => [{ id: "native-item", role: "assistant", text: "still working", source: "provider" }];
        const observed = await instance.readSessionHistory(session.id);
        assert.equal(observed.session.execution.activeTurnId, "cancel-me");
        assert.equal(observed.session.permissionGrantId, grantBeforeRead);
        assert.equal(observed.history[0].id, "native-item");
        await assert.rejects(instance.resumeSession(session.id, "owner-grant-recovery"), /ALREADY_RUNNING/);
        await assert.rejects(instance.cancelTurn(session.id, "wrong-turn"), /AGENT_ACTIVE_TURN_MISMATCH/);
        await assert.rejects(instance.sendTurn(session.id, { turnId: "parallel", prompt: "fixture" }, () => undefined), /ALREADY_RUNNING/);
        const request = { sessionId: session.id, turnId: "cancel-me", toolName: "project_revise_script", toolInput: { unitId: "unit", expectedRevision: 1, requestId: "cancel-save", note: "test", edits: [{ oldText: "old", newText: "new" }] } };
        const proposal = await instance.proposeTool(request);
        assert.equal(proposal.status, "confirmation_required");
        const pendingView = instance.sessionView((await store.getSession(session.id))!).execution;
        assert.equal(pendingView.pendingConfirmations.length, 1);
        pendingView.pendingConfirmations[0].summary = "must not mutate stored confirmation";
        assert.notEqual(instance.confirmations.pendingForSession(session.id)[0].summary, pendingView.pendingConfirmations[0].summary);
        assert.equal(instance.confirmations.pendingForSession("other-session").length, 0);
        const waiting = assert.rejects(instance.requestTool(request), /AGENT_TURN_CANCELLED/);
        await new Promise(resolve => setImmediate(resolve));
        await instance.cancelTurn(session.id, "cancel-me");
        await Promise.all([cancelled, waiting]);
        assert.deepEqual(instance.sessionView((await store.getSession(session.id))!).execution, { activeTurnId: null, resuming: false, pendingConfirmations: [] });
        if (proposal.status === "confirmation_required") {
            assert.equal(instance.confirmations.get(proposal.confirmation.id)?.status, "cancelled");
            await assert.rejects(instance.decideConfirmation({ confirmationId: proposal.confirmation.id, sessionId: session.id, actorId: "owner-grant-recovery", approved: true }), /cancelled/);
        }
        await assert.rejects(instance.proposeTool({ ...request, ordinaryConfirmationEnabled: false }), /AGENT_TURN_CANCELLED/);
        assert.equal((await store.getSession(session.id))?.status, "interrupted");
        const continued = await instance.sendTurn(session.id, { turnId: "fresh-turn", prompt: "read back before continuing" }, () => undefined);
        assert.equal(continued.result.status, "completed");
        // A stale persisted status is not a live turn after interruption/restart.
        await store.updateSession(session.id, { status: "running", updatedAt: new Date().toISOString() });
        assert.equal(instance.sessionView((await store.getSession(session.id))!).execution.activeTurnId, null);
    } finally {
        release?.();
        await instance.dispose();
    }
});

test("standalone confirmation never invents a running turn or fails after creating its receipt", async () => {
    const store = new MemoryBrainSessionStore();
    const instance = runtime(store, new AgentPermissionGrantStore(), {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => (input.operation === "probe" ? { status: "ready" } : { providerThreadId: "local:standalone" }) as T,
    });
    try {
        const { session } = await instance.createSession({ conversationId: "standalone", brainProfileId: "local.model", projectId: "project-grant-recovery", canvasId: "canvas-grant-recovery", actorId: "owner-grant-recovery" });
        const outcome = await instance.proposeTool({ sessionId: session.id, turnId: "explicit-proposal", toolName: "project_revise_script", toolInput: { unitId: "unit", expectedRevision: 1, requestId: "standalone-write", note: "test", edits: [{ oldText: "old", newText: "new" }] } });
        assert.equal(outcome.status, "confirmation_required");
        if (outcome.status !== "confirmation_required") throw Error("missing confirmation");
        assert.equal((await store.getSession(session.id))?.status, "ready");
        assert.equal(instance.sessionView(session).execution.activeTurnId, null);
        assert.equal(instance.sessionView(session).execution.pendingConfirmations.length, 1);
        await instance.decideConfirmation({ confirmationId: outcome.confirmation.id, sessionId: session.id, actorId: "owner-grant-recovery", approved: false });
        assert.equal((await store.getSession(session.id))?.status, "ready");
        assert.equal(instance.sessionView(session).execution.pendingConfirmations.length, 0);
    } finally { await instance.dispose(); }
});

test("explicit context read renews expired receipts without bypassing stale writes, approvals or scope", async () => {
    let snapshot: WorkbenchContextSnapshot = { projectId: "project-grant-recovery", canvasId: "canvas-grant-recovery", canvasRevision: 1, canvasStateHash: "a".repeat(64), nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
    const store = new MemoryBrainSessionStore();
    const grants = new AgentPermissionGrantStore();
    const instance = runtime(store, grants, {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => (input.operation === "probe" ? { status: "ready" } : { providerThreadId: "local:refresh" }) as T,
    }, () => snapshot);
    try {
        const { session } = await instance.createSession({ conversationId: "context-refresh", brainProfileId: "local.model", projectId: snapshot.projectId, canvasId: snapshot.canvasId, actorId: "owner-grant-recovery" });
        const expired = instance.contexts.capture(session, snapshot, 0).receipt;
        await instance.manager.bindContextReceipt(session.id, expired.receiptId);
        const request = { sessionId: session.id, turnId: "context-test", toolName: "project_get_shots", toolInput: { unitId: "unit" } };
        await assert.rejects(instance.proposeTool(request), /CONTEXT_RECEIPT_EXPIRED/);
        const fresh = await instance.proposeTool({ ...request, toolName: "workbench_get_context", toolInput: {} });
        assert.equal(fresh.status, "completed");
        if (fresh.status !== "completed") throw new Error("context read must not need confirmation");
        const output = fresh.result.output as WorkbenchContextSnapshot & { contextReceiptId: string; contextExpiresAt: string };
        assert.notEqual(output.contextReceiptId, expired.receiptId);
        assert.equal(output.contextReceiptId, (await store.getSession(session.id))?.lastContextReceiptId);
        assert.ok(Date.parse(output.contextExpiresAt) > Date.now());
        assert.equal((await instance.proposeTool(request)).status, "completed");
        await store.updateSession(session.id, { status: "running", updatedAt: new Date().toISOString() });
        const pending = await instance.proposeTool({ ...request, toolName: "project_revise_script" });
        assert.equal(pending.status, "confirmation_required");
        snapshot = { ...snapshot, canvasRevision: 2, canvasStateHash: "b".repeat(64) };
        await assert.rejects(instance.proposeTool({ ...request, toolName: "project_revise_script", ordinaryConfirmationEnabled: false }), /CONTEXT_CANVAS_STALE/);
        await instance.proposeTool({ ...request, toolName: "workbench_get_context" });
        if (pending.status === "confirmation_required") await assert.rejects(instance.decideConfirmation({ confirmationId: pending.confirmation.id, sessionId: session.id, actorId: "owner-grant-recovery", approved: true }), /CONTEXT_CANVAS_STALE/);
        const validId = (await store.getSession(session.id))?.lastContextReceiptId;
        snapshot = { ...snapshot, projectId: "different-project" };
        await assert.rejects(instance.proposeTool({ ...request, toolName: "workbench_get_context" }), /CONTEXT_SCOPE_MISMATCH/);
        assert.equal((await store.getSession(session.id))?.lastContextReceiptId, validId);
        grants.revoke(session.permissionGrantId);
        await assert.rejects(instance.proposeTool({ ...request, toolName: "workbench_get_context" }), /GRANT/);
    } finally { await instance.dispose(); }
});

test("crossing the real 15 minute grant boundary stops tools; idle recovery reads the original receipt without replaying its write", async () => {
    let now = Date.now();
    const grants = new AgentPermissionGrantStore(undefined, () => new Date(now));
    const store = new MemoryBrainSessionStore();
    const snapshot: WorkbenchContextSnapshot = { projectId: "project-grant-recovery", canvasId: "canvas-grant-recovery", domainProjectId: "domain-script", canvasRevision: 1, canvasStateHash: "a".repeat(64), nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
    const requestId = "script-original-request";
    const receipt = { projectId: "domain-script", requestId, unitIds: ["new-a"] };
    const toolCalls: Array<{ name: string; input: unknown }> = [];
    const instance = runtime(store, grants, { hasConnectedBrowser: () => true, request: async () => { throw new Error("MODEL_API_FORBIDDEN"); } }, () => snapshot, {
        callTool: async (name, input) => {
            toolCalls.push({ name: String(name), input });
            return { ok: true, data: { receipt, verification: { ok: true, persisted: true, matchesCurrent: true } } };
        },
    });
    const adapter = instance.registry.getAdapter("codex.subscription");
    adapter.probe = async () => ({ profileId: "codex.subscription", status: "ready", checkedAt: new Date().toISOString() });
    adapter.createSession = async () => ({ providerThreadId: "original-provider-thread" });
    let resumes = 0;
    adapter.resumeSession = async input => { resumes++; assert.equal(input.providerThreadId, "original-provider-thread"); return { providerThreadId: input.providerThreadId }; };
    adapter.readHistory = async () => [{ id: "saved-receipt", role: "tool", text: requestId, source: "provider" }];
    let turns = 0;
    try {
        const { session } = await instance.createSession({ conversationId: "expiry-fixture", brainProfileId: "codex.subscription", projectId: snapshot.projectId, canvasId: snapshot.canvasId, domainProjectId: snapshot.domainProjectId, actorId: "owner-grant-recovery" });
        const originalGrant = grants.get(session.permissionGrantId)!;
        assert.equal(Date.parse(originalGrant.expiresAt) - Date.parse(originalGrant.issuedAt), 15 * 60_000);
        const write = { sessionId: session.id, toolName: "project_create_script", toolInput: { requestId, expectedProjectRevision: 1, note: "fixture", chapters: [{ title: "chapter", sourceText: "<p>original</p>" }] } };
        adapter.sendTurn = async () => {
            turns++;
            assert.equal((await instance.proposeTool(write)).status, "completed");
            now = Date.parse(originalGrant.expiresAt);
            await assert.rejects(instance.resumeSession(session.id, "owner-grant-recovery"), /ALREADY_RUNNING/);
            // Neither repeating the write nor reading context silently renews a grant.
            await assert.rejects(instance.proposeTool(write), /GRANT_EXPIRED/);
            await assert.rejects(instance.proposeTool({ ...write, toolName: "workbench_get_context", toolInput: {} }), /GRANT_NOT_FOUND/);
            throw new Error("AGENT_GRANT_EXPIRED");
        };
        await assert.rejects(instance.sendTurn(session.id, { turnId: "long-turn", prompt: "fixture", scriptCreation: { requestId, chapterCount: 1, polishRounds: 0 } }, () => undefined), /GRANT_EXPIRED/);
        assert.equal(toolCalls.length, 1);
        assert.equal((await store.getSession(session.id))?.status, "failed");
        const recovered = await instance.resumeSession(session.id, "owner-grant-recovery");
        assert.equal(resumes, 1); assert.equal(turns, 1); assert.equal(toolCalls.length, 1);
        assert.equal(recovered.session.providerThreadId, session.providerThreadId);
        assert.equal(recovered.history[0].text, requestId);
        const nextGrant = grants.get(recovered.session.permissionGrantId)!;
        assert.notEqual(nextGrant.id, originalGrant.id);
        assert.equal(Date.parse(nextGrant.expiresAt), now + 15 * 60_000);
        for (const field of ["sessionId", "connectionId", "actorId", "projectId", "domainProjectId", "toolSurface", "allowedTools"] as const) assert.deepEqual(nextGrant[field], originalGrant[field]);
        assert.throws(() => grants.validate(originalGrant.id, { sessionId: session.id, connectionId: session.connectionId, projectId: session.projectId }), /GRANT_NOT_FOUND/);
        assert.throws(() => grants.validate(nextGrant.id, { sessionId: session.id, connectionId: session.connectionId, projectId: "other-project" }), /SCOPE_MISMATCH/);
        const read = await instance.proposeTool({ sessionId: session.id, turnId: "explicit-readback", toolName: "project_get_script_batch", toolInput: { requestId } });
        assert.equal(read.status, "completed");
        if (read.status === "completed") assert.deepEqual((read.result.output as { data: { receipt: unknown } }).data.receipt, receipt);
        assert.deepEqual(toolCalls.map(call => call.name), ["project_create_script", "project_get_script_batch"]);
        assert.equal((toolCalls[1].input as { requestId: string }).requestId, requestId);
        // New-chapter auto-approval was limited to the old turn, not restored.
        assert.equal((await instance.proposeTool({ ...write, turnId: "after-recovery" })).status, "confirmation_required");
        assert.equal(toolCalls.length, 2);
    } finally { await instance.dispose(); }
});

function runtime(store: MemoryBrainSessionStore, grants: AgentPermissionGrantStore, browserRuntime: BrowserRuntimeTransport, snapshot?: () => WorkbenchContextSnapshot, canvasToolExecutor: CanonicalCanvasToolExecutor = { callTool: async () => ({ ok: true }) }) {
    return new GenericAgentRuntime(
        config(),
        () => undefined,
        snapshot ?? (() => ({
            projectId: "project-grant-recovery",
            canvasId: "canvas-grant-recovery",
            canvasRevision: 1,
            canvasStateHash: "a".repeat(64),
            nodes: [],
            connections: [],
            selectedNodeIds: [],
            visibleNodeIds: [],
            assets: [],
        })),
        async () => ({ approved: true }),
        {
            featureFlags: resolveAgentFeatureFlags({
                "film.agent_generic_runtime": true,
                "film.agent_context_broker": true,
                "film.agent_canonical_tool_manifest": true,
                "film.agent_canonical_tool_broker": true,
                "film.agent_model_api_profiles": true,
                "film.agent_codex_subscription": true,
                "film.agent_no_silent_api_fallback": true,
                "film.agent_request_scoped_identity": true,
            }, {}),
            browserRuntime,
            store,
            grants,
            persistentAudit: false,
            canvasToolExecutor,
        },
    );
}

function config(): LocalRuntimeConfig {
    return {
        url: "http://127.0.0.1:17371",
        token: "grant-recovery-test-token",
        ownerId: "owner-grant-recovery",
        trustedWebOrigins: ["http://127.0.0.1:43100"],
        browserRegistrations: [],
    };
}

import assert from "node:assert/strict";
import test from "node:test";

import type { LocalRuntimeConfig } from "../src/config.js";
import type { BrowserRuntimeRequest, BrowserRuntimeTransport } from "../src/brains/browser-runtime-port.js";
import { resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { GenericAgentRuntime } from "../src/brains/generic-agent-runtime.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import type { WorkbenchContextSnapshot } from "../src/brains/context-broker.js";

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

function runtime(store: MemoryBrainSessionStore, grants: AgentPermissionGrantStore, browserRuntime: BrowserRuntimeTransport, snapshot?: () => WorkbenchContextSnapshot) {
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
                "film.agent_no_silent_api_fallback": true,
                "film.agent_request_scoped_identity": true,
            }, {}),
            browserRuntime,
            store,
            grants,
            persistentAudit: false,
            canvasToolExecutor: { callTool: async () => ({ ok: true }) },
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

import assert from "node:assert/strict";
import test from "node:test";

import {
    ChatGPTHostedAdapter,
    type ChatGPTHostBridgeClient,
} from "../src/brains/adapters/chatgpt-hosted-adapter.js";
import type { AgentContextPackV1, AgentPermissionGrant, BrainSession, NormalizedBrainEvent } from "../src/brains/contracts.js";

test("ChatGPT Hosted adapter binds Track 14 sessions to project grants and never instantiates an API fallback", async () => {
    const calls: string[] = [];
    const adapter = new ChatGPTHostedAdapter(bridge(calls));
    const probe = await adapter.probe();
    assert.equal(probe.status, "ready");
    assert.equal(probe.version, "subscription_host_no_extra_model_api");

    const created = await adapter.createSession(createInput("project-a", "canvas-a"), grant("session-a", "project-a"));
    assert.equal(created.providerThreadId, "host-session-session-a");
    assert.deepEqual(calls, ["probe", "prepare:session-a:project-a:grant-session-a"]);

    const events: NormalizedBrainEvent[] = [];
    const result = await adapter.sendTurn(turn(session("session-a", "project-a", "canvas-a", created.providerThreadId)), (event) => { events.push(event); });
    assert.equal(result.status, "handoff_pending");
    assert.equal(result.providerThreadId, "host-session-session-a");
    assert.deepEqual(events.map((event) => event.type), ["turn.started", "host.handoff.prepared"]);
    assert.equal(events.some((event) => event.type === "message.delta"), false);
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    assert.equal(calls.some((call) => call.includes("api")), false);
    assert.equal(result.text, undefined);
    assert.equal(result.handoff?.status, "waiting_host");
});

test("ChatGPT Hosted adapter isolates A/B sessions and rejects project or direct-apply spoofing", async () => {
    const calls: string[] = [];
    const adapter = new ChatGPTHostedAdapter(bridge(calls));
    const a = await adapter.createSession(createInput("project-a", "canvas-a"), grant("session-a", "project-a"));
    const b = await adapter.createSession(createInput("project-b", "canvas-b"), grant("session-b", "project-b"));
    await adapter.sendTurn(turn(session("session-a", "project-a", "canvas-a", a.providerThreadId)), async () => undefined);
    await adapter.sendTurn(turn(session("session-b", "project-b", "canvas-b", b.providerThreadId)), async () => undefined);
    assert.equal(calls.includes("handoff:session-a:project-a:receipt-project-a"), true);
    assert.equal(calls.includes("handoff:session-b:project-b:receipt-project-b"), true);

    await assert.rejects(
        () => adapter.createSession(createInput("project-b", "canvas-b"), grant("session-c", "project-a")),
        /GRANT_SCOPE_MISMATCH/,
    );
    await assert.rejects(
        () => adapter.sendTurn(turn(session("session-a", "project-b", "canvas-a", a.providerThreadId)), async () => undefined),
        /PROJECT_SCOPE_MISMATCH/,
    );

    const unsafe = new ChatGPTHostedAdapter(bridge([], { directApply: true }));
    await assert.rejects(
        () => unsafe.createSession(createInput("project-a", "canvas-a"), grant("session-a", "project-a")),
        /DIRECT_APPLY_FORBIDDEN/,
    );
});

test("ChatGPT Hosted adapter refreshes and closes only its own Host session", async () => {
    const calls: string[] = [];
    const adapter = new ChatGPTHostedAdapter(bridge(calls));
    const created = await adapter.createSession(createInput("project-a", "canvas-a"), grant("session-a", "project-a"));
    const resumed = await adapter.resumeSession({ sessionId: "session-a", providerThreadId: created.providerThreadId, projectId: "project-a", canvasId: "canvas-a", grant: grant("session-a", "project-a") });
    assert.equal(resumed.providerThreadId, created.providerThreadId);
    await assert.rejects(() => adapter.cancelTurn("session-a"), /NOT_CANCELLABLE/);
    await adapter.closeSession("session-a");
    assert.equal(calls.includes("refresh:session-a:project-a"), true);
    assert.equal(calls.includes("close:session-a:project-a"), true);
});

function bridge(calls: string[], options: { directApply?: boolean } = {}): ChatGPTHostBridgeClient {
    const sessions = new Map<string, { hostSessionId: string; projectId: string }>();
    return {
        probe: async () => {
            calls.push("probe");
            return {
                ready: true,
                profileId: "chatgpt.subscription.host",
                billingMode: "subscription_host_no_extra_model_api",
                modelApiAdapterAvailable: false,
                fallbackEnabled: false,
            };
        },
        prepareSession: async (input) => {
            calls.push(`prepare:${input.brainSessionId}:${input.projectId}:${input.permissionGrant.id}`);
            const value = { hostSessionId: `host-session-${input.brainSessionId}`, projectId: input.projectId };
            sessions.set(input.brainSessionId, value);
            return {
                ...value,
                projectGrantId: `project-grant-${input.projectId}`,
                status: "waiting_for_host",
                proposalHandoffEnabled: true,
                directApplyAvailable: options.directApply === true as false,
            };
        },
        refreshSession: async (input) => {
            calls.push(`refresh:${input.brainSessionId}:${input.projectId}`);
            return {
                hostSessionId: input.hostSessionId,
                projectGrantId: `project-grant-${input.projectId}`,
                projectId: input.projectId,
                status: "waiting_for_host",
                proposalHandoffEnabled: true,
                directApplyAvailable: false,
            };
        },
        prepareHandoff: async (input) => {
            calls.push(`handoff:${input.brainSessionId}:${input.projectId}:${input.contextReceiptId}`);
            return {
                handoffId: `handoff-${input.brainSessionId}`,
                hostSessionId: input.hostSessionId,
                projectId: input.projectId,
                contextReceiptId: input.contextReceiptId,
                status: "waiting_for_host",
                directApplyAvailable: false,
                createdAt: "2099-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T01:00:00.000Z",
            };
        },
        closeSession: async (input) => {
            calls.push(`close:${input.brainSessionId}:${input.projectId}`);
            sessions.delete(input.brainSessionId);
        },
    };
}

function createInput(projectId: string, canvasId: string) {
    return { conversationId: `conversation-${projectId}`, brainProfileId: "chatgpt.subscription.host", projectId, canvasId, actorId: "actor" };
}

function grant(sessionId: string, projectId: string): AgentPermissionGrant {
    return {
        id: `grant-${sessionId}`,
        sessionId,
        connectionId: "chatgpt.subscription.host",
        actorId: "actor",
        projectId,
        toolSurface: "chatgpt_hosted",
        allowedTools: ["filmos_get_project"],
        issuedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: "2026-08-29T01:00:00.000Z",
        nonce: `nonce-${sessionId}`,
        keyId: "filmos-local-runtime-v1",
        signature: `signature-${sessionId}`,
    };
}

function session(id: string, projectId: string, canvasId: string, providerThreadId?: string): BrainSession {
    return {
        id,
        conversationId: `conversation-${projectId}`,
        brainProfileId: "chatgpt.subscription.host",
        connectionId: "chatgpt.subscription.host",
        projectId,
        canvasId,
        ...(providerThreadId ? { providerThreadId } : {}),
        permissionGrantId: `grant-${id}`,
        status: "ready",
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
    };
}

function turn(value: BrainSession) {
    return {
        session: value,
        turnId: `turn-${value.id}`,
        prompt: "请在官方 ChatGPT 中读取当前上下文并准备提案",
        context: { contextReceiptId: `receipt-${value.projectId}` } as AgentContextPackV1,
    };
}

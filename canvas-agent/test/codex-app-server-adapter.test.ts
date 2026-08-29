import assert from "node:assert/strict";
import test from "node:test";

import { codexConfig } from "../src/agents.js";
import { CodexSubscriptionAdapter } from "../src/brains/adapters/codex-app-server-adapter.js";
import { declineServerRequest, type CodexThreadBinding } from "../src/brains/adapters/codex-app-server-client.js";
import type { AgentContextPackV1, AgentPermissionGrant, BrainSession } from "../src/brains/contracts.js";

const grant: AgentPermissionGrant = {
    id: "grant-1",
    sessionId: "session-1",
    connectionId: "codex.subscription",
    actorId: "actor-1",
    projectId: "project-1",
    toolSurface: "workbench_operator",
    allowedTools: ["canvas_get_context"],
    issuedAt: "2026-08-29T00:00:00.000Z",
    expiresAt: "2026-08-29T01:00:00.000Z",
    nonce: "nonce-1",
};

test("Codex subscription probe reports managed ChatGPT auth and quota without an API key", async () => {
    const adapter = new CodexSubscriptionAdapter({
        probe: async () => ({
            account: { account: { type: "chatgpt", email: "member@example.test", planType: "pro" } },
            limits: { rateLimits: { primary: { usedPercent: 25, resetsAt: 1_800_000_000 } } },
        }),
    } as never, () => "/tmp/project", () => ({}));
    const status = await adapter.probe();
    assert.equal(status.status, "ready");
    assert.equal(status.accountLabel, "member@example.test");
    assert.equal(status.version, "pro");
    assert.equal(status.quota?.remainingPercent, 75);

    const env = codexConfig("/tmp/runtime", grant)["mcp_servers.yingce.env"];
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal(env.FILMOS_AGENT_PROFILE, "codex_app_server");
    assert.equal(env.FILMOS_BRAIN_PROFILE_ID, "codex.subscription");
    assert.equal(env.FILMOS_AGENT_GRANT_ID, grant.id);
    assert.equal(env.FILMOS_AGENT_GRANT_NONCE, grant.nonce);
});

test("Codex server requests fail closed unless the matching FilmOS confirmation approves", async () => {
    const decisions: unknown[] = [];
    const fake = fakeClient(async (binding) => {
        decisions.push(await binding.handleServerRequest?.({ id: 4, method: "item/commandExecution/requestApproval", params: {}, threadId: "thread-1", turnId: "provider-turn" }));
    });
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/project", () => ({}));
    const created = await adapter.createSession(sessionInput(), grant);
    await adapter.sendTurn(turnInput({ ...session(), ...created }), async () => undefined);
    assert.deepEqual(decisions, [{ decision: "decline" }]);

    const approved: unknown[] = [];
    const approving = new CodexSubscriptionAdapter(
        { client: async () => fakeClient(async (binding) => approved.push(await binding.handleServerRequest?.({ id: 5, method: "mcpServer/elicitation/request", params: {}, threadId: "thread-1", turnId: "provider-turn" }))) } as never,
        () => "/tmp/project",
        () => ({}),
        async ({ sessionId, turnId }) => ({ approved: sessionId === "session-1" && turnId === "provider-turn", content: { confirmed: true } }),
    );
    const second = await approving.createSession(sessionInput(), grant);
    await approving.sendTurn(turnInput({ ...session(), ...second }), async () => undefined);
    assert.deepEqual(approved, [{ action: "accept", content: { confirmed: true }, _meta: null }]);
    assert.deepEqual(declineServerRequest("mcpServer/elicitation/request"), { action: "decline", content: null, _meta: null });
});

test("Codex turns serialize per thread, run independently across sessions, and support interrupt", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const fake = fakeClient(async (_binding, threadId, onTurnStarted) => {
        const providerTurn = `turn-${started.length + 1}`;
        started.push(threadId);
        onTurnStarted?.(providerTurn);
        await new Promise<void>((resolve) => releases.push(resolve));
    });
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, (canvasId) => `/tmp/${canvasId}`, () => ({}));
    const firstPatch = await adapter.createSession(sessionInput(), grant);
    const grant2 = { ...grant, id: "grant-2", sessionId: "session-2", projectId: "project-2", nonce: "nonce-2" };
    const secondPatch = await adapter.createSession({ ...sessionInput(), projectId: "project-2", canvasId: "canvas-2" }, grant2);
    assert.deepEqual(fake.preflights, [
        { threadId: "thread-1", server: "yingce", tool: "workbench_get_context" },
        { threadId: "thread-2", server: "yingce", tool: "workbench_get_context" },
    ]);
    const firstSession = { ...session(), ...firstPatch };
    const secondSession = { ...session(), id: "session-2", projectId: "project-2", canvasId: "canvas-2", permissionGrantId: "grant-2", ...secondPatch };
    const first = adapter.sendTurn(turnInput(firstSession), async () => undefined);
    const queued = adapter.sendTurn({ ...turnInput(firstSession), turnId: "turn-local-2" }, async () => undefined);
    const parallel = adapter.sendTurn({ ...turnInput(secondSession), turnId: "turn-local-3" }, async () => undefined);
    await tick();
    assert.deepEqual(started.sort(), ["thread-1", "thread-2"]);
    await adapter.cancelTurn("session-1");
    assert.deepEqual(fake.interrupts, [{ threadId: "thread-1", turnId: "turn-1" }]);
    releases.splice(0).forEach((release) => release());
    await tick();
    assert.equal(started.length, 3);
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, queued, parallel]);
});

function fakeClient(onTurn?: (binding: CodexThreadBinding, threadId: string, onTurnStarted?: (turnId: string) => void) => Promise<void>) {
    let threadNumber = 0;
    const interrupts: Array<{ threadId: string; turnId: string }> = [];
    const preflights: Array<{ threadId: string; server: string; tool: string }> = [];
    return {
        interrupts,
        preflights,
        startThread: async () => ({ id: `thread-${++threadNumber}` }),
        resumeThread: async (threadId: string) => ({ id: threadId }),
        callMcpTool: async (threadId: string, server: string, tool: string) => {
            preflights.push({ threadId, server, tool });
            return { content: [{ type: "text", text: "context" }] };
        },
        startTurn: async (threadId: string, _prompt: string, _images: string[], _skills: unknown[], binding: CodexThreadBinding, onTurnStarted?: (turnId: string) => void) => {
            await onTurn?.(binding, threadId, onTurnStarted);
            return { turnId: "provider-turn" };
        },
        interruptTurn: async (threadId: string, turnId: string) => { interrupts.push({ threadId, turnId }); },
        unbindThread: () => undefined,
    };
}

function sessionInput() {
    return { conversationId: "conversation-1", brainProfileId: "codex.subscription", projectId: "project-1", canvasId: "canvas-1", actorId: "actor-1" };
}

function session(): BrainSession {
    return {
        id: "session-1", conversationId: "conversation-1", brainProfileId: "codex.subscription", connectionId: "codex.subscription",
        projectId: "project-1", canvasId: "canvas-1", permissionGrantId: "grant-1", status: "ready",
        createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
    };
}

function turnInput(value: BrainSession) {
    return { session: value, turnId: "turn-local-1", prompt: "read context", context: { contextReceiptId: "receipt-1" } as AgentContextPackV1 };
}

async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
}

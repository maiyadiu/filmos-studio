import assert from "node:assert/strict";
import test from "node:test";

import { codexConfig } from "../src/agents.js";
import { CodexSubscriptionAdapter, codexThreadHistory } from "../src/brains/adapters/codex-app-server-adapter.js";
import { declineServerRequest, type CodexThreadBinding } from "../src/brains/adapters/codex-app-server-client.js";
import type { AgentContextPackV1, AgentPermissionGrant, BrainSession, NormalizedBrainEvent } from "../src/brains/contracts.js";

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
    keyId: "filmos-local-runtime-v1",
    signature: "signature-1",
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
    assert.equal(env.FILMOS_AGENT_GRANT_SIGNATURE, grant.signature);
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

test("ordinary creative sessions do not inherit engineering shell or cross-project memories", async () => {
    const fake = fakeClient();
    const configs: Record<string, unknown>[] = [];
    fake.startThread = async (...args: unknown[]) => { configs.push(args[1] as Record<string, unknown>); return { id: "thread-1" }; };
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/creative-fixture", () => ({ "mcp_servers.yingce.command": "fixture" }));
    await adapter.createSession(sessionInput(), grant);
    assert.equal(configs[0]["features.memories"], false);
    assert.equal(configs[0]["features.shell_tool"], false);
    assert.equal(configs[0]["features.apps"], false);
    assert.equal(configs[0]["features.plugins"], false);
    assert.equal(configs[0]["features.remote_plugin"], false);
    assert.equal(configs[0]["web_search"], "disabled");
    assert.equal(configs[0]["mcp_servers.yingce.required"], true);
    assert.equal(configs[0]["mcp_servers.yingce.command"], "fixture");
    await adapter.createSession({ ...sessionInput(), executionProfile: "review_coordinator", workspacePath: "/tmp/review-fixture" }, grant);
    assert.equal(configs[1]["features.shell_tool"], undefined);
    assert.equal(configs[1]["features.apps"], undefined);
});

test("workbench preflight rejects an inherited callable connector, including later inventory pages", async () => {
    for (const paginated of [false, true]) {
        const fake = fakeClient();
        let reads = 0;
        fake.listMcpServerStatus = (async () => {
            reads++;
            return paginated && reads === 1
                ? { data: [{ name: "yingce", runtimeStatus: "connected", tools: {} }], nextCursor: "next" }
                : { data: [{ name: "unrelated", runtimeStatus: "connected", tools: { external_write: {} } }] };
        }) as typeof fake.listMcpServerStatus;
        const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/creative", () => ({}));
        await assert.rejects(adapter.createSession(sessionInput(), grant), /CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED/);
        assert.equal(reads, paginated ? 2 : 1);
    }
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
    const firstCancelled = assert.rejects(first, /AGENT_TURN_CANCELLED/);
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
    await Promise.all([firstCancelled, queued, parallel]);
});

test("review coordinator uses its isolated workspace without requiring a live canvas MCP preflight", async () => {
    const fake = fakeClient();
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => {
        throw new Error("CURRENT_CANVAS_MUST_NOT_BE_RESOLVED");
    }, () => ({}));
    const created = await adapter.createSession({
        ...sessionInput(),
        canvasId: "review-project-1",
        workspacePath: "/tmp/filmos-review-project-1",
        executionProfile: "review_coordinator",
    }, grant);
    assert.equal(created.providerThreadId, "thread-1");
    assert.deepEqual(fake.preflights, []);
});

test("review coordinator replaces only an explicitly missing persisted rollout", async () => {
    const fake = fakeClient();
    fake.resumeThread = async () => { throw new Error("no rollout found for thread id thread-missing"); };
    fake.startThread = async () => ({ id: "thread-replacement" });
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/unused", () => ({}));
    const resumed = await adapter.resumeSession({
        sessionId: grant.sessionId,
        providerThreadId: "thread-missing",
        projectId: grant.projectId,
        canvasId: "review-project-1",
        workspacePath: "/tmp/filmos-review-project-1",
        executionProfile: "review_coordinator",
        grant,
    });
    assert.equal(resumed.providerThreadId, "thread-replacement");
    assert.deepEqual(fake.preflights, []);
});

test("ordinary Codex sessions never replace a missing rollout silently", async () => {
    const fake = fakeClient();
    let starts = 0;
    fake.resumeThread = async () => { throw new Error("no rollout found for thread id thread-missing"); };
    fake.startThread = async () => ({ id: `thread-${++starts}` });
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/project", () => ({}));
    await assert.rejects(() => adapter.resumeSession({
        sessionId: grant.sessionId,
        providerThreadId: "thread-missing",
        projectId: grant.projectId,
        canvasId: "canvas-1",
        grant,
    }), /no rollout found/);
    assert.equal(starts, 0);
});

test("resume uses a session-scoped replacement process with the new grant and the same provider thread", async () => {
    const first = fakeClient(), second = fakeClient();
    const calls: Array<{ sessionId?: string; replace?: boolean }> = [];
    let active = first;
    let received: Record<string, unknown> | undefined;
    second.resumeThread = async (threadId: string, _cwd?: string, config?: Record<string, unknown>) => { received = config; return { id: threadId }; };
    const adapter = new CodexSubscriptionAdapter({ client: async (sessionId?: string, replace?: boolean) => { calls.push({ sessionId, replace }); if (replace) active = second; return active; } } as never, () => "/tmp/fixture", g => ({ grantMarker: g.id }));
    const created = await adapter.createSession(sessionInput(), grant);
    const resumed = await adapter.resumeSession({ sessionId: grant.sessionId, providerThreadId: created.providerThreadId, projectId: grant.projectId, canvasId: "canvas-1", grant: { ...grant, id: "grant-2" } });
    assert.equal(resumed.providerThreadId, created.providerThreadId);
    assert.equal(received?.grantMarker, "grant-2");
    assert.deepEqual(calls, [{ sessionId: grant.sessionId, replace: undefined }, { sessionId: grant.sessionId, replace: true }]);
});

test("Codex resume history is reconstructed from the real provider thread payload", () => {
    const history = codexThreadHistory({ turns: [{ items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "FilmOS context\n\n用户请求：恢复这次对话" }] },
        { id: "a1", type: "agentMessage", text: "已从 Provider Thread 恢复" },
        { id: "t1", type: "mcpToolCall", tool: "workbench_get_context", status: "completed" },
    ] }] });
    assert.deepEqual(history.map(({ id, role, text, source }) => ({ id, role, text, source })), [
        { id: "u1", role: "user", text: "恢复这次对话", source: "provider" },
        { id: "a1", role: "assistant", text: "已从 Provider Thread 恢复", source: "provider" },
        { id: "t1", role: "tool", text: "workbench_get_context completed", source: "provider" },
    ]);
});

test("pixel tool keeps descriptors but not duplicate image bytes in events or resumed UI history", async () => {
    const result = { content: [{ type: "text", text: '{"image":{"sha256":"fixture-hash"}}' }, { type: "image", mimeType: "image/png", data: "fixture-pixels-never-store-twice" }] };
    const fake = fakeClient(async binding => { binding.emit("agent_event", { type: "item.completed", item: { id: "image-call", type: "mcp_tool_call", tool: "project_read_shot_image", status: "completed", result } }); });
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/fixture", () => ({}));
    const patch = await adapter.createSession(sessionInput(), grant);
    const events: NormalizedBrainEvent[] = [];
    await adapter.sendTurn(turnInput({ ...session(), ...patch }), async event => { events.push(event); });
    const history = codexThreadHistory({ turns: [{ items: [{ id: "image-call", type: "mcpToolCall", tool: "project_read_shot_image", status: "completed", result }] }] });
    for (const output of [events, history]) {
        assert.doesNotMatch(JSON.stringify(output), /fixture-pixels-never-store-twice/);
        assert.match(JSON.stringify(output), /fixture-hash/);
        assert.match(JSON.stringify(output), /pixelsOmittedFromHistory/);
    }
    assert.equal(result.content[1].data, "fixture-pixels-never-store-twice");
});

test("native plan, exact deltas and completed messages retain identity through normalized events and history", async () => {
    const text = "## 原稿\n\n哈哈\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const fake = fakeClient(async binding => {
        binding.emit("agent_event", { type: "turn.plan.updated", providerTurnId: "provider-turn", plan: [{ step: "读取并核验", status: "inProgress" }], explanation: "只修改目标章节；保存后回读版本" });
        binding.emit("agent_event", { type: "turn.plan.updated", plan: [{ step: "不能猜状态", status: "invented" }] });
        binding.emit("agent_event", { type: "item.updated", providerTurnId: "provider-turn", delta: "\n\n", item: { id: "a1", type: "agent_message", text: "## 原稿\n\n" } });
        binding.emit("agent_event", { type: "item.completed", providerTurnId: "provider-turn", item: { id: "a1", type: "agent_message", text } });
    });
    const adapter = new CodexSubscriptionAdapter({ client: async () => fake } as never, () => "/tmp/fixture", () => ({}));
    const patch = await adapter.createSession(sessionInput(), grant);
    const events: NormalizedBrainEvent[] = [];
    await adapter.sendTurn(turnInput({ ...session(), ...patch }), async event => { events.push(event); });
    const plan = events.filter(event => event.type === "turn.plan.updated");
    assert.equal(plan.length, 1);
    assert.equal(plan[0].plan.source, "provider");
    assert.equal(plan[0].plan.steps[0].status, "inProgress");
    const delta = events.find(event => event.type === "message.delta");
    assert.equal(delta?.delta, "\n\n");
    assert.equal(delta?.text, "## 原稿\n\n");
    const done = events.find(event => event.type === "message.completed");
    assert.equal(done?.text, text);
    assert.equal(done?.streamId, delta?.streamId);
    const history = codexThreadHistory({ turns: [{ id: "provider-turn", items: [{ id: "a1", type: "agentMessage", text }] }] });
    assert.equal(history[0].streamId, done?.streamId);
    assert.equal(history[0].text, text);
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
        listMcpServerStatus: async () => ({ data: [{ name: "yingce", runtimeStatus: "connected", tools: {} }] }),
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

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SOURCE_MAINTENANCE_TOOLS } from "@filmos/agent-contracts";
import { GenericAgentRuntime } from "../src/brains/generic-agent-runtime.js";
import { SourceMaintenanceTasks } from "../src/brains/source-maintenance-tasks.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";
import { resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { registerMcpTools } from "../src/mcp-server.js";
import { z } from "zod";
import { sourceFixture } from "./fixtures/source-maintenance.js";
import { adapter } from "./brain-test-fixtures.js";

test("maintenance replaces the idle session grant, executes exact patches through the canonical broker, then resumes the original creative thread", async t => {
    const source = sourceFixture(t), store = new MemoryBrainSessionStore();
    const tasks = new SourceMaintenanceTasks(() => source.workspace, () => store);
    const native = adapter("codex.subscription"), issuedThreads: string[] = [];
    let creates = 0, turns = 0;
    native.createSession = async () => { creates++; return { providerThreadId: "original-creative-thread" }; };
    native.resumeSession = async input => { issuedThreads.push(input.providerThreadId!); return { providerThreadId: input.providerThreadId }; };
    native.sendTurn = async () => { turns++; throw new Error("MODEL_CALL_FORBIDDEN"); };
    const runtime = new GenericAgentRuntime({ url: "http://127.0.0.1:17371", token: "fixture", ownerId: "fixture", trustedWebOrigins: [], browserRegistrations: [] }, () => {}, () => ({ projectId: "canvas", domainProjectId: "project", canvasId: "canvas", canvasRevision: 1, canvasStateHash: "a".repeat(64), nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] }), async () => ({ approved: false }), {
        store, sourceMaintenance: tasks, codexAdapter: native, persistentAudit: false,
        featureFlags: resolveAgentFeatureFlags({ "film.agent_generic_runtime": true, "film.agent_context_broker": true, "film.agent_canonical_tool_manifest": true, "film.agent_canonical_tool_broker": true, "film.agent_codex_subscription": true, "film.agent_no_silent_api_fallback": true, "film.agent_request_scoped_identity": true }, {}),
        browserRuntime: { hasConnectedBrowser: () => true, request: async () => { throw new Error("MODEL_API_FORBIDDEN"); } },
        canvasToolExecutor: { callTool: async () => { throw new Error("BUSINESS_WRITE_FORBIDDEN"); } },
    });
    t.after(() => runtime.dispose());
    const { session } = await runtime.createSession({ conversationId: "original", accountScopeId: "account_" + "a".repeat(64), brainProfileId: "codex.subscription", projectId: "canvas", domainProjectId: "project", canvasId: "canvas", actorId: "fixture" });
    const beforeGrant = runtime.grants.get(session.permissionGrantId)!;
    assert.ok(!beforeGrant.allowedTools.some(name => name.startsWith("source_")));
    const expectedHash = (await source.workspace.read({ path: "web/src/view.ts" })).contentHash;
    const body = { requestId: "task-one", purpose: "Fixture repair", files: [{ path: "web/src/view.ts", expectedHash }] };
    await runtime.changeSourceTask(session.id, "open", body, () => {});
    const current = (await store.getSession(session.id))!;
    const grant = runtime.grants.get(current.permissionGrantId)!;
    assert.equal(runtime.grants.get(beforeGrant.id), undefined);
    assert.deepEqual(new Set(grant.allowedTools), new Set(["workbench_get_context", ...SOURCE_MAINTENANCE_TOOLS]));
    assert.equal(current.providerThreadId, session.providerThreadId);
    assert.equal(turns, 0);
    native.sendTurn = async input => {
        turns++;
        const tool = (toolName: string, toolInput: Record<string, unknown>) => runtime.proposeTool({ sessionId: session.id, toolName, toolInput, ordinaryConfirmationEnabled: false });
        await assert.rejects(runtime.changeSourceTask(session.id, "close", {}, () => {}), /TURN_ALREADY_RUNNING/);
        await assert.rejects(tool("project_get_context", {}), /SOURCE_GRANT_INVALID|TOOL_NOT_GRANTED/);
        await assert.rejects(tool("canvas_create_text_node", { text: "forbidden" }), /SOURCE_GRANT_INVALID|TOOL_NOT_GRANTED/);
        const prepared = await tool("source_prepare_patch", { requestId: "patch-one", path: "web/src/view.ts", expectedHash, oldText: "'fixture'", newText: "'repaired'" });
        assert.equal(prepared.status, "completed");
        const applied = await tool("source_apply_patch", { requestId: "patch-one" });
        assert.equal(applied.status, "completed");
        return { sessionId: session.id, turnId: input.turnId, providerThreadId: input.session.providerThreadId, text: "verified fixture patch", status: "completed" };
    };
    await runtime.sendTurn(session.id, { turnId: "explicit-source-turn", prompt: "Repair only the authorized fixture title" }, () => {});
    assert.match((await source.workspace.read({ path: "web/src/view.ts" })).content, /'repaired'/);
    for (const status of ["running", "awaiting_confirmation"] as const) {
        await store.updateSession(session.id, { status });
        await assert.rejects(runtime.changeSourceTask(session.id, "close", {}, () => {}), /TURN_ALREADY_RUNNING/);
    }
    await store.updateSession(session.id, { status: "interrupted" });
    await store.updateSession(session.id, { status: "ready" });
    await runtime.changeSourceTask(session.id, "close", {}, () => {});
    const closed = (await store.getSession(session.id))!;
    assert.equal(runtime.grants.get(grant.id), undefined);
    assert.ok(!runtime.grants.get(closed.permissionGrantId)!.allowedTools.some(name => name.startsWith("source_")));
    assert.deepEqual(issuedThreads, [session.providerThreadId, session.providerThreadId]);
    assert.equal(creates, 1); assert.equal(turns, 1);
    native.resumeSession = async () => ({ sourceMaintenance: undefined });
    await assert.rejects(runtime.manager.resumeSession(session.id, "fixture"), /Runtime-owned source task/);
    assert.deepEqual((await store.getSession(session.id))!.sourceMaintenance, closed.sourceMaintenance);
});

test("source grants cannot mix creative tools or another brain and source MCP advertises only its exact tools", t => {
    const grants = new AgentPermissionGrantStore();
    const base = { sessionId: "fixture", connectionId: "codex.subscription", actorId: "fixture", projectId: null, workspaceId: "fixture", toolSurface: "workbench_operator" as const, allowedTools: ["workbench_get_context", ...SOURCE_MAINTENANCE_TOOLS] };
    assert.throws(() => grants.issue(base), /SOURCE_TASK_REQUIRED/);
    assert.throws(() => grants.issue({ ...base, sourceTaskId: randomUUID(), allowedTools: [...base.allowedTools, "generation_submit"] }), /SOURCE_GRANT_INVALID/);
    assert.throws(() => grants.issue({ ...base, sourceTaskId: randomUUID(), connectionId: "openai.api" }), /SOURCE_GRANT_INVALID/);
    const grant = grants.issue({ ...base, sourceTaskId: randomUUID() });
    assert.equal(grants.validate(grant.id, { ...base, toolName: "source_apply_patch" }).sourceTaskId, grant.sourceTaskId);
    assert.ok(!new CanonicalAgentToolManifest().names().some(name => name.startsWith("source_")));
    const saved = process.env.FILMOS_SOURCE_TASK_ID;
    t.after(() => { if (saved === undefined) delete process.env.FILMOS_SOURCE_TASK_ID; else process.env.FILMOS_SOURCE_TASK_ID = saved; });
    const collect = () => {
        const entries = new Map<string, { inputSchema: Record<string, z.ZodTypeAny> }>();
        registerMcpTools({ registerTool: (name: string, definition: { inputSchema: Record<string, z.ZodTypeAny> }) => entries.set(name, definition) } as never, { url: "http://127.0.0.1:17371", token: "fixture", trustedWebOrigins: [], browserRegistrations: [] }, { surface: "workbench_operator" });
        return entries;
    };
    delete process.env.FILMOS_SOURCE_TASK_ID;
    assert.ok(![...collect().keys()].some(name => name.startsWith("source_")));
    process.env.FILMOS_SOURCE_TASK_ID = grant.sourceTaskId;
    const tools = collect();
    assert.deepEqual(new Set(tools.keys()), new Set(base.allowedTools));
    const schema = z.object(tools.get("source_prepare_patch")!.inputSchema);
    assert.equal(schema.safeParse({ requestId: "x", path: "web/src/view.ts", expectedHash: "bad", oldText: "x", newText: "y" }).success, false);
    assert.equal(schema.safeParse({ requestId: "x", path: "web/src/view.ts", expectedHash: "a".repeat(64), oldText: "x", newText: "y" }).success, true);
});

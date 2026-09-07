import { expect, test } from "bun:test";
import { AgentSessionClient, AgentRuntimeRequestError } from "./agent-client.ts";
import { agentFailureGuidance, agentFailureText, recoverAgentSession } from "./agent-session-recovery.ts";

const scope = { id: "s", brainProfileId: "codex.subscription", projectId: "canvas", canvasId: "canvas", domainProjectId: "project", contentUnitId: "unit" };
const session = () => ({ ...scope, providerThreadId: "original-thread", conversationId: "conversation", status: "ready", updatedAt: "now", execution: { activeTurnId: null, resuming: false, pendingConfirmations: [] } });
function fixture(transform = (value) => value) {
    const calls = [];
    const client = new AgentSessionClient({ request: async (path, init) => {
        calls.push({ path, method: init.method });
        const value = transform({ ok: true, session: session(), history: [{ id: "saved", role: "tool", text: "original receipt", source: "provider" }], historyStatus: { source: "provider", complete: true } }, calls.length);
        return new Response(JSON.stringify(value));
    } });
    return { calls, client };
}

test("recovery checks current scope, synchronizes context, resumes the original thread and reads back; no turn/write replay", async () => {
    const { calls, client } = fixture();
    let syncCount = 0;
    const data = await recoverAgentSession(client, scope, () => true, async () => { syncCount++; expect(calls).toHaveLength(1); return true; });
    expect(syncCount).toBe(1);
    expect(data.session.providerThreadId).toBe("original-thread");
    expect(data.history[0].text).toBe("original receipt");
    expect(calls).toEqual([{ path: "/agent/sessions/s", method: "GET" }, { path: "/agent/sessions/s/resume", method: "POST" }, { path: "/agent/sessions/s", method: "GET" }]);
});

test("workspace recovery binds the exact runtime owner with null project and canvas", async () => {
    const workspaceScope = { id: "s", brainProfileId: "codex.subscription", projectId: null, canvasId: null, workspaceId: "owner", domainProjectId: undefined, contentUnitId: undefined };
    const working = fixture(value => ({ ...value, session: { ...value.session, ...workspaceScope } }));
    expect((await recoverAgentSession(working.client, workspaceScope, () => true, async () => true)).session.providerThreadId).toBe("original-thread");
    expect(working.calls.map(c => c.method)).toEqual(["GET", "POST", "GET"]);
    for (const patch of [{ workspaceId: "other" }, { workspaceId: undefined }, { projectId: "null" }, { domainProjectId: "old" }, { contentUnitId: "old" }, { canvasId: "old" }]) {
        const denied = fixture(value => ({ ...value, session: { ...value.session, ...workspaceScope, ...patch } }));
        await expect(recoverAgentSession(denied.client, workspaceScope, () => true, async () => true)).rejects.toThrow("身份不一致");
        expect(denied.calls).toHaveLength(1);
    }
});

test.each([
    ["active", value => { value.session.execution.activeTurnId = "running"; }],
    ["resuming", value => { value.session.execution.resuming = true; }],
    ["pending confirmation", value => { value.session.execution.pendingConfirmations = [{ id: "pending" }]; }],
    ["unknown execution", value => { delete value.session.execution; }],
    ["other project", value => { value.session.domainProjectId = "other"; }],
    ["other unit", value => { value.session.contentUnitId = "other"; }],
    ["missing provider", value => { delete value.session.providerThreadId; }],
    ["closed", value => { value.session.status = "closed"; }],
])("%s refuses recovery before any POST", async (_label, mutate) => {
    const { calls, client } = fixture(value => { mutate(value); return value; });
    await expect(recoverAgentSession(client, scope, () => true, async () => true)).rejects.toThrow();
    expect(calls).toHaveLength(1);
});

test("failed context sync or a view switch before resume never posts", async () => {
    const failed = fixture();
    await expect(recoverAgentSession(failed.client, scope, () => true, async () => false)).rejects.toThrow("同步失败");
    expect(failed.calls).toHaveLength(1);
    let current = true;
    const switched = fixture();
    await expect(recoverAgentSession(switched.client, scope, () => current, async () => { current = false; return true; })).rejects.toThrow("已切换");
    expect(switched.calls).toHaveLength(1);
});

test.each([2, 3])("scope switch after request %i discards late result without retry", async turn => {
    let current = true;
    const { calls, client } = fixture((value, count) => { if (count === turn) current = false; return value; });
    await expect(recoverAgentSession(client, scope, () => current, async () => true)).rejects.toThrow("已切换");
    expect(calls).toHaveLength(turn);
});

test.each([2, 3])("different provider thread in response %i cannot count as recovery", async turn => {
    const { client } = fixture((value, count) => { if (count === turn) value.session.providerThreadId = "new-thread"; return value; });
    await expect(recoverAgentSession(client, scope, () => true, async () => true)).rejects.toThrow("会话身份");
});

test("errors keep exact code/status and only trusted codes select guidance", async () => {
    const client = new AgentSessionClient({ request: async () => new Response(JSON.stringify({ ok: false, code: "agent_grant_refresh_required", message: "expired" }), { status: 409 }) });
    let error;
    try { await client.getSession("s"); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(AgentRuntimeRequestError);
    expect(error.code).toBe("agent_grant_refresh_required"); expect(error.status).toBe(409);
    expect(agentFailureText(error)).toContain("不是 Codex 订阅掉线");
    expect(agentFailureGuidance("canvas_backend_http_400")).toContain("恢复授权不能修正参数");
    expect(agentFailureGuidance("canvas_backend_http_401")).toContain("工作台登录态");
    expect(agentFailureGuidance("canvas_backend_http_404")).toContain("不代表保存一定没发生");
    expect(agentFailureGuidance("agent_context_stale")).toContain("旧参数");
    expect(agentFailureGuidance("agent_confirmation_unavailable")).toContain("不重复批准");
    const narrative = new Error("assistant says agent_grant_refresh_required");
    expect(agentFailureText(narrative)).toBe(narrative.message);
    expect(agentFailureGuidance("unknown")).toBe("");
});

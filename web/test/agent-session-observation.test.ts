import { expect, test } from "bun:test";
import { AgentSessionClient } from "../src/film/agent/agent-client";

test("execution and provider history observations use signed read paths, never resume or dispatch", async () => {
    const calls: Array<{ path: string; method?: string; body?: BodyInit | null }> = [];
    const execution = { activeTurnId: "still-running", resuming: false, pendingConfirmations: [] };
    const client = new AgentSessionClient({ request: async (path, init = {}) => {
        calls.push({ path, method: init.method, body: init.body });
        return Response.json({ ok: true, session: { id: "existing", execution }, history: [{ id: "native-item", text: "still working" }], historyStatus: { source: "provider", complete: true } });
    } });
    expect((await client.getSession("existing")).session.execution).toEqual(execution);
    expect((await client.readHistory("existing")).history[0].id).toBe("native-item");
    expect(calls).toEqual([
        { path: "/agent/sessions/existing", method: "GET", body: undefined },
        { path: "/agent/sessions/existing/history", method: "GET", body: undefined },
    ]);
});

test("public failure keeps both stable classification and readable recovery guidance", async () => {
    let requests = 0;
    const client = new AgentSessionClient({ request: async () => {
        requests++;
        return Response.json({ ok: false, code: "agent_confirmation_unavailable", message: "确认已失效；先回读，不重复保存" }, { status: 409 });
    } });
    await expect(client.decideConfirmation("expired", { sessionId: "existing", approved: true })).rejects.toThrow("agent_confirmation_unavailable: 确认已失效；先回读，不重复保存");
    expect(requests).toBe(1);
});

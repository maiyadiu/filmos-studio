import { expect, test } from "bun:test";
import { AgentSessionClient, type BrainSessionView, type SourceTaskInput } from "../src/film/agent/agent-client";
import { changeSourceScope } from "../src/film/agent/source-maintenance-action";

const scope = { id: "original", brainProfileId: "codex.subscription", projectId: "canvas", canvasId: "canvas", domainProjectId: "project" };
const input: SourceTaskInput = { requestId: "task-once", purpose: "Repair fixture", files: [{ path: "web/src/view.ts", expectedHash: "a".repeat(64) }] };
function fixture() {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    let session: BrainSessionView = { ...scope, conversationId: "conversation", providerThreadId: "native-original", status: "ready", updatedAt: "now", execution: { activeTurnId: null, resuming: false, pendingConfirmations: [] } };
    let live = false;
    const intercept = { run: (_path: string) => {} };
    const client = new AgentSessionClient({ request: async (path, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, method: init.method || "GET", body });
        intercept.run(path);
        if (path === "/agent/sessions/original") return Response.json({ ok: true, session });
        if (path === "/agent/sessions/original/source-task") return Response.json({ ok: true, source: { record: session.sourceMaintenance ?? null, live, note: "fixture" } });
        if (path.endsWith("/open")) {
            live = true;
            session = { ...session, sourceMaintenance: { id: "record-one", requestId: body.requestId, purpose: body.purpose, sourceHead: "b".repeat(40), status: "active", expiresAt: new Date(Date.now() + 60_000).toISOString(), files: input.files.map(file => ({ path: file.path, initialHash: file.expectedHash, currentHash: file.expectedHash })), patches: [] } };
        } else if (path.endsWith("/close")) {
            live = false; session = { ...session, sourceMaintenance: { ...session.sourceMaintenance!, status: "closed" } };
        } else if (!path.endsWith("/reconcile") && !path.endsWith("/resume")) throw new Error(`UNEXPECTED:${path}`);
        return Response.json({ ok: true, session, source: { record: session.sourceMaintenance, live, note: "fixture" } });
    } });
    return { client, calls, intercept, update: (patch: Partial<BrainSessionView>) => { session = { ...session, ...patch }; } };
}

test("maintenance open/readback/close stays on the original thread without creating or sending", async () => {
    const f = fixture();
    const opened = await changeSourceScope(f.client, scope, { kind: "open", input }, () => true, async () => true);
    expect(opened.source.record?.requestId).toBe(input.requestId);
    expect(opened.session.providerThreadId).toBe("native-original");
    const closed = await changeSourceScope(f.client, scope, { kind: "close" }, () => true, async () => true);
    expect(closed.source.record?.status).toBe("closed");
    expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual(["/agent/sessions/original/source-task/open", "/agent/sessions/original/source-task/close"]);
    expect(f.calls.find(call => call.path.endsWith("/open"))!.body).toEqual(input);
});

test("unknown, running, pending or foreign sessions cannot open maintenance", async () => {
    for (const patch of [{ execution: undefined }, { projectId: "other" }, { providerThreadId: undefined }, { status: "closed" }, { execution: { activeTurnId: "busy", resuming: false, pendingConfirmations: [] } }, { execution: { activeTurnId: null, resuming: true, pendingConfirmations: [] } }]) {
        const f = fixture(); f.update(patch);
        await expect(changeSourceScope(f.client, scope, { kind: "open", input }, () => true, async () => true)).rejects.toThrow();
        expect(f.calls.every(call => call.method === "GET")).toBe(true);
    }
});

test("scope switch during sync stops before the only mutation", async () => {
    const f = fixture(); let current = true;
    await expect(changeSourceScope(f.client, scope, { kind: "open", input }, () => current, async () => { current = false; return true; })).rejects.toThrow("切换");
    expect(f.calls).toHaveLength(1);
});

test("uncertain POST response is never retried and a late scope result is rejected", async () => {
    for (const fail of [true, false]) {
        const f = fixture(); let current = true;
        f.intercept.run = path => { if (path.endsWith("/open")) { if (fail) throw new Error("response lost"); current = false; } };
        await expect(changeSourceScope(f.client, scope, { kind: "open", input }, () => current, async () => true)).rejects.toThrow();
        expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    }
});

test("readback rejects a replaced provider thread", async () => {
    const f = fixture();
    f.intercept.run = path => { if (path.endsWith("/open")) f.update({ providerThreadId: "replacement" }); };
    await expect(changeSourceScope(f.client, scope, { kind: "open", input }, () => true, async () => true)).rejects.toThrow("身份变化");
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("explicit recovery without a source record resumes the original session, without a task or turn", async () => {
    const f = fixture();
    await changeSourceScope(f.client, scope, { kind: "close" }, () => true, async () => true);
    expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual(["/agent/sessions/original/resume"]);
});

test("source inspection and paging use the existing signed client with exact bodies", async () => {
    const calls: unknown[] = [], signal = new AbortController().signal;
    const client = new AgentSessionClient({ request: async (path, init = {}) => { calls.push([path, init.method, init.body ? JSON.parse(String(init.body)) : null, init.signal === signal]); return Response.json({ ok: true, result: {} }); } });
    await client.inspectSource(signal);
    await client.listSourceFiles({ prefix: "web/src/", offset: 60, limit: 60 }, signal);
    await client.readSourceFile({ path: "web/src/view.ts", lineCount: 1 }, signal);
    expect(calls).toEqual([["/agent/source", "GET", null, true], ["/agent/source/files", "POST", { prefix: "web/src/", offset: 60, limit: 60 }, true], ["/agent/source/read", "POST", { path: "web/src/view.ts", lineCount: 1 }, true]]);
});

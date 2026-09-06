import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexAppServerClient } from "../src/brains/adapters/codex-app-server-client.js";

test("workbench start and resume disable inherited MCP servers only in thread config", async () => {
    const stdout = new PassThrough();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let inheritedServers: Record<string, unknown> = { yingce: {}, old_remote: { url: "https://unused.invalid" } };
    const child = Object.assign(new EventEmitter(), {
        stdout, stderr: new PassThrough(), exitCode: 0,
        stdin: new Writable({ write(chunk, _encoding, callback) {
            const request = JSON.parse(String(chunk));
            requests.push(request);
            const result = request.method === "config/read"
                ? { config: { mcp_servers: inheritedServers } }
                : request.method.startsWith("thread/") ? { thread: { id: "isolated" } } : {};
            if (request.id) queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
            callback();
        } }),
    });
    const client = await CodexAppServerClient.start({ command: "unused", args: [], version: "test", emit: () => undefined, spawnProcess: (() => child) as never });
    const policy = { approvalPolicy: "on-request", sandbox: "read-only", isolateWorkbenchTools: true } as const;
    const original = { "mcp_servers.yingce.command": "fixture", "features.apps": false };
    await client.startThread("/tmp/creative", original, undefined, policy);
    await client.resumeThread("isolated", "/tmp/creative", original, undefined, policy);
    const reads = requests.filter(r => r.method === "config/read");
    assert.equal(reads.length, 2);
    assert.deepEqual(reads[0].params, { includeLayers: false, cwd: "/tmp/creative" });
    for (const request of requests.filter(r => r.method === "thread/start" || r.method === "thread/resume")) {
        assert.deepEqual(request.params.config, { ...original, "mcp_servers.old_remote.enabled": false });
    }
    assert.equal(Object.keys(original).length, 2);
    await client.startThread("/tmp/review", original);
    assert.equal(requests.filter(r => r.method === "config/read").length, 2);
    assert.equal(requests.some(r => r.method.startsWith("config/") && r.method !== "config/read"), false);
    inheritedServers = { "unsupported.dot": { command: "unused" } };
    const started = requests.filter(r => r.method === "thread/start").length;
    await assert.rejects(client.startThread("/tmp/creative", original, undefined, policy), /CODEX_WORKBENCH_CONFIG_UNAVAILABLE/);
    assert.equal(requests.filter(r => r.method === "thread/start").length, started);
    await client.dispose();
});

test("stdio notifications forward native plan and exact text snapshots scoped by provider turn", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
        stdout, stderr: new PassThrough(), exitCode: 0,
        stdin: new Writable({ write(chunk, _encoding, callback) {
            const request = JSON.parse(String(chunk));
            if (request.method === "initialize") queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n"));
            callback();
        } }),
    });
    const events: Record<string, unknown>[] = [];
    const client = await CodexAppServerClient.start({ command: "unused", args: [], version: "test", emit: () => undefined, spawnProcess: (() => child) as never });
    client.bindThread("thread", { emit: (type, value) => { if (type === "agent_event") events.push(value as Record<string, unknown>); } });
    const notify = (method: string, params: Record<string, unknown>) => stdout.write(JSON.stringify({ method, params: { threadId: "thread", turnId: "turn-1", ...params } }) + "\n");
    notify("turn/plan/updated", { plan: [{ step: "读取", status: "inProgress" }], explanation: "同一章节" });
    for (const delta of ["哈", "哈", "\n\n"]) notify("item/agentMessage/delta", { itemId: "a", delta });
    notify("item/completed", { item: { id: "a", type: "agentMessage", text: "哈哈\n\n正文" } });
    notify("item/agentMessage/delta", { turnId: "turn-2", itemId: "a", delta: "新轮" });
    assert.deepEqual(events[0].plan, [{ step: "读取", status: "inProgress" }]);
    assert.equal(events[0].type, "turn.plan.updated");
    assert.equal(events[0].providerTurnId, "turn-1");
    assert.equal(events[3].delta, "\n\n");
    assert.equal((events[3].item as { text: string }).text, "哈哈\n\n");
    assert.equal((events[4].item as { text: string }).text, "哈哈\n\n正文");
    assert.equal((events[5].item as { text: string }).text, "新轮");
    assert.equal(events[5].providerTurnId, "turn-2");
    await client.dispose();
});

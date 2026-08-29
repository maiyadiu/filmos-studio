import { describe, expect, test } from "bun:test";

import { AgentSessionClient } from "./agent-client.ts";

describe("generic Agent Session client", () => {
    test("sends only conversation/profile while Runtime injects trusted scope and identity", async () => {
        const calls = [];
        const client = new AgentSessionClient({ request: async (path, init) => {
            calls.push({ path, init });
            return new Response(JSON.stringify({ ok: true, session: { id: "s", conversationId: "c", brainProfileId: "codex.subscription", projectId: "p", canvasId: "x", status: "ready", updatedAt: "now" } }), { status: 200 });
        } });
        await client.createSession({ conversationId: "c", brainProfileId: "codex.subscription" });
        expect(calls[0].path).toBe("/agent/sessions");
        expect(JSON.parse(calls[0].init.body)).toEqual({ conversationId: "c", brainProfileId: "codex.subscription" });
    });

    test("keeps session and turn identity in the path and sends no bearer credential", async () => {
        const calls = [];
        const client = new AgentSessionClient({ request: async (path, init) => {
            calls.push({ path, init });
            return new Response(JSON.stringify({ ok: true, session: {}, contextReceiptId: "r", result: {} }), { status: 200 });
        } });
        await client.sendTurn("session/a", { turnId: "turn-1", prompt: "读取当前镜头" });
        expect(calls[0].path).toBe("/agent/sessions/session%2Fa/turns");
        expect(new Headers(calls[0].init.headers).has("authorization")).toBe(false);
    });

    test("sorts signed session filters in canonical query-key order", async () => {
        const calls = [];
        const client = new AgentSessionClient({ request: async (path, init) => {
            calls.push({ path, init });
            return new Response(JSON.stringify({ ok: true, sessions: [] }), { status: 200 });
        } });
        await client.listSessions({ projectId: "canvas-a", brainProfileId: "codex.subscription" });
        expect(calls[0].path).toBe("/agent/sessions?brainProfileId=codex.subscription&projectId=canvas-a");
    });
});

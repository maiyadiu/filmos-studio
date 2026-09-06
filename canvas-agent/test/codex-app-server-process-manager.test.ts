import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerProcessManager, codexInvocation } from "../src/brains/adapters/codex-app-server-process-manager.js";

test("Codex app-server process is reused and cleanly replaced after exit or restart", async () => {
    const clients: Array<{ disposed: boolean; dispose(): Promise<void>; readAccount(): Promise<unknown>; readRateLimits(): Promise<unknown>; startChatGPTLogin(): Promise<unknown>; logoutAccount(): Promise<unknown> }> = [];
    let exit: (() => void) | undefined;
    const manager = new CodexAppServerProcessManager(() => undefined, async (options) => {
        exit = options.onExit;
        const client = {
            disposed: false,
            async dispose() { this.disposed = true; },
            async readAccount() { return { account: { type: "chatgpt" } }; },
            async readRateLimits() { return { rateLimits: {} }; },
            async startChatGPTLogin() { return { type: "chatgpt", authUrl: "https://auth.example", loginId: "login-1" }; },
            async logoutAccount() { return {}; },
        };
        clients.push(client);
        return client as never;
    });
    assert.equal(await manager.client(), await manager.client());
    assert.equal(clients.length, 1);
    await manager.probe();
    assert.deepEqual(await manager.startChatGPTLogin(), { type: "chatgpt", authUrl: "https://auth.example", loginId: "login-1" });
    assert.deepEqual(await manager.logoutAccount(), {});
    exit?.();
    assert.notEqual(await manager.client(), clients[0]);
    assert.equal(clients.length, 2);
    await manager.restart();
    assert.equal(clients[1]?.disposed, true);
    assert.equal(clients.length, 3);
    await manager.dispose();
    assert.equal(clients[2]?.disposed, true);
});

test("Codex app-server accepts an explicit native executable for packaged Desktop", () => {
    const previous = process.env.FILMOS_CODEX_EXECUTABLE;
    process.env.FILMOS_CODEX_EXECUTABLE = process.execPath;
    try {
        assert.deepEqual(codexInvocation(), { command: process.execPath, args: [], source: "explicit" });
    } finally {
        if (previous === undefined) delete process.env.FILMOS_CODEX_EXECUTABLE;
        else process.env.FILMOS_CODEX_EXECUTABLE = previous;
    }
});

test("grant rotation replaces only its session process and disposal releases every owned client", async () => {
    const started: Array<{ disposed: boolean; dispose(): Promise<void> }> = [];
    const manager = new CodexAppServerProcessManager(() => undefined, async () => {
        const client = { disposed: false, async dispose() { this.disposed = true; } };
        started.push(client);
        return client as never;
    });
    const account = await manager.client();
    const a = await manager.client("session-a"), b = await manager.client("session-b");
    assert.equal(await manager.client("session-a"), a);
    const rotated = await manager.client("session-a", true);
    assert.notEqual(rotated, a);
    assert.equal(started[1].disposed, true);
    assert.equal(await manager.client("session-b"), b);
    assert.equal(await manager.client(), account);
    assert.equal(started[0].disposed, false);
    assert.equal(started[2].disposed, false);
    await manager.releaseSession("session-a");
    assert.equal(started[3].disposed, true);
    await manager.dispose();
    assert.equal(started.every(client => client.disposed), true);
});

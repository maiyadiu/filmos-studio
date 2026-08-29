import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerProcessManager } from "../src/brains/adapters/codex-app-server-process-manager.js";

test("Codex app-server process is reused and cleanly replaced after exit or restart", async () => {
    const clients: Array<{ disposed: boolean; dispose(): Promise<void>; readAccount(): Promise<unknown>; readRateLimits(): Promise<unknown> }> = [];
    let exit: (() => void) | undefined;
    const manager = new CodexAppServerProcessManager(() => undefined, async (options) => {
        exit = options.onExit;
        const client = {
            disposed: false,
            async dispose() { this.disposed = true; },
            async readAccount() { return { account: { type: "chatgpt" } }; },
            async readRateLimits() { return { rateLimits: {} }; },
        };
        clients.push(client);
        return client as never;
    });
    assert.equal(await manager.client(), await manager.client());
    assert.equal(clients.length, 1);
    await manager.probe();
    exit?.();
    assert.notEqual(await manager.client(), clients[0]);
    assert.equal(clients.length, 2);
    await manager.restart();
    assert.equal(clients[1]?.disposed, true);
    assert.equal(clients.length, 3);
    await manager.dispose();
    assert.equal(clients[2]?.disposed, true);
});

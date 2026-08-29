import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonBrainSessionStore, MemoryBrainSessionStore } from "../src/brains/session-store.js";

test("legacy activeThreadId is copied idempotently into a persistent Codex BrainSession without changing legacy config", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-brain-session-"));
    const file = path.join(directory, "brain-sessions.v1.json");
    const legacy = { "canvas-a": { activeThreadId: "thread-existing-001", workspacePath: "/private/ignored" } };
    try {
        const first = new JsonBrainSessionStore(file, legacy);
        const migrated = await first.listSessions();
        assert.equal(migrated.length, 1);
        assert.equal(migrated[0]?.providerThreadId, "thread-existing-001");
        assert.equal(migrated[0]?.brainProfileId, "codex.subscription");
        assert.equal(migrated[0]?.status, "interrupted");
        assert.equal(legacy["canvas-a"].activeThreadId, "thread-existing-001");
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);

        const restarted = new JsonBrainSessionStore(file, legacy);
        assert.equal((await restarted.listSessions()).length, 1);
        assert.deepEqual(restarted.migrationSnapshot(), first.migrationSnapshot());
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, "1");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("restart recovers in-flight sessions as interrupted while rollback can ignore the new store", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-brain-restart-"));
    const file = path.join(directory, "brain-sessions.v1.json");
    try {
        const store = new JsonBrainSessionStore(file);
        await store.saveSession({
            id: "session-running",
            conversationId: "conversation-running",
            brainProfileId: "codex.subscription",
            connectionId: "codex.subscription",
            projectId: "project-a",
            canvasId: "canvas-a",
            providerThreadId: "thread-a",
            permissionGrantId: "expired-grant",
            status: "running",
            createdAt: "2026-08-29T00:00:00.000Z",
            updatedAt: "2026-08-29T00:00:00.000Z"
        });
        const restarted = new JsonBrainSessionStore(file);
        assert.equal((await restarted.getSession("session-running"))?.status, "interrupted");
        assert.equal((await new MemoryBrainSessionStore().listSessions()).length, 0, "rollback ignores but never deletes the persistent store");
        assert.equal(fs.existsSync(file), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

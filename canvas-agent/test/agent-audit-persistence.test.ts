import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlAgentAuditSink, type AgentAuditRecord } from "../src/brains/agent-audit.js";

test("native Agent audit appends canonical private JSONL without raw prompt or credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "filmos-agent-audit-"));
    const file = path.join(root, "audit.jsonl");
    const record: AgentAuditRecord = {
        eventId: "event-1",
        recordedAt: "2026-08-29T00:00:00.000Z",
        requestId: "request-1",
        sessionId: "session-1",
        turnId: "turn-1",
        projectId: "project-1",
        connectionId: "codex.subscription",
        profileId: "codex.subscription",
        transport: "codex_app_server",
        billingMode: "subscription",
        interactionSurface: "native_stream",
        toolName: "__brain_turn__",
        toolRisk: "read",
        contextReceiptId: "receipt-1",
        proposedBy: { kind: "brain", profileId: "codex.subscription", sessionId: "session-1" },
        appliedBy: null,
        outcome: "succeeded",
        inputHash: "a".repeat(64),
        outputHash: null,
        confirmationId: null,
        errorCode: null,
    };
    try {
        const sink = new JsonlAgentAuditSink(file);
        await Promise.all([sink.append(record), sink.append({ ...record, eventId: "event-2" })]);
        const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(lines.map((item) => item.eventId), ["event-1", "event-2"]);
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        assert.doesNotMatch(await fs.readFile(file, "utf8"), /prompt|authorization|cookie|api.?key/i);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

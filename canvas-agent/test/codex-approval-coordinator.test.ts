import assert from "node:assert/strict";
import test from "node:test";

import { CodexApprovalCoordinator } from "../src/brains/codex-approval-coordinator.js";

test("Codex approval stays pending, is session-bound, and resolves only after a FilmOS decision", async () => {
    const events: unknown[] = [];
    const coordinator = new CodexApprovalCoordinator(undefined, (type, payload) => events.push({ type, payload }), 1_000);
    const pending = coordinator.request({
        sessionId: "session-1",
        contextReceiptId: "receipt-1",
        request: { id: 7, method: "item/commandExecution/requestApproval", params: { command: "touch forbidden" }, threadId: "thread-1", turnId: "turn-1" },
    });
    const event = events[0] as { payload: { confirmation: { id: string; status: string } } };
    assert.equal(event.payload.confirmation.status, "pending");
    assert.throws(() => coordinator.decide({ confirmationId: event.payload.confirmation.id, sessionId: "session-2", actorId: "human", approved: true }), /SESSION_MISMATCH/);
    coordinator.decide({ confirmationId: event.payload.confirmation.id, sessionId: "session-1", actorId: "human", approved: false });
    assert.deepEqual(await pending, { approved: false });
});

test("Codex approval times out closed", async () => {
    const coordinator = new CodexApprovalCoordinator(undefined, () => undefined, 10);
    const decision = await coordinator.request({
        sessionId: "session-1",
        contextReceiptId: "receipt-1",
        request: { id: 8, method: "mcpServer/elicitation/request", params: {} },
    });
    assert.deepEqual(decision, { approved: false });
});

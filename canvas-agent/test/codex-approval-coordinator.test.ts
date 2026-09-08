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
    const events: Array<{ type: string; payload: unknown }> = [];
    const coordinator = new CodexApprovalCoordinator(undefined, (type, payload) => events.push({ type, payload }), 10);
    const decision = await coordinator.request({
        sessionId: "session-1",
        contextReceiptId: "receipt-1",
        request: { id: 8, method: "mcpServer/elicitation/request", params: {} },
    });
    assert.deepEqual(decision, { approved: false });
    const event = events[0].payload as { confirmation: { id: string } };
    assert.equal(coordinator.owns(event.confirmation.id), true);
    assert.throws(() => coordinator.decide({ confirmationId: event.confirmation.id, sessionId: "session-1", actorId: "human", approved: true }), /CONFIRMATION_NOT_FOUND/);
    assert.equal(events[1].type, "agent_event");
    assert.equal((events[1].payload as { type: string }).type, "error");
    assert.equal((events[1].payload as { sessionId: string }).sessionId, "session-1");
    assert.equal((events[1].payload as { code: string }).code, "agent_confirmation_unavailable");
    assert.match((events[1].payload as { message: string }).message, /超时.*不代表用户点击了拒绝/);
});

test("native approval can be answered immediately when published and is consumed once", async () => {
    let id = "";
    const coordinator = new CodexApprovalCoordinator(undefined, (type, payload) => {
        if (type !== "agent_event") return;
        id = (payload as { confirmation: { id: string } }).confirmation.id;
        assert.equal(coordinator.owns(id), true);
        coordinator.decide({ confirmationId: id, sessionId: "session-1", actorId: "human", approved: true });
    }, 1_000);
    try {
        assert.deepEqual(await coordinator.request({ sessionId: "session-1", contextReceiptId: "receipt-1", request: { id: 9, method: "item/fileChange/requestApproval", params: {} } }), { approved: true });
        assert.equal(coordinator.owns(id), true);
        assert.equal(coordinator.owns("unknown"), false);
        assert.throws(() => coordinator.decide({ confirmationId: id, sessionId: "session-1", actorId: "human", approved: true }), /CONFIRMATION_NOT_FOUND/);
    } finally { coordinator.dispose(); }
});

test("cancelling one native session does not resolve another session approval", async () => {
    const ids: string[] = [];
    const coordinator = new CodexApprovalCoordinator(undefined, (_type, payload) => ids.push((payload as { confirmation: { id: string } }).confirmation.id), 1_000);
    const request = (sessionId: string) => coordinator.request({ sessionId, contextReceiptId: "receipt-1", request: { id: sessionId, method: "item/fileChange/requestApproval", params: {} } });
    try {
        const first = request("session-1");
        const second = request("session-2");
        coordinator.cancelSession("session-1");
        assert.deepEqual(await first, { approved: false });
        assert.throws(() => coordinator.decide({ confirmationId: ids[0], sessionId: "session-1", actorId: "human", approved: true }), /CONFIRMATION_NOT_FOUND/);
        coordinator.decide({ confirmationId: ids[1], sessionId: "session-2", actorId: "human", approved: true });
        assert.deepEqual(await second, { approved: true });
    } finally { coordinator.dispose(); }
});

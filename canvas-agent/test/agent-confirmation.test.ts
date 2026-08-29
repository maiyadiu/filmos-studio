import assert from "node:assert/strict";
import test from "node:test";

import { AgentConfirmationStore } from "../src/brains/confirmations.js";

test("confirmation can only be decided and consumed once by its owning session", () => {
    const store = new AgentConfirmationStore();
    const confirmation = store.create({ sessionId: "session-1", turnId: "turn-1", requestId: "request-1", toolName: "film_apply", risk: "approval", title: "正式应用", summary: "应用预览差异", contextReceiptId: "receipt-1" });

    assert.throws(() => store.decide(confirmation.id, { sessionId: "session-2", actorId: "actor-2", approved: true }), /SESSION_MISMATCH/);
    assert.equal(store.decide(confirmation.id, { sessionId: "session-1", actorId: "actor-1", approved: true }).status, "approved");
    assert.throws(() => store.decide(confirmation.id, { sessionId: "session-1", actorId: "actor-1", approved: true }), /ALREADY_DECIDED/);
    assert.equal(store.consume(confirmation.id, { sessionId: "session-1", contextReceiptId: "receipt-1" }).status, "consumed");
    assert.throws(() => store.consume(confirmation.id, { sessionId: "session-1", contextReceiptId: "receipt-1" }), /NOT_APPROVED:consumed/);
});

test("expired confirmation fails closed", () => {
    const store = new AgentConfirmationStore();
    const confirmation = store.create({ sessionId: "session-1", turnId: "turn-1", requestId: "request-1", toolName: "canvas_delete_nodes", risk: "destructive", title: "删除", summary: "删除节点", contextReceiptId: "receipt-1", expiresInMs: 1 });
    assert.throws(() => store.decide(confirmation.id, { sessionId: "session-1", actorId: "actor-1", approved: true, now: new Date(Date.parse(confirmation.expiresAt) + 1) }), /ALREADY_DECIDED:expired/);
});

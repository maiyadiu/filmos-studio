import assert from "node:assert/strict";
import test from "node:test";

import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";

test("permission grant is short-lived, session-scoped and tool-scoped", () => {
    const store = new AgentPermissionGrantStore();
    const grant = store.issue({ sessionId: "session-1", connectionId: "codex.subscription", actorId: "actor-1", projectId: "project-1", toolSurface: "workbench_operator", allowedTools: ["workbench_get_context"], ttlMs: 1000 });

    assert.equal(store.validate(grant.id, { sessionId: "session-1", connectionId: "codex.subscription", projectId: "project-1", toolName: "workbench_get_context", now: new Date(grant.issuedAt) }).nonce, grant.nonce);
    assert.throws(() => store.validate(grant.id, { sessionId: "session-2", connectionId: "codex.subscription", projectId: "project-1" }), /SCOPE_MISMATCH/);
    assert.throws(() => store.validate(grant.id, { sessionId: "session-1", connectionId: "codex.subscription", projectId: "project-1", toolName: "canvas_apply_ops" }), /TOOL_NOT_GRANTED/);
    assert.throws(() => store.validate(grant.id, { sessionId: "session-1", connectionId: "codex.subscription", projectId: "project-1", now: new Date(Date.parse(grant.expiresAt) + 1) }), /EXPIRED/);
});

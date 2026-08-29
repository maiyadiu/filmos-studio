import assert from "node:assert/strict";
import test from "node:test";

import { AgentConfirmationStore } from "../src/brains/confirmations.js";
import { AgentContextBroker } from "../src/brains/context-broker.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { BrainProfileRegistry } from "../src/brains/registry.js";
import { AgentSessionManager } from "../src/brains/session-manager.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import { adapter, profile } from "./brain-test-fixtures.js";

test("mock Codex, API and Hosted adapters create isolated sessions in one registry", async () => {
    const calls: string[] = [];
    const registry = new BrainProfileRegistry();
    const ids = ["codex.mock", "api.mock", "hosted.mock"] as const;
    registry.registerProfile(profile(ids[0], "openai.codex"));
    registry.registerProfile(profile(ids[1], "openai.gpt"));
    registry.registerProfile(profile(ids[2], "openai.chatgpt"));
    for (const id of ids) registry.registerAdapter(adapter(id, calls));
    const store = new MemoryBrainSessionStore();
    const manager = new AgentSessionManager(registry, store, new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());

    const sessions = await Promise.all(ids.map((brainProfileId, index) => manager.createSession({
        conversationId: `conversation-${index}`,
        brainProfileId,
        projectId: `project-${index}`,
        canvasId: `canvas-${index}`,
        actorId: "actor-1",
    })));

    assert.equal(new Set(sessions.map((session) => session.id)).size, 3);
    assert.deepEqual(sessions.map((session) => session.providerThreadId), [
        "codex.mock-thread-project-0",
        "api.mock-thread-project-1",
        "hosted.mock-thread-project-2",
    ]);
    assert.deepEqual(calls, [
        "create:codex.mock:project-0:canvas-0",
        "create:api.mock:project-1:canvas-1",
        "create:hosted.mock:project-2:canvas-2",
    ]);
    assert.equal((await store.listSessions({ projectId: "project-0" }))[0]?.brainProfileId, "codex.mock");
});

test("a failed subscription probe never invokes an API adapter", async () => {
    const apiCalls: string[] = [];
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    registry.registerProfile(profile("api.mock", "openai.gpt"));
    registry.registerAdapter({
        ...adapter("codex.mock"),
        probe: async () => ({ profileId: "codex.mock", status: "needs_auth", statusReason: "not logged in", checkedAt: new Date(0).toISOString() }),
    });
    registry.registerAdapter(adapter("api.mock", apiCalls));
    const manager = new AgentSessionManager(registry, new MemoryBrainSessionStore(), new AgentPermissionGrantStore(), new AgentConfirmationStore(), new AgentContextBroker());

    await assert.rejects(() => manager.createSession({ conversationId: "c", brainProfileId: "codex.mock", projectId: "p", canvasId: "x", actorId: "a" }), /NEEDS_AUTH/);
    assert.deepEqual(apiCalls, []);
});

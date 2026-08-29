import assert from "node:assert/strict";
import test from "node:test";

import { ModelApiBrainAdapter, type ModelApiCompatibilityPort } from "../src/brains/adapters/model-api-brain-adapter.js";
import { LocalModelAdapter } from "../src/brains/adapters/local-model-adapter.js";
import type { AgentPermissionGrant, AgentTurnInput, BrainSession } from "../src/brains/contracts.js";

test("metered API adapter remains dormant until its own profile is explicitly enabled", async () => {
    const calls: string[] = [];
    let enabled = false;
    const adapter = new ModelApiBrainAdapter({ profileId: "openai.api", port: port(calls), explicitlyEnabled: () => enabled });
    assert.equal((await adapter.probe()).status, "unavailable");
    await assert.rejects(() => adapter.createSession(createInput("openai.api"), grant("openai.api")), /EXPLICIT_ENABLE_REQUIRED/);
    assert.deepEqual(calls, []);
    enabled = true;
    assert.equal((await adapter.probe()).status, "ready");
    await adapter.createSession(createInput("openai.api"), grant("openai.api"));
    await adapter.sendTurn(turn("openai.api", ["/tmp/reference.png"]), async () => undefined);
    assert.deepEqual(calls, ["probe:openai.api", "create:openai.api", "turn:openai.api:/tmp/reference.png"]);
});

test("API profiles cannot be silently crossed and local model has an independent adapter", async () => {
    const apiCalls: string[] = [];
    const openai = new ModelApiBrainAdapter({ profileId: "openai.api", port: port(apiCalls), explicitlyEnabled: () => true });
    await assert.rejects(() => openai.sendTurn(turn("deepseek.api"), async () => undefined), /NOT_SELECTED/);
    assert.deepEqual(apiCalls, []);

    const localCalls: string[] = [];
    const local = new LocalModelAdapter(port(localCalls));
    await local.createSession(createInput("local.model"), grant("local.model"));
    await local.sendTurn(turn("local.model"), async () => undefined);
    assert.deepEqual(localCalls, ["create:local.model", "turn:local.model:"]);
});

function port(calls: string[]): ModelApiCompatibilityPort {
    return {
        probe: async (profileId) => { calls.push(`probe:${profileId}`); return { status: "ready" }; },
        createSession: async (input) => { calls.push(`create:${input.brainProfileId}`); return { providerThreadId: `${input.brainProfileId}-thread` }; },
        resumeSession: async (input) => ({ providerThreadId: input.providerThreadId }),
        sendTurn: async (input) => {
            calls.push(`turn:${input.session.brainProfileId}:${(input.localImagePaths || []).join(",")}`);
            return { sessionId: input.session.id, turnId: input.turnId, status: "completed" };
        },
        cancelTurn: async () => undefined,
        closeSession: async () => undefined,
    };
}

function createInput(brainProfileId: string) {
    return { conversationId: "conversation", brainProfileId, projectId: "project", canvasId: "canvas", actorId: "actor" };
}

function grant(connectionId: string): AgentPermissionGrant {
    return { id: "grant", sessionId: "session", connectionId, actorId: "actor", projectId: "project", toolSurface: "workbench_operator", allowedTools: [], issuedAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(), nonce: "nonce" };
}

function turn(brainProfileId: string, localImagePaths: string[] = []): AgentTurnInput {
    const session: BrainSession = { id: "session", conversationId: "conversation", brainProfileId, connectionId: brainProfileId, projectId: "project", canvasId: "canvas", permissionGrantId: "grant", status: "ready", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    return { session, turnId: "turn", prompt: "hello", localImagePaths, context: { contextReceiptId: "receipt" } as AgentTurnInput["context"] };
}

import assert from "node:assert/strict";
import test from "node:test";

import type { LocalRuntimeConfig } from "../src/config.js";
import type { BrowserRuntimeRequest, BrowserRuntimeTransport } from "../src/brains/browser-runtime-port.js";
import { resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { GenericAgentRuntime } from "../src/brains/generic-agent-runtime.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";

test("generic runtime rotates a missing grant for a hydrated and a persisted session", async () => {
    const requests: BrowserRuntimeRequest[] = [];
    const transport: BrowserRuntimeTransport = {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => {
            requests.push(input);
            if (input.operation === "probe") return { status: "ready" } as T;
            if (input.operation === "create_session" || input.operation === "resume_session") {
                return { providerThreadId: `local:${input.sessionId}` } as T;
            }
            if (input.operation === "send_turn") {
                return {
                    result: {
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        providerThreadId: `local:${input.sessionId}`,
                        text: "ok",
                        status: "completed",
                    },
                } as T;
            }
            return { ok: true } as T;
        },
    };
    const store = new MemoryBrainSessionStore();
    const grants = new AgentPermissionGrantStore();
    const first = runtime(store, grants, transport);
    let sessionId = "";
    try {
        const created = await first.createSession({
            conversationId: "grant-recovery",
            brainProfileId: "local.model",
            projectId: "project-grant-recovery",
            canvasId: "canvas-grant-recovery",
            actorId: "owner-grant-recovery",
        });
        sessionId = created.session.id;
        assert.equal(grants.revoke(created.session.permissionGrantId), true);
        const recovered = await first.sendTurn(sessionId, { turnId: "turn-hydrated", prompt: "recover hydrated" }, () => undefined);
        assert.equal(recovered.result.status, "completed");
        assert.notEqual(recovered.session?.permissionGrantId, created.session.permissionGrantId);
        assert.equal(requests.filter((item) => item.operation === "resume_session").length, 1);
    } finally {
        await first.dispose();
    }

    const restarted = runtime(store, new AgentPermissionGrantStore(), transport);
    try {
        const recovered = await restarted.sendTurn(sessionId, { turnId: "turn-restart", prompt: "recover persisted" }, () => undefined);
        assert.equal(recovered.result.status, "completed");
        assert.equal(requests.filter((item) => item.operation === "resume_session").length, 2);
    } finally {
        await restarted.dispose();
    }
});

function runtime(store: MemoryBrainSessionStore, grants: AgentPermissionGrantStore, browserRuntime: BrowserRuntimeTransport) {
    return new GenericAgentRuntime(
        config(),
        () => undefined,
        () => ({
            projectId: "project-grant-recovery",
            canvasId: "canvas-grant-recovery",
            canvasRevision: 1,
            canvasStateHash: "a".repeat(64),
            nodes: [],
            connections: [],
            selectedNodeIds: [],
            visibleNodeIds: [],
            assets: [],
        }),
        async () => ({ approved: true }),
        {
            featureFlags: resolveAgentFeatureFlags({
                "film.agent_generic_runtime": true,
                "film.agent_context_broker": true,
                "film.agent_canonical_tool_manifest": true,
                "film.agent_canonical_tool_broker": true,
                "film.agent_model_api_profiles": true,
                "film.agent_no_silent_api_fallback": true,
                "film.agent_request_scoped_identity": true,
            }, {}),
            browserRuntime,
            store,
            grants,
            persistentAudit: false,
            canvasToolExecutor: { callTool: async () => ({ ok: true }) },
        },
    );
}

function config(): LocalRuntimeConfig {
    return {
        url: "http://127.0.0.1:17371",
        token: "grant-recovery-test-token",
        ownerId: "owner-grant-recovery",
        trustedWebOrigins: ["http://127.0.0.1:43100"],
        browserRegistrations: [],
    };
}

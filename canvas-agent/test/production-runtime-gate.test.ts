import assert from "node:assert/strict";
import test from "node:test";

import type { LocalRuntimeConfig } from "../src/config.js";
import type { BrowserRuntimeRequest, BrowserRuntimeTransport } from "../src/brains/browser-runtime-port.js";
import { resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { GenericAgentRuntime } from "../src/brains/generic-agent-runtime.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import type { WorkbenchContextSnapshot } from "../src/brains/context-broker.js";

test("production GenericAgentRuntime composes every profile and routes sessions through one broker", async () => {
    let snapshot = workbenchSnapshot();
    const events: Array<{ type?: string; confirmation?: { id?: string; sessionId?: string } }> = [];
    const browserRequests: BrowserRuntimeRequest[] = [];
    const transport: BrowserRuntimeTransport = {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => {
            browserRequests.push(input);
            if (input.channel === "chatgpt_host" && input.operation === "probe") return {
                ready: true,
                profileId: "chatgpt.subscription.host",
                billingMode: "subscription_host_no_extra_model_api",
                modelApiAdapterAvailable: false,
                fallbackEnabled: false,
            } as T;
            if (input.channel === "chatgpt_host" && input.operation === "create_session") return {
                hostSessionId: `host:${input.sessionId}`,
                projectGrantId: "project-grant-production-gate",
                projectId: "FilmOS_Acceptance_Project",
                status: "blocked_external_account",
                proposalHandoffEnabled: true,
                directApplyAvailable: false,
            } as T;
            if (input.channel === "model" && input.operation === "probe") return { status: "ready" } as T;
            if (input.channel === "model" && input.operation === "create_session") return { providerThreadId: `browser:${input.profileId}:${input.sessionId}` } as T;
            return { ok: true } as T;
        },
    };
    const executions: Array<{ name: string; input: unknown }> = [];
    const runtime = new GenericAgentRuntime(
        config(),
        (_type, payload) => events.push(payload as { type?: string; confirmation?: { id?: string; sessionId?: string } }),
        () => snapshot,
        async () => ({ approved: true }),
        {
            featureFlags: allFlags(),
            browserRuntime: transport,
            store: new MemoryBrainSessionStore(),
            persistentAudit: false,
            canvasToolExecutor: {
                callTool: async (name, input) => {
                    const toolName = String(name);
                    executions.push({ name: toolName, input });
                    if (toolName === "canvas_create_text_node") {
                        snapshot = { ...snapshot, canvasRevision: 8, canvasStateHash: "b".repeat(64), nodes: [{ id: "controlled-text-node", type: "text", title: "受控写入" }] };
                        return { ok: true, revision: 8, stateHash: snapshot.canvasStateHash, verification: { ok: true }, nodeId: "controlled-text-node" };
                    }
                    return { ok: true, revision: snapshot.canvasRevision, stateHash: snapshot.canvasStateHash };
                },
            },
        },
    );

    try {
        assert.deepEqual(new Set(runtime.composition.enabledProfileIds), new Set([
            "codex.subscription",
            "chatgpt.subscription.host",
            "openai.api",
            "anthropic.api",
            "deepseek.api",
            "local.model",
            "human.only",
        ]));
        assert.deepEqual(new Set(runtime.composition.adapterProfileIds), new Set(runtime.composition.enabledProfileIds));

        const automatedProfiles = ["chatgpt.subscription.host", "openai.api", "anthropic.api", "deepseek.api", "local.model", "human.only"];
        const sessions = new Map<string, Awaited<ReturnType<GenericAgentRuntime["createSession"]>>>();
        for (const profileId of automatedProfiles) {
            sessions.set(profileId, await runtime.createSession({
                conversationId: `conversation:${profileId}`,
                brainProfileId: profileId,
                projectId: "FilmOS_Acceptance_Project",
                canvasId: "acceptance-canvas",
                actorId: "acceptance-human",
            }));
        }

        for (const profileId of ["openai.api", "anthropic.api", "deepseek.api", "local.model", "human.only"]) {
            const session = sessions.get(profileId)!.session;
            const read = await runtime.requestTool({ sessionId: session.id, turnId: `read:${profileId}`, toolName: "canvas_get_state", toolInput: {} });
            assert.equal(read.status, "completed", profileId);
        }
        const chatgpt = sessions.get("chatgpt.subscription.host")!.session;
        assert.equal((await runtime.requestTool({ sessionId: chatgpt.id, turnId: "read:chatgpt", toolName: "workbench_get_context", toolInput: {} })).status, "completed");

        const local = sessions.get("local.model")!.session;
        await runtime.store.updateSession(local.id, { status: "running", updatedAt: new Date().toISOString() });
        const pending = runtime.requestTool({
            sessionId: local.id,
            turnId: "write:local",
            toolName: "canvas_create_text_node",
            toolInput: { title: "受控写入", content: "production composition gate" },
        });
        const confirmation = await waitForConfirmation(events);
        await runtime.decideConfirmation({
            confirmationId: confirmation.id,
            sessionId: local.id,
            actorId: "acceptance-human",
            approved: true,
        });
        assert.equal((await pending).status, "completed");
        await assert.rejects(
            runtime.decideConfirmation({
                confirmationId: confirmation.id,
                sessionId: local.id,
                actorId: "acceptance-human",
                approved: true,
            }),
            /AGENT_CONFIRMATION_WAITER_NOT_FOUND/,
        );
        assert.equal(snapshot.nodes.length, 1);
        assert.equal(executions.filter((item) => item.name === "canvas_create_text_node").length, 1);
        const instrumentation = runtime.instrumentation.snapshot();
        assert.deepEqual(instrumentation, {
            broker_request_count: 7,
            broker_confirmation_count: 1,
            broker_execute_count: 7,
            legacy_direct_execute_count: 0,
        });
        assert.equal(runtime.audit.records.at(-1)?.proposedBy.profileId, "local.model");
        assert.equal(runtime.audit.records.at(-1)?.appliedBy?.actorId, "acceptance-human");
        assert.equal(browserRequests.some((item) => item.profileId === "openai.api"), true);
        assert.equal(browserRequests.some((item) => item.profileId === "local.model"), true);
        console.log(`FILMOS_PRODUCTION_RUNTIME_RECEIPT ${JSON.stringify({
            gate_id: "AGENT-PRODUCTION-COMPOSITION-001",
            status: "PASSED",
            enabled_profile_ids: runtime.composition.enabledProfileIds,
            adapter_profile_ids: runtime.composition.adapterProfileIds,
            session_profile_ids: Array.from(sessions.keys()),
            instrumentation,
            controlled_write_node_count: snapshot.nodes.length,
            controlled_write_execute_count: executions.filter((item) => item.name === "canvas_create_text_node").length,
            canonical_confirmation_count: 1,
            duplicate_confirmation_replay_blocked: true,
            proposed_by: runtime.audit.records.at(-1)?.proposedBy.profileId,
            applied_by: runtime.audit.records.at(-1)?.appliedBy?.actorId,
        })}`);
    } finally {
        await runtime.dispose();
    }
});

async function waitForConfirmation(events: Array<{ type?: string; confirmation?: { id?: string; sessionId?: string } }>) {
    for (let index = 0; index < 50; index += 1) {
        const event = events.find((item) => item.type === "confirmation.required" && item.confirmation?.id);
        if (event?.confirmation?.id && event.confirmation.sessionId) return { id: event.confirmation.id, sessionId: event.confirmation.sessionId };
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("PRODUCTION_CONFIRMATION_NOT_EMITTED");
}

function allFlags() {
    return resolveAgentFeatureFlags({
        "film.agent_native_brain_selector": true,
        "film.agent_generic_runtime": true,
        "film.agent_context_broker": true,
        "film.agent_canonical_tool_manifest": true,
        "film.agent_canonical_tool_broker": true,
        "film.agent_codex_subscription": true,
        "film.agent_chatgpt_host": true,
        "film.agent_model_api_profiles": true,
        "film.agent_no_silent_api_fallback": true,
        "film.agent_request_scoped_identity": true,
    }, {});
}

function config(): LocalRuntimeConfig {
    return {
        url: "http://127.0.0.1:17371",
        token: "production-composition-token",
        ownerId: "production-gate-owner-01",
        trustedWebOrigins: ["http://127.0.0.1:43100"],
        browserRegistrations: [],
    };
}

function workbenchSnapshot(): WorkbenchContextSnapshot {
    return {
        projectId: "FilmOS_Acceptance_Project",
        canvasId: "acceptance-canvas",
        canvasRevision: 7,
        canvasStateHash: "a".repeat(64),
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        visibleNodeIds: [],
        assets: [],
    };
}

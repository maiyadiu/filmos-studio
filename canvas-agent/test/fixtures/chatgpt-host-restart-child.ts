import path from "node:path";

import type { LocalRuntimeConfig } from "../../src/config.js";
import type { BrowserRuntimeRequest, BrowserRuntimeTransport } from "../../src/brains/browser-runtime-port.js";
import type { WorkbenchContextSnapshot } from "../../src/brains/context-broker.js";
import { resolveAgentFeatureFlags } from "../../src/brains/feature-flags.js";
import { GenericAgentRuntime } from "../../src/brains/generic-agent-runtime.js";
import { JsonBrainSessionStore } from "../../src/brains/session-store.js";

const mode = process.argv[2];
const storePath = path.resolve(required(process.argv[3], "storePath"));
const sessionId = process.argv[4] || "";
const ttlMs = Number(process.argv[5] || 3_600_000);
const hostStatus = process.argv[6] || "waiting_for_host";
const requests: BrowserRuntimeRequest[] = [];
const emitted: unknown[] = [];
const transport = browserTransport(requests, ttlMs, mode === "cross-project", hostStatus);
const store = new JsonBrainSessionStore(storePath);
const runtime = new GenericAgentRuntime(
    config(),
    (_type, payload) => emitted.push(payload),
    snapshot,
    async () => ({ approved: false }),
    {
        featureFlags: flags(),
        browserRuntime: transport,
        store,
        persistentAudit: false,
        canvasToolExecutor: { callTool: async () => { throw new Error("LIFECYCLE_GATE_MUST_NOT_CALL_CANVAS_TOOL"); } },
    },
);

try {
    if (mode === "create") {
        const created = await runtime.createSession({
            conversationId: "conversation-chatgpt-lifecycle",
            brainProfileId: "chatgpt.subscription.host",
            projectId: "project-a",
            domainProjectId: "host-project-a",
            canvasId: "canvas-a",
            actorId: "actor-before-restart",
        });
        const result = await runtime.sendTurn(created.session.id, { turnId: "turn-before-restart", prompt: "准备 ChatGPT Handoff" }, (_type, payload) => emitted.push(payload));
        const persisted = await store.getSession(created.session.id);
        output({ mode, sessionId: created.session.id, oldGrantId: created.session.permissionGrantId, providerThreadId: created.session.providerThreadId, persisted, result: result.result, requests, emitted });
    } else if (mode === "resume" || mode === "cross-project") {
        try {
            const resumed = await runtime.resumeSession(required(sessionId, "sessionId"), "actor-after-restart");
            const recovered = structuredClone(resumed.session);
            const result = await runtime.sendTurn(resumed.session.id, { turnId: "turn-after-restart", prompt: "恢复后再准备 Handoff" }, (_type, payload) => emitted.push(payload));
            output({ mode, rejected: false, recovered, history: resumed.history, historyStatus: resumed.historyStatus, result: result.result, requests, emitted });
        } catch (error) {
            const persisted = sessionId ? await store.getSession(sessionId) : undefined;
            output({ mode, rejected: true, error: error instanceof Error ? error.message : String(error), persisted, requests, emitted });
        }
    } else {
        throw new Error(`UNKNOWN_MODE:${mode}`);
    }
} finally {
    await runtime.dispose();
}

function browserTransport(requests: BrowserRuntimeRequest[], ttl: number, crossProject: boolean, resumeHostStatus: string): BrowserRuntimeTransport {
    return {
        hasConnectedBrowser: () => true,
        request: async <T>(request: BrowserRuntimeRequest) => {
            requests.push(structuredClone(request));
            if (request.channel !== "chatgpt_host") throw new Error("MODEL_OR_API_FALLBACK_FORBIDDEN");
            if (request.operation === "probe") return {
                ready: true,
                profileId: "chatgpt.subscription.host",
                billingMode: "subscription_host_no_extra_model_api",
                modelApiAdapterAvailable: false,
                fallbackEnabled: false,
            } as T;
            const input = record(request.payload.input);
            if (request.operation === "create_session") return {
                hostSessionId: `host-session:${request.sessionId}`,
                projectGrantId: "project-grant-a",
                projectId: "host-project-a",
                status: "waiting_for_host",
                proposalHandoffEnabled: true,
                directApplyAvailable: false,
            } as T;
            if (request.operation === "resume_session") {
                const grant = record(input.agentGrant);
                const persistedHandoff = record(input.hostHandoff);
                if (!grant.id || grant.sessionId !== request.sessionId || grant.projectId !== "project-a" || grant.domainProjectId !== "host-project-a") throw new Error("NEW_AGENT_GRANT_MISSING_OR_WRONG_SCOPE");
                if (input.projectId !== "project-a" || input.domainProjectId !== "host-project-a" || input.canvasId !== "canvas-a") throw new Error("PERSISTED_SCOPE_NOT_RESTORED");
                return {
                    hostSessionId: `host-session:${request.sessionId}`,
                    projectGrantId: "project-grant-a",
                    projectId: crossProject ? "host-project-b" : "host-project-a",
                    status: resumeHostStatus,
                    proposalHandoffEnabled: true,
                    directApplyAvailable: false,
                    ...(resumeHostStatus === "observed" ? { observedAt: new Date().toISOString() } : {}),
                    ...(resumeHostStatus === "proposal_received" ? { proposalReceivedAt: new Date().toISOString() } : {}),
                    ...(["observed", "proposal_received"].includes(resumeHostStatus) ? { observedHandoffId: persistedHandoff.handoffId } : {}),
                } as T;
            }
            if (request.operation === "prepare_handoff") {
                const createdAt = new Date();
                return {
                    handoffId: `handoff:${request.turnId}`,
                    hostSessionId: `host-session:${request.sessionId}`,
                    projectId: "host-project-a",
                    contextReceiptId: input.contextReceiptId,
                    status: "waiting_for_host",
                    directApplyAvailable: false,
                    createdAt: createdAt.toISOString(),
                    expiresAt: new Date(createdAt.getTime() + ttl).toISOString(),
                } as T;
            }
            if (request.operation === "close_session") return { ok: true } as T;
            throw new Error(`CHATGPT_GATE_OPERATION_UNEXPECTED:${request.operation}`);
        },
    };
}

function flags() {
    return resolveAgentFeatureFlags({
        "film.agent_native_brain_selector": true,
        "film.agent_generic_runtime": true,
        "film.agent_context_broker": true,
        "film.agent_canonical_tool_manifest": true,
        "film.agent_canonical_tool_broker": true,
        "film.agent_codex_subscription": false,
        "film.agent_chatgpt_host": true,
        "film.agent_model_api_profiles": false,
        "film.agent_no_silent_api_fallback": true,
        "film.agent_request_scoped_identity": true,
    }, {});
}

function config(): LocalRuntimeConfig {
    return { url: "http://127.0.0.1:17371", token: "lifecycle-gate-token", ownerId: "lifecycle-gate-owner-001", trustedWebOrigins: ["http://127.0.0.1:43100"], browserRegistrations: [] };
}

function snapshot(): WorkbenchContextSnapshot {
    return { projectId: "project-a", domainProjectId: "host-project-a", canvasId: "canvas-a", canvasRevision: 1, canvasStateHash: "a".repeat(64), nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assets: [] };
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function required(value: string | undefined, name: string) { if (!value?.trim()) throw new Error(`REQUIRED:${name}`); return value.trim(); }
function output(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }

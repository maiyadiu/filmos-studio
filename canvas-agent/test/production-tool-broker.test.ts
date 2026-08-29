import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAgentAuditSink } from "../src/brains/agent-audit.js";
import { AgentConfirmationStore } from "../src/brains/confirmations.js";
import { AgentContextBroker, type WorkbenchContextSnapshot } from "../src/brains/context-broker.js";
import type { BrainProfile, BrainSession } from "../src/brains/contracts.js";
import { AgentRuntimeInstrumentation } from "../src/brains/instrumentation.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { AgentPolicyGateway } from "../src/brains/policy-gateway.js";
import { CanonicalAgentToolBroker } from "../src/brains/tool-broker.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";
import { registerProductionToolProviders, type CanonicalToolExecutionMetadata } from "../src/brains/tool-providers.js";

test("production providers route read and confirmed write through one broker without a second browser confirmation", async () => {
    const manifest = new CanonicalAgentToolManifest();
    const grants = new AgentPermissionGrantStore();
    const confirmations = new AgentConfirmationStore();
    const contexts = new AgentContextBroker();
    const audit = new MemoryAgentAuditSink();
    const instrumentation = new AgentRuntimeInstrumentation();
    const profile = codexProfile();
    const session = brainSession();
    const grant = grants.issue({
        sessionId: session.id,
        connectionId: session.connectionId,
        actorId: "codex-agent",
        projectId: session.projectId,
        toolSurface: "workbench_operator",
        allowedTools: manifest.names("workbench_operator"),
    });
    session.permissionGrantId = grant.id;
    const snapshot = workbenchSnapshot();
    const captured = contexts.capture(session, snapshot);
    session.lastContextReceiptId = captured.receipt.receiptId;
    const broker = new CanonicalAgentToolBroker(
        manifest,
        grants,
        confirmations,
        new AgentPolicyGateway(grants, contexts),
        audit,
        instrumentation,
    );
    const calls: Array<{ name: unknown; input: unknown; metadata?: CanonicalToolExecutionMetadata }> = [];
    registerProductionToolProviders({
        broker,
        manifest,
        canvas: {
            callTool: async (name, input, metadata) => {
                calls.push({ name, input, ...(metadata ? { metadata } : {}) });
                return { ok: true, verification: { ok: true }, revision: name === "canvas_create_text_node" ? 8 : 7 };
            },
        },
        snapshot: () => snapshot,
        browserRuntime: {
            hasConnectedBrowser: () => true,
            request: async () => ({ ok: true }),
        },
    });

    const read = await broker.request({
        profile,
        session,
        turnId: "turn-read",
        toolName: "canvas_get_state",
        input: {},
        contextReceiptId: captured.receipt.receiptId,
        currentContext: snapshot,
    });
    assert.equal(read.status, "completed");

    const proposed = await broker.request({
        profile,
        session,
        turnId: "turn-write",
        toolName: "canvas_create_text_node",
        input: { title: "受控写入", content: "P0 production broker" },
        contextReceiptId: captured.receipt.receiptId,
        currentContext: snapshot,
    });
    assert.equal(proposed.status, "confirmation_required");
    if (proposed.status !== "confirmation_required") return;
    assert.equal(calls.length, 1, "write must not reach the browser before canonical confirmation");
    confirmations.decide(proposed.confirmation.id, { sessionId: session.id, actorId: "human-owner", approved: true });
    const completed = await broker.executeConfirmed({
        confirmationId: proposed.confirmation.id,
        profile,
        session,
        currentContext: snapshot,
    });
    assert.equal(completed.status, "completed");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.metadata, {
        canonicalRequestId: proposed.request.requestId,
        canonicalSessionId: session.id,
        canonicalContextReceiptId: captured.receipt.receiptId,
    });
    assert.deepEqual(instrumentation.snapshot(), {
        broker_request_count: 2,
        broker_confirmation_count: 1,
        broker_execute_count: 2,
        legacy_direct_execute_count: 0,
    });
    assert.equal(audit.records.filter((record) => record.outcome === "succeeded").length, 2);
    assert.equal(audit.records.at(-1)?.appliedBy?.actorId, "human-owner");
});

function brainSession(): BrainSession {
    return {
        id: "session-production-broker",
        conversationId: "conversation-production-broker",
        brainProfileId: "codex.subscription",
        connectionId: "codex.subscription",
        projectId: "FilmOS_Acceptance_Project",
        canvasId: "acceptance-canvas",
        permissionGrantId: "pending",
        status: "ready",
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
    };
}

function codexProfile(): BrainProfile {
    return {
        id: "codex.subscription",
        displayName: "Codex",
        provider: "openai.codex",
        transport: "codex_app_server",
        authMode: "chatgpt_managed",
        billingMode: "subscription",
        interactionSurface: "native_stream",
        toolSurface: "workbench_operator",
        requiresApiKey: false,
        mayCreateSeparateCharges: false,
        availability: "enabled",
        capabilities: {
            streamingChat: true,
            threadHistory: true,
            threadResume: true,
            imageInput: true,
            automaticVisualContext: true,
            mcpTools: true,
            read: true,
            preview: true,
            applyAfterHumanConfirmation: true,
            hostedProposalReturn: false,
            cancelTurn: true,
        },
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

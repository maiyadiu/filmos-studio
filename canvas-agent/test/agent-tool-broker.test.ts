import assert from "node:assert/strict";
import test from "node:test";

import { MemoryAgentAuditSink } from "../src/brains/agent-audit.js";
import { AgentConfirmationStore, projectToolConfirmationDetail } from "../src/brains/confirmations.js";
import { AgentContextBroker, type WorkbenchContextSnapshot } from "../src/brains/context-broker.js";
import type { BrainProfile, BrainSession } from "../src/brains/contracts.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { AgentPolicyGateway } from "../src/brains/policy-gateway.js";
import { CanonicalAgentToolBroker } from "../src/brains/tool-broker.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";
import { ProjectToolProvider } from "../src/brains/tool-providers.js";

test("all native adapters receive the same canonical confirmation semantics and trusted identity", async () => {
    for (const profileId of ["codex.subscription", "openai.api", "local.model"] as const) {
        const runtime = setup(profileId);
        const observed: unknown[] = [];
        runtime.broker.register("canvas_update_node", { execute: async (input) => {
            observed.push(input);
            return { output: { changed: true }, postcondition: { canvasRevision: 8 } };
        } });
        const proposed = await runtime.broker.request({
            profile: runtime.profile,
            session: runtime.session,
            turnId: "turn-1",
            toolName: "canvas_update_node",
            input: { id: "node-1", patch: { title: "reframed" }, actorId: "model-spoof", projectId: "project-spoof" },
            contextReceiptId: runtime.receiptId,
            currentContext: runtime.snapshot,
        });
        assert.equal(proposed.status, "confirmation_required");
        if (proposed.status !== "confirmation_required") continue;
        assert.equal(proposed.request.sessionId, runtime.session.id);
        assert.equal(proposed.request.connectionId, runtime.profile.id);
        assert.equal(proposed.request.projectId, runtime.session.projectId);
        assert.equal(observed.length, 0);
        runtime.confirmations.decide(proposed.confirmation.id, { sessionId: runtime.session.id, actorId: "human-reviewer", approved: true });
        const completed = await runtime.broker.executeConfirmed({ confirmationId: proposed.confirmation.id, profile: runtime.profile, session: runtime.session, currentContext: runtime.snapshot });
        assert.equal(completed.status, "completed");
        if (completed.status === "completed") assert.deepEqual(completed.result.postcondition, { canvasRevision: 8 });
        assert.equal(runtime.audit.records.at(-1)?.profileId, runtime.profile.id);
        assert.equal(runtime.audit.records.at(-1)?.billingMode, runtime.profile.billingMode);
        assert.equal(runtime.audit.records.at(-1)?.appliedBy?.actorId, "human-reviewer");
    }
});

test("paid and destructive tools require confirmation even when ordinary confirmation is disabled", async () => {
    for (const toolName of ["canvas_generate_image", "canvas_delete_nodes"]) {
        const runtime = setup("codex.subscription");
        runtime.broker.register(toolName, { execute: async () => ({ output: { impossibleWithoutConfirmation: false } }) });
        const proposed = await runtime.broker.request({
            profile: runtime.profile,
            session: runtime.session,
            turnId: "turn-risk",
            toolName,
            input: toolName === "canvas_delete_nodes" ? { ids: ["node-1"] } : { prompt: "draft" },
            contextReceiptId: runtime.receiptId,
            currentContext: runtime.snapshot,
            ordinaryConfirmationEnabled: false,
        });
        assert.equal(proposed.status, "confirmation_required");
        if (proposed.status === "confirmation_required" && toolName === "canvas_generate_image") {
            assert.match(proposed.confirmation.costPreview?.note || "", /费用/);
        }
    }
});

test("confirmation and context receipts are one-session one-use and stale execution fails closed", async () => {
    const runtime = setup("codex.subscription");
    let executions = 0;
    runtime.broker.register("film_command_apply", { execute: async () => { executions += 1; return { output: { applied: true } }; } });
    const proposed = await runtime.broker.request({
        profile: runtime.profile,
        session: runtime.session,
        turnId: "turn-apply",
        toolName: "film_command_apply",
        input: { command: {}, guards: {}, preview_receipt: "receipt" },
        contextReceiptId: runtime.receiptId,
        currentContext: runtime.snapshot,
    });
    assert.equal(proposed.status, "confirmation_required");
    if (proposed.status !== "confirmation_required") return;
    assert.throws(() => runtime.confirmations.decide(proposed.confirmation.id, { sessionId: "different-session", actorId: "human", approved: true }), /SESSION_MISMATCH/);
    runtime.confirmations.decide(proposed.confirmation.id, { sessionId: runtime.session.id, actorId: "human", approved: true });
    await assert.rejects(
        () => runtime.broker.executeConfirmed({
            confirmationId: proposed.confirmation.id,
            profile: runtime.profile,
            session: runtime.session,
            currentContext: { ...runtime.snapshot, canvasRevision: runtime.snapshot.canvasRevision + 1 },
        }),
        /CANVAS_STALE/,
    );
    assert.equal(executions, 0);
    await assert.rejects(
        () => runtime.broker.executeConfirmed({ confirmationId: proposed.confirmation.id, profile: runtime.profile, session: runtime.session, currentContext: runtime.snapshot }),
        /NOT_APPROVED|PENDING_PROPOSAL_NOT_FOUND/,
    );
});

test("a write cannot be reported successful without a verifiable postcondition", async () => {
    const runtime = setup("codex.subscription");
    runtime.broker.register("canvas_update_node", { execute: async () => ({ output: { changed: true } }) });
    const proposed = await runtime.broker.request({
        profile: runtime.profile,
        session: runtime.session,
        turnId: "turn-postcondition",
        toolName: "canvas_update_node",
        input: { id: "node-1", patch: { title: "new" } },
        contextReceiptId: runtime.receiptId,
        currentContext: runtime.snapshot,
    });
    assert.equal(proposed.status, "confirmation_required");
    if (proposed.status !== "confirmation_required") return;
    runtime.confirmations.decide(proposed.confirmation.id, { sessionId: runtime.session.id, actorId: "human", approved: true });
    await assert.rejects(
        () => runtime.broker.executeConfirmed({ confirmationId: proposed.confirmation.id, profile: runtime.profile, session: runtime.session, currentContext: runtime.snapshot }),
        /POSTCONDITION_REQUIRED/,
    );
    assert.equal(runtime.audit.records.at(-1)?.outcome, "failed");
});

test("script reads and revision writes use the existing project provider and confirmation policy", async () => {
    const runtime = setup("codex.subscription");
    const calls: string[] = [];
    const provider = new ProjectToolProvider({ callTool: async (name) => {
        calls.push(String(name));
        return { ok: true, data: { verification: { ok: true, persisted: true, currentRevision: 2 } } };
    } });
    for (const name of ["project_get_script", "project_get_script_revision", "project_revise_script"]) {
        assert.equal(runtime.manifest.get(name).provider, "host_project");
        assert.equal(runtime.manifest.names("workbench_operator").includes(name), true);
        runtime.broker.register(name, provider);
    }
    assert.equal(runtime.manifest.get("project_get_script").risk, "read");
    assert.equal(runtime.manifest.get("project_get_script_revision").risk, "read");
    assert.equal(runtime.manifest.get("project_revise_script").risk, "write");
    const base = { profile: runtime.profile, session: runtime.session, turnId: "script-turn", contextReceiptId: runtime.receiptId, currentContext: runtime.snapshot };
    assert.equal((await runtime.broker.request({ ...base, toolName: "project_get_script", input: { unitId: "unit" } })).status, "completed");
    const proposed = await runtime.broker.request({ ...base, toolName: "project_revise_script", input: { unitId: "unit", expectedRevision: 1, requestId: "script-edit", note: "改对白", edits: [{ oldText: "我不走", newText: "我陪你" }] } });
    assert.equal(proposed.status, "confirmation_required");
    assert.deepEqual(calls, ["project_get_script"]);
    if (proposed.status !== "confirmation_required") return;
    assert.match(proposed.confirmation.summary, /章节：unit；正文基版 v1，1 处精确修订/);
    assert.doesNotMatch(proposed.confirmation.summary, /我不走|我陪你/);
    runtime.confirmations.decide(proposed.confirmation.id, { sessionId: runtime.session.id, actorId: "human-owner", approved: true });
    const result = await runtime.broker.executeConfirmed({ confirmationId: proposed.confirmation.id, profile: runtime.profile, session: runtime.session, currentContext: runtime.snapshot });
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["project_get_script", "project_revise_script"]);
});

test("canonical creative target previews exclude body content and untrusted project identity", () => {
    const scope = { domainProjectId: "owned", canvasId: "current" };
    const common = { projectId: "spoofed", unitId: "u", expectedShotRevision: 2, expectedRevision: 1, sourceText: "PRIVATE", prompt: "PRIVATE" };
    assert.match(projectToolConfirmationDetail("project_create_or_update_shots", { ...common, shots: [{ id: "s" }, {}] }, scope), /新增 1 镜、修订 1 镜/);
    assert.match(projectToolConfirmationDetail("project_sync_storyboard", common, scope), /同步分镜 v2 到当前画布 current/);
    const prompt = projectToolConfirmationDetail("project_save_prompt", { ...common, nodeId: "node", rowId: "project-shot:s", kind: "video" }, scope);
    assert.match(prompt, /项目：owned；画布：current；节点：node；分镜行：project-shot:s；视频稿基版 v1/);
    assert.doesNotMatch(prompt, /PRIVATE|spoofed/);
    assert.equal(projectToolConfirmationDetail("canvas_generate_image", common, scope), "");
    assert.doesNotMatch(projectToolConfirmationDetail("project_revise_script", { ...common, unitId: "private\n<script>" }, scope), /private|script/);
});

test("cancelled proposals cannot enter a provider, even after confirmation", async () => {
    const runtime = setup("codex.subscription");
    const controller = new AbortController();
    let writes = 0;
    runtime.broker.register("project_revise_script", { execute: async () => { writes++; return { output: {}, postcondition: { ok: true } }; } });
    const input = { profile: runtime.profile, session: runtime.session, turnId: "cancel-save", toolName: "project_revise_script", input: {}, contextReceiptId: runtime.receiptId, currentContext: runtime.snapshot, signal: controller.signal };
    const outcome = await runtime.broker.request(input);
    assert.equal(outcome.status, "confirmation_required");
    if (outcome.status !== "confirmation_required") return;
    runtime.confirmations.decide(outcome.confirmation.id, { sessionId: runtime.session.id, actorId: "owner", approved: true });
    controller.abort(new Error("AGENT_TURN_CANCELLED"));
    await assert.rejects(runtime.broker.executeConfirmed({ confirmationId: outcome.confirmation.id, profile: runtime.profile, session: runtime.session, currentContext: runtime.snapshot }), /AGENT_TURN_CANCELLED/);
    await assert.rejects(runtime.broker.request({ ...input, ordinaryConfirmationEnabled: false }), /AGENT_TURN_CANCELLED/);
    assert.equal(writes, 0);
});

test("manifest is the single grant source for Workbench Canvas Project and Film tools", () => {
    const manifest = new CanonicalAgentToolManifest();
    const names = manifest.names("workbench_operator");
    assert.equal(names.includes("workbench_get_context"), true);
    assert.equal(names.includes("canvas_get_context"), true);
    assert.equal(names.includes("project_get_context"), true);
    assert.equal(names.includes("film_project_get_context"), true);
    assert.equal(names.includes("film_command_preview"), true);
    assert.equal(names.includes("film_command_apply"), true);
    assert.equal(names.includes("dreamina_cli"), false);
    assert.equal(manifest.get("canvas_generate_image").risk, "paid");
    assert.equal(manifest.get("canvas_delete_nodes").risk, "destructive");
    assert.equal(manifest.get("film_command_apply").risk, "approval");
});

function setup(profileId: "codex.subscription" | "openai.api" | "local.model") {
    const manifest = new CanonicalAgentToolManifest();
    const grants = new AgentPermissionGrantStore();
    const confirmations = new AgentConfirmationStore();
    const contexts = new AgentContextBroker();
    const audit = new MemoryAgentAuditSink();
    const profile = brainProfile(profileId);
    const session: BrainSession = {
        id: `session-${profileId}`,
        conversationId: "conversation-1",
        brainProfileId: profileId,
        connectionId: profileId,
        projectId: "project-1",
        domainProjectId: "film-project-1",
        canvasId: "canvas-1",
        permissionGrantId: "pending",
        status: "ready",
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const grant = grants.issue({
        sessionId: session.id,
        connectionId: profileId,
        actorId: "actor-1",
        projectId: session.projectId,
        domainProjectId: session.domainProjectId,
        toolSurface: "workbench_operator",
        allowedTools: manifest.names("workbench_operator"),
    });
    session.permissionGrantId = grant.id;
    const snapshot = workbenchSnapshot();
    const receiptId = contexts.capture(session, snapshot).receipt.receiptId;
    const policy = new AgentPolicyGateway(grants, contexts);
    const broker = new CanonicalAgentToolBroker(manifest, grants, confirmations, policy, audit);
    return { manifest, grants, confirmations, contexts, audit, profile, session, snapshot, receiptId, broker };
}

function brainProfile(id: "codex.subscription" | "openai.api" | "local.model"): BrainProfile {
    return {
        id,
        displayName: id,
        provider: id === "codex.subscription" ? "openai.codex" : id === "openai.api" ? "openai.gpt" : "local",
        transport: id === "codex.subscription" ? "codex_app_server" : id === "openai.api" ? "model_api" : "local_model",
        authMode: id === "codex.subscription" ? "chatgpt_managed" : id === "openai.api" ? "api_key" : "local",
        billingMode: id === "codex.subscription" ? "subscription" : id === "openai.api" ? "metered_api" : "local_compute",
        interactionSurface: "native_stream",
        toolSurface: "workbench_operator",
        requiresApiKey: id === "openai.api",
        mayCreateSeparateCharges: id === "openai.api",
        availability: "enabled",
        capabilities: { streamingChat: true, threadHistory: true, threadResume: true, imageInput: true, automaticVisualContext: true, mcpTools: true, read: true, preview: true, applyAfterHumanConfirmation: true, hostedProposalReturn: false, cancelTurn: true },
    };
}

function workbenchSnapshot(): WorkbenchContextSnapshot {
    return {
        projectId: "project-1",
        domainProjectId: "film-project-1",
        canvasId: "canvas-1",
        canvasRevision: 7,
        canvasStateHash: "a".repeat(64),
        nodes: [{ id: "node-1", type: "shot" }],
        connections: [],
        selectedNodeIds: ["node-1"],
        visibleNodeIds: ["node-1"],
        assets: [],
        filmExpectedVersion: 4,
        filmContentHash: "b".repeat(64),
    };
}

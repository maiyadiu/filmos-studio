import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAgentWorkbenchScope, toolsForWorkbenchScope } from "@filmos/agent-contracts";
import { CanvasSession } from "../src/canvas-session.js";
import { ensureRuntimeAgentWorkspace, type LocalRuntimeConfig } from "../src/config.js";
import { AgentContextBroker } from "../src/brains/context-broker.js";
import { AgentPermissionGrantStore } from "../src/brains/permission-grants.js";
import { AgentConfirmationStore } from "../src/brains/confirmations.js";
import { AgentSessionManager } from "../src/brains/session-manager.js";
import { BrainProfileRegistry } from "../src/brains/registry.js";
import { JsonBrainSessionStore } from "../src/brains/session-store.js";
import { AgentPolicyGateway } from "../src/brains/policy-gateway.js";
import { CanonicalAgentToolBroker } from "../src/brains/tool-broker.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";
import { MemoryAgentAuditSink } from "../src/brains/agent-audit.js";
import { trustedCreateSessionInput, validateAgentGrantHeaders } from "../src/modules/canvas-agent-http.js";
import { publicAgentRuntimeFailure } from "../src/local-runtime-security.js";
import { adapter, profile } from "./brain-test-fixtures.js";

const workspaceId = "runtime-owner-fixture";
const state = { contextKind: "workspace" as const, workspaceId, projectId: null, activePanel: "settings", nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assetVersionIds: [] };
const input = { conversationId: "workspace-conversation", brainProfileId: "codex.subscription", projectId: null, canvasId: null, workspaceId, actorId: workspaceId };

test("workspace snapshot is Runtime bound, data-minimal, and never inherits a previous project", async () => {
    const page = new CanvasSession();
    page.updateState({ projectId: "old-canvas", domainProjectId: "old-project", contentUnitId: "old-chapter", nodes: [] });
    assert.throws(() => page.updateState(state), /WORKSPACE_REQUIRED/);
    page.updateState(state, "workspace-page", workspaceId);
    const snapshot = page.agentContextSnapshot();
    assert.equal(page.health().hasCanvas, false);
    assert.equal(snapshot.projectId, null);
    assert.equal(snapshot.canvasId, null);
    assert.equal(snapshot.workspaceId, workspaceId);
    assert.equal(snapshot.domainProjectId, undefined);
    assert.equal(snapshot.contentUnitId, undefined);
    assert.equal(snapshot.projectTitle, undefined);
    for (const patch of [{ workspaceId: "spoof" }, { projectId: "old-project" }, { domainProjectId: "old-project" }, { contentUnitId: "old-chapter" }, { nodes: [{}] }, { assetVersionIds: ["old-asset"] }, { apiKey: "fixture-secret" }, { title: "unfiltered settings" }, { activePanel: "https://untrusted.invalid/?key=fixture" }]) {
        assert.throws(() => page.updateState({ ...state, ...patch }, "workspace-page", workspaceId), /AGENT_/);
        assert.deepEqual(page.agentContextSnapshot(), snapshot);
    }
    for (const tool of ["project_get_context", "project_create_script", "canvas_get_state", "canvas_apply_ops"]) await assert.rejects(page.callTool(tool, {}), /REQUIRES_PROJECT_CONTEXT/);
    const trusted = trustedCreateSessionInput({ ...input, workspaceId: "spoof", projectId: "old-project", canvasId: "old-canvas", executionProfile: "review_coordinator", workspacePath: "/spoof" }, snapshot, workspaceId);
    assert.deepEqual(trusted, input);
    assert.throws(() => assertAgentWorkbenchScope({ ...input, shotId: "old-shot" }), /HAS_PROJECT_DATA/);
    assert.deepEqual(toolsForWorkbenchScope(["workbench_get_context", "project_get_script", "canvas_generate_image", "new_tool"], input), ["workbench_get_context"]);
    page.dispose();
});

test("workspace session, grant, receipt, audit and restart preserve null project and exact workspace", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-workspace-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "sessions.json");
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.subscription"));
    registry.registerAdapter(adapter("codex.subscription"));
    let store = new JsonBrainSessionStore(file);
    const grants = new AgentPermissionGrantStore(), contexts = new AgentContextBroker(), confirmations = new AgentConfirmationStore();
    const manager = () => new AgentSessionManager(registry, store, grants, confirmations, contexts);
    for (const patch of [{ workspaceId: undefined }, { domainProjectId: "old" }, { brainProfileId: "openai.api" }, { executionProfile: "review_coordinator" }, { workspacePath: "/spoof" }]) await assert.rejects(manager().createSession({ ...input, ...patch } as never), /AGENT_/);
    const created = await manager().createSession(input);
    const grant = grants.get(created.permissionGrantId)!;
    assert.equal(grant.projectId, null);
    assert.deepEqual(grant.allowedTools, ["workbench_get_context"]);
    assert.throws(() => grants.validate(grant.id, { sessionId: created.id, connectionId: created.connectionId, projectId: null }), /SCOPE_MISMATCH/);
    const headers = { "x-filmos-agent-grant-id": grant.id, "x-filmos-agent-session-id": created.id, "x-filmos-agent-connection-id": created.connectionId, "x-filmos-agent-project-id": "", "x-filmos-agent-workspace-id": workspaceId, "x-filmos-agent-grant-nonce": grant.nonce, "x-filmos-agent-grant-signature": grant.signature };
    assert.equal(validateAgentGrantHeaders({ headers } as never, grants, "workbench_get_context", true)?.workspaceId, workspaceId);
    for (const patch of [{ "x-filmos-agent-workspace-id": "other" }, { "x-filmos-agent-project-id": "null" }, { "x-filmos-agent-project-id": "old-project" }]) assert.throws(() => validateAgentGrantHeaders({ headers: { ...headers, ...patch } } as never, grants, "workbench_get_context", true), /SCOPE_MISMATCH/);
    const page = new CanvasSession();
    page.updateState(state, "page", workspaceId);
    const snapshot = page.agentContextSnapshot();
    const { pack, receipt } = contexts.capture(created, snapshot);
    assert.deepEqual(pack.permissions.readableScopes, ["workspace"]);
    assert.equal(pack.project.id, null);
    assert.equal(pack.route.workspaceId, workspaceId);
    assert.equal(pack.canvas.id, null);
    for (const patch of [{ workspaceId: "other" }, { canvasStateHash: "other-page" }, { contentUnitId: "old-unit" }]) assert.throws(() => contexts.validate(receipt.receiptId, created, { ...snapshot, ...patch }), /AGENT_/);
    assert.throws(() => contexts.capture(created, { ...snapshot, assets: [{ id: "old", type: "asset" }] }), /HAS_PROJECT_DATA/);
    const audit = new MemoryAgentAuditSink(), tools = new CanonicalAgentToolManifest();
    const broker = new CanonicalAgentToolBroker(tools, grants, confirmations, new AgentPolicyGateway(grants, contexts), audit);
    let executions = 0;
    broker.register("workbench_get_context", { execute: async () => { executions++; return { output: pack }; } });
    const proposal = { profile: registry.getProfile(created.brainProfileId), session: created, turnId: "fixture-turn", toolName: "workbench_get_context", input: {}, contextReceiptId: receipt.receiptId, currentContext: snapshot };
    assert.equal((await broker.request(proposal)).status, "completed");
    for (const toolName of tools.names("workbench_operator").filter(name => name !== "workbench_get_context")) await assert.rejects(broker.request({ ...proposal, toolName }), /REQUIRES_PROJECT_CONTEXT/);
    assert.equal(executions, 1);
    assert.equal(audit.records[0].projectId, null);
    assert.equal(audit.records[0].workspaceId, workspaceId);
    store = new JsonBrainSessionStore(file);
    assert.deepEqual((await store.listSessions({ projectId: null, workspaceId })).map(s => s.id), [created.id]);
    assert.deepEqual(await store.listSessions({ workspaceId: "other" }), []);
    assert.equal((await store.getConversation(input.conversationId))?.workspaceId, workspaceId);
    const resumed = await manager().resumeSession(created.id, workspaceId);
    assert.equal(resumed.providerThreadId, created.providerThreadId);
    assert.equal(resumed.projectId, null);
    assert.equal(resumed.workspaceId, workspaceId);
    assert.deepEqual(grants.get(resumed.permissionGrantId)?.allowedTools, ["workbench_get_context"]);
    await assert.rejects(store.saveSession({ ...resumed, workspaceId: "other" }), /immutable/);
    page.dispose();
});

test("workspace scratch directory is not a business project or canvas and public failures are redacted", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-workspace-path-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { ownerId: workspaceId, canvases: {} } as LocalRuntimeConfig;
    assert.equal(ensureRuntimeAgentWorkspace(config, workspaceId, root), path.join(root, "agent-workspaces", workspaceId));
    assert.deepEqual(config.canvases, {});
    assert.deepEqual(fs.readdirSync(root), ["agent-workspaces"]);
    for (const id of ["../escape", "other", "", "/absolute"]) assert.throws(() => ensureRuntimeAgentWorkspace(config, id, root), /WORKSPACE_REQUIRED/);
    for (const code of ["AGENT_CONTEXT_WORKSPACE_REQUIRED", "AGENT_CONTEXT_WORKSPACE_PROJECT_MIXED", "AGENT_WORKSPACE_CONTEXT_HAS_PROJECT_DATA", "AGENT_WORKSPACE_PROFILE_DENIED", "AGENT_TOOL_REQUIRES_PROJECT_CONTEXT"]) {
        const failure = publicAgentRuntimeFailure(new Error(`${code}:secret-fixture`));
        assert.ok(failure);
        assert.ok([400, 403, 409].includes(failure.statusCode));
        assert.doesNotMatch(failure.message, /secret-fixture/);
    }
});

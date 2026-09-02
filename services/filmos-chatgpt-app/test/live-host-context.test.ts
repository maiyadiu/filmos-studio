import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { createFilmOSChatGPTApp } from "../src/server.js";
import { projectA, projectB, projects } from "./fixture.js";

test("native Agent handoff exposes only the current Project Grant and Secure Tunnel scoped context", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "native-agent-host");
  const audit = new MemoryAuditSink();
  const dataSource = new MemoryFilmOSReadDataSource(projects);
  const proof = "native-host-transport-proof";
  const challenge = "live_context_12345678";
  const instance = createFilmOSChatGPTApp({
    enabled: true,
    proposalHandoffEnabled: true,
    proposalSigningSecret: "native-agent-host-proposal-secret-123456",
    grants,
    dataSource,
    audit,
    secureTunnelProof: proof,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authorization = `Bearer ${issued.token}`;
  const health = await (await fetch(`${baseUrl}/health`)).json() as any;
  assert.match(health.mcp_instance_id, /^[0-9a-f-]{36}$/);
  const contextReceiptId = "context-receipt-001";
  const context = {
    project_id: projectA,
    content_unit_id: "unit-a",
    scene_id: "scene-a",
    director_unit_id: "director-a",
    shot_id: "shot-a",
    canvas_id: "canvas-a",
    selected_node_ids: ["node-b", "node-a"],
    visible_node_summaries: [{ id: "node-a", type: "shot", title: "bearer secret-secret-secret", status: "candidate" }],
    asset_version_ids: ["asset-version-a"],
    canvas_revision: 7,
    canvas_state_hash: "a".repeat(64),
    film_expected_version: 3,
    film_content_hash: "b".repeat(64),
    context_receipt_id: contextReceiptId,
    source_identity: {
      schema_version: "1.0.0",
      build_id: "candidate-test-12345678",
      repository: "maiyadiu/filmos-studio",
      git_commit_sha: "c".repeat(40),
      git_tree_sha: "d".repeat(40),
      source_fingerprint_sha256: "e".repeat(64),
      release_channel: "candidate",
      source_clean: true,
    },
  };

  const published = await fetch(`${baseUrl}/handoff/live-context`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ challenge_id: challenge, context }),
  });
  assert.equal(published.status, 200);
  assert.equal((await published.json() as any).context_receipt_id, contextReceiptId);

  const handoff = await fetch(`${baseUrl}/handoff/pending-agent`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ challenge_id: challenge, handoff: {
      session_id: "agent-session-a",
      turn_id: "turn-a",
      task: "Review the selected shot and return a proposal only.",
      context_receipt_id: contextReceiptId,
    } }),
  });
  assert.equal(handoff.status, 200);
  const handoffBody = await handoff.json() as any;
  assert.equal(handoffBody.status, "PENDING_CHATGPT");

  const client = new Client({ name: "chatgpt-live-context", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: {
    authorization,
    "x-filmos-transport": "secure-mcp-tunnel",
    "x-filmos-transport-proof": proof,
    "x-filmos-live-gate-challenge": challenge,
  } } });
  const otherClient = new Client({ name: "chatgpt-other-challenge", version: "1.0.0" });
  const otherTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: {
    authorization,
    "x-filmos-transport": "secure-mcp-tunnel",
    "x-filmos-transport-proof": proof,
    "x-filmos-live-gate-challenge": "live_other_12345678",
  } } });
  try {
    await client.connect(transport);
    await otherClient.connect(otherTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "filmos_get_live_workbench_context"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "filmos_get_pending_agent_handoff"), true);

    const live = await client.callTool({ name: "filmos_get_live_workbench_context", arguments: {} }) as any;
    assert.equal(live.structuredContent.project_id, projectA);
    assert.equal(live.structuredContent.canvas_revision, 7);
    assert.deepEqual(live.structuredContent.selected_node_ids, ["node-a", "node-b"]);
    assert.equal(live.structuredContent.visible_node_summaries[0].title, "[REDACTED]");
    assert.equal(live.structuredContent.source_identity.build_id, "candidate-test-12345678");
    assert.equal(live.structuredContent.source_identity.git_commit_sha, "c".repeat(40));
    assert.equal(live.structuredContent.project_grant_id, issued.grant.grant_id);
    assert.equal(live.structuredContent.challenge_id, challenge);
    assert.deepEqual(live.structuredContent.binding, {
      project_id: projectA,
      project_grant_id: issued.grant.grant_id,
      challenge_id: challenge,
      context_receipt_id: contextReceiptId,
      expires_at: live.structuredContent.expires_at,
    });

    const liveBlockers = await client.callTool({ name: "filmos_get_blockers", arguments: {} }) as any;
    assert.equal(liveBlockers.structuredContent.data.evaluation.status, "CLEAR");
    assert.equal(liveBlockers.structuredContent.data.evaluation.blocker_count, 0);
    assert.equal(liveBlockers.structuredContent.data.completeness, "DERIVED_FROM_PROJECT_AND_LIVE_CONTEXT");
    assert.equal(liveBlockers.structuredContent.data.project_scope.live_context_exact_match, true);
    assert.equal(liveBlockers.structuredContent.data.evidence.live_context_bound, true);
    assert.equal(liveBlockers.structuredContent.data.evidence.live_context_receipt_id, contextReceiptId);

    const pending = await client.callTool({ name: "filmos_get_pending_agent_handoff", arguments: {} }) as any;
    assert.equal(pending.structuredContent.handoff.status, "PENDING_CHATGPT");
    assert.equal(pending.structuredContent.handoff.context_receipt_id, contextReceiptId);
    assert.equal(pending.structuredContent.context.project_id, projectA);
    const serialized = JSON.stringify(pending.structuredContent);
    assert.equal(serialized.includes(issued.token), false);
    assert.equal(serialized.includes("/Users/"), false);
    const observedStatus = await (await fetch(`${baseUrl}/handoff/status?project_id=${projectA}`, { headers: { authorization } })).json() as any;
    assert.equal(observedStatus.tool_name, "filmos_get_pending_agent_handoff");
    assert.equal(observedStatus.handoff_id, handoffBody.handoff_id);

    const current = await dataSource.read("filmos_get_project_context", {}, issued.grant);
    const proposal = await client.callTool({ name: "filmos_prepare_proposal_export", arguments: {
      proposal_type: "Candidate",
      summary: "Return one bounded preview proposal",
      items_json: JSON.stringify([{ item_id: "item-a", kind: "Candidate", target_uri: `filmos://project/${projectA}/shot/shot-a`, summary: "Preview only", payload: { framing: "close-up" } }]),
      base_state_hash: current.state_hash,
    } }) as any;
    assert.equal(proposal.structuredContent.import_policy, "PREVIEW_AND_HUMAN_APPROVAL_ONLY");
    const proposalStatus = await (await fetch(`${baseUrl}/handoff/status?project_id=${projectA}`, { headers: { authorization } })).json() as any;
    assert.equal(proposalStatus.tool_name, "filmos_prepare_proposal_export");
    assert.equal(proposalStatus.handoff_id, handoffBody.handoff_id);

    const denied = await otherClient.callTool({ name: "filmos_get_live_workbench_context", arguments: {} }) as any;
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, "live_workbench_context_unavailable");

    const blocked = await otherClient.callTool({ name: "filmos_get_blockers", arguments: {} }) as any;
    assert.equal(blocked.structuredContent.data.evaluation.status, "BLOCKED");
    assert.equal(blocked.structuredContent.data.evaluation.blocker_count, 1);
    assert.equal(blocked.structuredContent.data.items[0].code, "live_workbench_context_unavailable");
    assert.equal(blocked.structuredContent.data.items[0].severity, "P0");
    assert.equal(blocked.structuredContent.data.evidence.live_context_bound, false);

    const crossProject = await fetch(`${baseUrl}/handoff/live-context`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ challenge_id: challenge, context: { ...context, project_id: projectB } }),
    });
    assert.equal(crossProject.status, 400);
    assert.equal((await crossProject.json() as any).code, "project_scope_denied");
    assert.ok(audit.records.some((record) => record.action === "filmos_get_pending_agent_handoff" && record.outcome === "ALLOW"));
    console.log("FILMOS_CHATGPT_REAL_HANDOFF_OBSERVATION_RECEIPT", JSON.stringify({
      gate_id: "CHATGPT-HANDOFF-STATE-001",
      status: "PASSED",
      handoff_id_bound_to_observation: true,
      observed_tools: ["filmos_get_pending_agent_handoff", "filmos_prepare_proposal_export"],
      direct_apply_count: 0,
      paid_provider_request_count: 0,
    }));
  } finally {
    await otherClient.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

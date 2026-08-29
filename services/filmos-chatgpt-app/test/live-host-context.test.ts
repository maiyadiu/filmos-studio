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
  const proof = "native-host-transport-proof";
  const challenge = "live_context_12345678";
  const instance = createFilmOSChatGPTApp({
    enabled: true,
    proposalHandoffEnabled: false,
    grants,
    dataSource: new MemoryFilmOSReadDataSource(projects),
    audit,
    secureTunnelProof: proof,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authorization = `Bearer ${issued.token}`;
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
  assert.equal((await handoff.json() as any).status, "PENDING_CHATGPT");

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

    const pending = await client.callTool({ name: "filmos_get_pending_agent_handoff", arguments: {} }) as any;
    assert.equal(pending.structuredContent.handoff.status, "PENDING_CHATGPT");
    assert.equal(pending.structuredContent.handoff.context_receipt_id, contextReceiptId);
    assert.equal(pending.structuredContent.context.project_id, projectA);
    const serialized = JSON.stringify(pending.structuredContent);
    assert.equal(serialized.includes(issued.token), false);
    assert.equal(serialized.includes("/Users/"), false);

    const denied = await otherClient.callTool({ name: "filmos_get_live_workbench_context", arguments: {} }) as any;
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, "live_workbench_context_unavailable");

    const crossProject = await fetch(`${baseUrl}/handoff/live-context`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ challenge_id: challenge, context: { ...context, project_id: projectB } }),
    });
    assert.equal(crossProject.status, 400);
    assert.equal((await crossProject.json() as any).code, "project_scope_denied");
    assert.ok(audit.records.some((record) => record.action === "filmos_get_pending_agent_handoff" && record.outcome === "ALLOW"));
  } finally {
    await otherClient.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

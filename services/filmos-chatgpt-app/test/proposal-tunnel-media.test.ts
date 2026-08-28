import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryAuditSink } from "../src/audit.js";
import { hmacSha256 } from "../src/canonical.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import type { MediaProxyStore } from "../src/media.js";
import { createFilmOSChatGPTApp } from "../src/server.js";
import { inspectSecureTunnel } from "../src/tunnel.js";
import { projectA, projects } from "./fixture.js";

test("Golden ChatGPT B: proposal handoff signs a local package and never applies it", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "chatgpt-test");
  const dataSource = new MemoryFilmOSReadDataSource(projects);
  const secret = "track14-local-test-signing-secret-123456";
  const instance = createFilmOSChatGPTApp({ enabled: true, proposalHandoffEnabled: true, proposalSigningSecret: secret, grants, dataSource, audit: new MemoryAuditSink() });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "golden-b", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } });
  try {
    await client.connect(transport);
    const current = await dataSource.read("filmos_get_project_context", {}, issued.grant);
    const response = await client.callTool({ name: "filmos_prepare_proposal_export", arguments: { proposal_type: "Candidate", summary: "Try a tighter close-up", items_json: JSON.stringify([{ command: "create_candidate", target: "shot-a" }]), base_state_hash: current.state_hash } }) as any;
    const pkg = response.structuredContent.package;
    assert.equal(pkg.host_project_id, projectA);
    assert.equal(pkg.proposal_type, "Candidate");
    assert.equal(pkg.signature, `hmac-sha256:${hmacSha256(secret, pkg.content_hash)}`);
    assert.equal(response.structuredContent.import_policy, "PREVIEW_AND_HUMAN_APPROVAL_ONLY");
    assert.equal(JSON.stringify(response).includes("Formal Apply"), false);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("media proxy serves only project-scoped bounded proxy media", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "chatgpt-test");
  const store: MediaProxyStore = { async get(id) { return id === "preview-a" ? { project_id: projectA, content_type: "image/jpeg", bytes: Uint8Array.of(1, 2, 3), width: 1024, height: 576, is_proxy: true } : null; } };
  const instance = createFilmOSChatGPTApp({ enabled: true, proposalHandoffEnabled: false, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit: new MemoryAuditSink(), media: store });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/media/preview-a`, { headers: { authorization: `Bearer ${issued.token}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
    const traversal = await fetch(`http://127.0.0.1:${port}/media/..%2Fsecret`, { headers: { authorization: `Bearer ${issued.token}` } });
    assert.equal(traversal.status, 400);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Secure MCP Tunnel doctor fails closed without external account credentials", async () => {
  const receipt = await inspectSecureTunnel({ FILMOS_CHATGPT_MCP_URL: "http://127.0.0.1:17840/mcp" });
  assert.equal(receipt.status, "BLOCKED_EXTERNAL_ACCOUNT");
  assert.equal(receipt.tunnel_started, false);
  assert.equal(receipt.public_listener_created, false);
  assert.ok(receipt.blockers.includes("MISSING_PLATFORM_TUNNEL_ID"));
  assert.ok(receipt.blockers.includes("MISSING_TUNNEL_RUNTIME_KEY"));
});

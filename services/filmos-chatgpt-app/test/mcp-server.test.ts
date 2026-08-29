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

test("Golden ChatGPT A: authorized Candidate project is readable through streamable HTTP and writes stay hidden", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "chatgpt-test");
  const audit = new MemoryAuditSink();
  const instance = createFilmOSChatGPTApp({ enabled: true, proposalHandoffEnabled: false, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "golden-a", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.equal(names.includes("search"), true);
    assert.equal(names.includes("fetch"), true);
    assert.equal(names.includes("filmos_get_project_context"), true);
    assert.equal(names.includes("filmos_render_project_overview"), true);
    assert.equal(names.includes("filmos_prepare_proposal_export"), false);
    assert.equal(names.some((name) => /apply|approve|delete|task_create/.test(name)), false);
    const dataTool = tools.tools.find((tool) => tool.name === "filmos_get_project_context")!;
    const renderTool = tools.tools.find((tool) => tool.name === "filmos_render_project_overview")!;
    assert.equal(dataTool._meta?.ui, undefined);
    assert.equal((renderTool._meta?.ui as any).resourceUri, "ui://filmos/project-overview-v1.html");

    const search = await client.callTool({ name: "search", arguments: { query: "unit-a" } }) as any;
    assert.equal(search.content.length, 1);
    assert.equal(search.content[0].type, "text");
    const result = JSON.parse(search.content[0].text).results[0];
    assert.ok(result.id.startsWith(`filmos://project/${projectA}/`));
    const fetched = await client.callTool({ name: "fetch", arguments: { id: result.id } }) as any;
    assert.equal(fetched.content.length, 1);
    assert.equal(JSON.parse(fetched.content[0].text).id, result.id);

    const context = await client.callTool({ name: "filmos_get_project_context", arguments: {} }) as any;
    assert.equal(context.structuredContent.project_id, projectA);
    assert.deepEqual(context.structuredContent.security_warnings, ["PROMPT_INJECTION_TEXT_IGNORED"]);
    const serialized = JSON.stringify(context.structuredContent);
    assert.equal(serialized.includes("/Users/"), false);
    assert.equal(serialized.includes("sk-do-not-leak"), false);
    assert.ok(audit.records.some((record) => record.action === "filmos_get_project_context" && record.outcome === "ALLOW"));
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("project scope blocks cross-project fetch and token revocation fails a live session closed", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "chatgpt-test");
  const instance = createFilmOSChatGPTApp({ enabled: true, proposalHandoffEnabled: false, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit: new MemoryAuditSink() });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "auth-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } });
  try {
    await client.connect(transport);
    const denied = await client.callTool({ name: "fetch", arguments: { id: `filmos://project/${projectB}/context/project` } }) as any;
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, "project_scope_denied");
    await grants.revoke(issued.grant.grant_id);
    await assert.rejects(() => client.callTool({ name: "filmos_get_project_context", arguments: {} }));
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("first proven Secure Tunnel read marks ChatGPT reached FilmOS and writes a challenge receipt", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "chatgpt-live-gate");
  const audit = new MemoryAuditSink();
  const proof = "ephemeral-transport-proof-42";
  const challenge = "live_acceptance_12345678";
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
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "external-live-gate", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: {
      authorization: `Bearer ${issued.token}`,
      "x-filmos-transport": "secure-mcp-tunnel",
      "x-filmos-transport-proof": proof,
      "x-filmos-live-gate-challenge": challenge,
    } },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: "filmos_get_project_context", arguments: {} });
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any;
    assert.equal(health.external_account_connected, true);
    assert.equal(health.tool_name, "filmos_get_project_context");
    assert.equal(health.project_scope, projectA);
    assert.equal(health.challenge_id, challenge);
    assert.match(health.request_id, /^[0-9a-f-]{36}$/);
    assert.match(health.result_hash, /^[0-9a-f]{64}$/);
    const receipt = audit.records.find((record) => record.challenge_id === challenge);
    assert.equal(receipt?.tool_name, "filmos_get_project_context");
    assert.equal(receipt?.request_id, health.request_id);
    assert.equal(receipt?.result_hash, health.result_hash);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a direct localhost client cannot spoof ChatGPT reachability without the ephemeral tunnel proof", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "local-spoof-test");
  const instance = createFilmOSChatGPTApp({
    enabled: true,
    proposalHandoffEnabled: false,
    grants,
    dataSource: new MemoryFilmOSReadDataSource(projects),
    audit: new MemoryAuditSink(),
    secureTunnelProof: "correct-proof",
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "local-spoof", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: {
      authorization: `Bearer ${issued.token}`,
      "x-filmos-transport": "secure-mcp-tunnel",
      "x-filmos-transport-proof": "wrong-proof",
      "x-filmos-live-gate-challenge": "live_spoof_12345678",
    } },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: "filmos_get_project_context", arguments: {} });
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any;
    assert.equal(health.external_account_connected, false);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

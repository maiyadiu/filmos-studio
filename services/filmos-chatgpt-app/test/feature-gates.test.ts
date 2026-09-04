import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { buildFilmOSMcpManifest, createFilmOSMcpServer } from "../src/mcp.js";
import { EXTERNAL_READ_TOOL_ALLOWLIST } from "../src/server.js";
import { projectA, projects } from "./fixture.js";

test("read and widget feature flags independently gate public MCP tools and resources", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "flag-test");

  const dataOnly = await connect({ readToolsEnabled: true, widgetsEnabled: false, grant: issued.grant });
  try {
    const tools = (await dataOnly.client.listTools()).tools;
    assert.ok(tools.some((tool) => tool.name === "filmos_get_project_context"));
    assert.equal(tools.some((tool) => tool.name.startsWith("filmos_render_")), false);
    await assert.rejects(() => dataOnly.client.listResources(), (error: any) => error.code === -32601);
  } finally { await dataOnly.close(); }

  const widgetsWithoutReads = await connect({ readToolsEnabled: false, widgetsEnabled: true, grant: issued.grant });
  try {
    await assert.rejects(() => widgetsWithoutReads.client.listTools(), (error: any) => error.code === -32601);
    assert.equal((await widgetsWithoutReads.client.listResources()).resources.length, 7);
  } finally { await widgetsWithoutReads.close(); }
});

test("external-read allowlist is exact, ordered, read-only, and rejects drift", async () => {
  const manifestOptions = {
    readToolsEnabled: true,
    widgetsEnabled: false,
    proposalHandoffEnabled: false,
    reviewReadToolsEnabled: true,
    toolAllowlist: EXTERNAL_READ_TOOL_ALLOWLIST,
  };
  const manifest = buildFilmOSMcpManifest(manifestOptions);
  assert.deepEqual(manifest.map((tool) => tool.name), [...EXTERNAL_READ_TOOL_ALLOWLIST]);
  assert.equal(manifest.length, 7);
  assert.ok(manifest.every((tool) => tool.risk === "read"));
  assert.throws(
    () => buildFilmOSMcpManifest({ ...manifestOptions, toolAllowlist: [...EXTERNAL_READ_TOOL_ALLOWLIST, "unknown_tool"] }),
    /MCP_TOOL_ALLOWLIST_UNKNOWN/,
  );
  assert.throws(
    () => buildFilmOSMcpManifest({ ...manifestOptions, toolAllowlist: [EXTERNAL_READ_TOOL_ALLOWLIST[0], EXTERNAL_READ_TOOL_ALLOWLIST[0]] }),
    /MCP_TOOL_ALLOWLIST_DUPLICATE/,
  );

  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "external-read-manifest-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFilmOSMcpServer({
    grant: issued.grant,
    dataSource: new MemoryFilmOSReadDataSource(projects),
    audit: new MemoryAuditSink(),
    proposalHandoffEnabled: false,
    readToolsEnabled: true,
    widgetsEnabled: false,
    reviewReadToolsEnabled: true,
    reviewRead: { async read(tool, input, project) { return { tool, input, project_id: project }; } },
    toolAllowlist: EXTERNAL_READ_TOOL_ALLOWLIST,
  });
  const client = new Client({ name: "external-read-manifest", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [...EXTERNAL_READ_TOOL_ALLOWLIST]);
    await assert.rejects(() => client.listResources(), (error: any) => error.code === -32601);
  } finally {
    await client.close();
    await server.close();
  }
});

async function connect(options: { readToolsEnabled: boolean; widgetsEnabled: boolean; grant: Awaited<ReturnType<MemoryProjectGrantStore["authorize"]>> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFilmOSMcpServer({
    ...options,
    proposalHandoffEnabled: false,
    dataSource: new MemoryFilmOSReadDataSource(projects),
    audit: new MemoryAuditSink(),
  });
  const client = new Client({ name: "feature-gate-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

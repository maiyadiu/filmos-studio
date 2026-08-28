import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { createFilmOSMcpServer } from "../src/mcp.js";
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

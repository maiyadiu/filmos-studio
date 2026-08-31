import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { REVIEW_READ_TOOLS } from "../src/review-mcp.js";
import type { ReviewReadSource } from "../src/review-source.js";
import { createFilmOSChatGPTApp } from "../src/server.js";
import { projectA, projects } from "./fixture.js";

test("ChatGPT Review MCP registry is strictly read-only and preserves the blind assessment boundary", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "chatgpt-review-test");
  const audit = new MemoryAuditSink();
  const calls: Array<{ tool: string; project: string }> = [];
  const reviewRead: ReviewReadSource = {
    async read(tool, input, project) {
      calls.push({ tool, project });
      if (tool === "issue_get_codex_assessment_blind") return { issue_id: input.issue_id, own_assessment: null, counterpart_assessment: null, counterpart_sealed: true, pair_complete: false };
      return { tool, issue_id: input.issue_id ?? null, project_id: project, read_only: true };
    },
  };
  const instance = createFilmOSChatGPTApp({ enabled: true, proposalHandoffEnabled: false, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit, reviewRead });
  const httpServer = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const client = new Client({ name: "review-readonly", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const reviewNames = REVIEW_READ_TOOLS.map(([name]) => name);
    for (const name of reviewNames) {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    assert.equal(reviewNames.some((name) => /write|apply|approve|close|submit/.test(name)), false);
    const blind = await client.callTool({ name: "issue_get_codex_assessment_blind", arguments: { issue_id: "FILMOS-ISSUE-test" } }) as any;
    assert.equal(blind.structuredContent.counterpart_assessment, null);
    assert.equal(blind.structuredContent.counterpart_sealed, true);
    assert.deepEqual(calls, [{ tool: "issue_get_codex_assessment_blind", project: projectA }]);
    assert.ok(audit.records.some((record) => record.action === "issue_get_codex_assessment_blind" && record.project_id === projectA && record.outcome === "ALLOW"));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await health.json() as any;
    assert.equal(body.mcp_write_tool_count, 0);
    assert.equal(body.mcp_paid_tool_count, 0);
    assert.equal(body.mcp_destructive_tool_count, 0);
    assert.equal(body.review_bus_read_tools_enabled, true);
    assert.equal(body.review_bus_read_tool_count, reviewNames.length);
    assert.ok(body.mcp_read_tool_count >= reviewNames.length);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

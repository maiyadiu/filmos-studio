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
  const calls: Array<{ tool: string; input: Record<string, unknown>; project: string }> = [];
  const reviewRead: ReviewReadSource = {
    async read(tool, input, project) {
      calls.push({ tool, input: { ...input }, project });
      if (input.issue_id === "FILMOS-ISSUE-cross-project") {
        throw Object.assign(new Error("Issue belongs to another project"), { code: "PROJECT_SCOPE_DENIED" });
      }
      if (input.issue_id === "FILMOS-ISSUE-missing") {
        throw Object.assign(new Error("Issue was not found"), { code: "ISSUE_NOT_FOUND" });
      }
      if (input.issue_id === "FILMOS-ISSUE-invalid-argument") {
        throw Object.assign(new Error("Backend rejected the argument"), { code: "INVALID_ARGUMENT" });
      }
      if (input.issue_id === "FILMOS-ISSUE-invalid-scope-message") {
        throw Object.assign(new Error("Expected project does not match the current Project Grant"), { code: "INVALID_ARGUMENT" });
      }
      if (input.issue_id === "FILMOS-ISSUE-scope-ordinary-message") {
        throw Object.assign(new Error("Backend read failed"), { code: "PROJECT_SCOPE_DENIED" });
      }
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
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "noauth" }]);
      assert.deepEqual(tool._meta?.["openai/securitySchemes"], [{ type: "noauth" }]);
    }
    const evidenceTool = listed.tools.find((item) => item.name === "issue_get_evidence");
    assert.equal((evidenceTool?.inputSchema.properties?.expected_project_id as { type?: string } | undefined)?.type, "string");
    assert.equal((evidenceTool?.inputSchema.properties?.expected_project_id as { minLength?: number } | undefined)?.minLength, 1);
    assert.equal((evidenceTool?.inputSchema.properties?.expected_project_id as { maxLength?: number } | undefined)?.maxLength, 256);
    assert.equal(evidenceTool?.inputSchema.required?.includes("expected_project_id"), false);
    assert.equal(reviewNames.some((name) => /write|apply|approve|close|submit/.test(name)), false);
    const blind = await client.callTool({ name: "issue_get_codex_assessment_blind", arguments: { issue_id: "FILMOS-ISSUE-test" } }) as any;
    assert.equal(blind.structuredContent.counterpart_assessment, null);
    assert.equal(blind.structuredContent.counterpart_sealed, true);

    const correct = await client.callTool({ name: "issue_get_evidence", arguments: {
      issue_id: "FILMOS-ISSUE-test",
      expected_project_id: projectA,
    } }) as any;
    assert.equal(correct.isError, undefined);
    assert.equal(correct.structuredContent.project_id, projectA);

    const paddedCorrect = await client.callTool({ name: "issue_get_evidence", arguments: {
      issue_id: "FILMOS-ISSUE-test",
      expected_project_id: `  ${projectA}  `,
    } }) as any;
    assert.equal(paddedCorrect.isError, undefined);
    assert.equal(calls.at(-1)?.input.expected_project_id, projectA);

    for (const blankProject of ["   ", "\t\n "]) {
      const sourceCallCount = calls.length;
      const blank = await client.callTool({ name: "issue_get_evidence", arguments: {
        issue_id: "FILMOS-ISSUE-test",
        expected_project_id: blankProject,
      } }) as any;
      assert.equal(blank.isError, true);
      assert.equal(JSON.parse(blank.content[0].text).code, "INVALID_ARGUMENT");
      assert.equal(blank.structuredContent.error_code, "INVALID_ARGUMENT");
      assert.equal(calls.length, sourceCallCount);
      assert.equal(audit.records.at(-1)?.code, "INVALID_ARGUMENT");
      assert.equal(audit.records.at(-1)?.outcome, "ERROR");
      assert.equal(JSON.stringify(blank).includes(projectA), false);
      assert.equal(JSON.stringify(blank).includes(issued.grant.grant_id), false);
    }

    const paddedWrongCallCount = calls.length;
    const paddedWrong = await client.callTool({ name: "issue_get_evidence", arguments: {
      issue_id: "FILMOS-ISSUE-test",
      expected_project_id: "  wrong-project  ",
    } }) as any;
    assert.equal(paddedWrong.isError, true);
    assert.equal(JSON.parse(paddedWrong.content[0].text).code, "PROJECT_SCOPE_DENIED");
    assert.equal(paddedWrong.structuredContent.error_code, "PROJECT_SCOPE_DENIED");
    assert.equal(calls.length, paddedWrongCallCount);
    assert.equal(audit.records.at(-1)?.code, "PROJECT_SCOPE_DENIED");
    assert.equal(audit.records.at(-1)?.outcome, "DENY");

    const denied = await client.callTool({ name: "issue_get_evidence", arguments: {
      issue_id: "FILMOS-ISSUE-test",
      expected_project_id: "wrong-project",
    } }) as any;
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, "PROJECT_SCOPE_DENIED");
    assert.equal(denied.structuredContent.error_code, "PROJECT_SCOPE_DENIED");
    for (const leakedField of ["read_only", "project_id", "evidence", "submission", "manifest"]) {
      assert.equal(JSON.stringify(denied).toLowerCase().includes(leakedField), false);
    }
    const invalid = await client.callTool({ name: "issue_get_evidence", arguments: {
      issue_id: "FILMOS-ISSUE-test",
      expected_project_id: "",
    } }) as any;
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent, undefined);
    assert.match(invalid.content[0].text, /Invalid arguments for tool issue_get_evidence/);
    for (const invalidExpectedProjectId of [42, "x".repeat(257)]) {
      const sourceCallCount = calls.length;
      const schemaInvalid = await client.callTool({ name: "issue_get_evidence", arguments: {
        issue_id: "FILMOS-ISSUE-test",
        expected_project_id: invalidExpectedProjectId,
      } }) as any;
      assert.equal(schemaInvalid.isError, true);
      assert.equal(schemaInvalid.structuredContent, undefined);
      assert.match(schemaInvalid.content[0].text, /Invalid arguments for tool issue_get_evidence/);
      assert.equal(calls.length, sourceCallCount);
    }

    const assertTypedSourceError = async (issueId: string, code: string) => {
      const result = await client.callTool({ name: "issue_get_evidence", arguments: {
        issue_id: issueId,
        expected_project_id: projectA,
      } }) as any;
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).code, code);
      assert.equal(result.structuredContent.error_code, code);
      assert.equal(audit.records.at(-1)?.code, code);
      return result;
    };
    await assertTypedSourceError("FILMOS-ISSUE-cross-project", "PROJECT_SCOPE_DENIED");
    await assertTypedSourceError("FILMOS-ISSUE-missing", "ISSUE_NOT_FOUND");
    await assertTypedSourceError("FILMOS-ISSUE-invalid-argument", "INVALID_ARGUMENT");
    await assertTypedSourceError("FILMOS-ISSUE-invalid-scope-message", "INVALID_ARGUMENT");
    await assertTypedSourceError("FILMOS-ISSUE-scope-ordinary-message", "PROJECT_SCOPE_DENIED");

    assert.ok(audit.records.some((record) => record.action === "issue_get_codex_assessment_blind" && record.project_id === projectA && record.outcome === "ALLOW"));
    assert.ok(audit.records.some((record) => record.action === "issue_get_evidence" && record.project_id === projectA && record.outcome === "DENY" && record.code === "PROJECT_SCOPE_DENIED"));
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

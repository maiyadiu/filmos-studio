#!/usr/bin/env node
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [mcpURL, projectID, issueID] = process.argv.slice(2);
const token = process.env.FILMOS_CANARY_PROJECT_GRANT ?? "";
assert.match(mcpURL ?? "", /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/mcp$/);
assert.match(projectID ?? "", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
assert.match(issueID ?? "", /^FILMOS-ARCH-[A-Za-z0-9-]{1,120}$/);
assert.ok(token.length >= 24, "temporary Project Grant is required");

const client = new Client({ name: "filmos-packaged-review-canary", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const manifest = await client.listTools();
  for (const name of ["issue_list_pending", "issue_get_evidence"]) {
    const tool = manifest.tools.find((item) => item.name === name);
    assert.ok(tool, `${name} missing from packaged MCP`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  const pending = await client.callTool({ name: "issue_list_pending", arguments: {} });
  assert.equal(pending.isError, undefined);
  assert.ok(Array.isArray(pending.structuredContent?.issues));
  assert.ok(pending.structuredContent.issues.some((item) => item.issue_id === issueID && item.project_id === projectID));
  const evidence = await client.callTool({ name: "issue_get_evidence", arguments: { issue_id: issueID } });
  assert.equal(evidence.isError, undefined);
  assert.equal(evidence.structuredContent?.issue_id, issueID);
  assert.equal(evidence.structuredContent?.project_id, projectID);
  assert.ok(evidence.structuredContent?.evidence?.manifest?.contentHash);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    project_id: projectID,
    issue_id: issueID,
    pending_read: true,
    evidence_read: true,
    read_tools: ["issue_list_pending", "issue_get_evidence"],
    mcp_tool_count: manifest.tools.length,
  })}\n`);
} finally {
  await client.close().catch(() => undefined);
}

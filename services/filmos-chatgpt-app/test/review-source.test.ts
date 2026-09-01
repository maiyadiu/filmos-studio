import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { HttpReviewReadSource } from "../src/review-source.js";

test("Review read adapter stays loopback, bearer protected, Project Grant scoped, and identifies the actual MCP handler", async () => {
  let observed: { path: string; authorization: string | undefined; consumer: string | undefined } | null = null;
  const server = createServer((req, res) => {
    observed = { path: req.url ?? "", authorization: req.headers.authorization, consumer: req.headers["x-filmos-read-consumer"] as string | undefined };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ issue_id: "FILMOS-ISSUE-test", project_id: "project-scope-a", evidence: { redacted: true } }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const token = "review-token-review-token-123456";
  try {
    const source = new HttpReviewReadSource(`http://127.0.0.1:${port}`, token);
    const value = await source.read("issue_get_evidence", { issue_id: "FILMOS-ISSUE-test" }, "project-scope-a");
    assert.equal(value.issue_id, "FILMOS-ISSUE-test");
    assert.equal(observed?.authorization, `Bearer ${token}`);
    assert.equal(observed?.consumer, "chatgpt-mcp");
    assert.match(observed?.path ?? "", /project_id=project-scope-a/);
    assert.throws(() => new HttpReviewReadSource("https://review.example.com", token), /must use loopback HTTP/);
    assert.throws(() => new HttpReviewReadSource("https://127.0.0.1:17920", token), /must use loopback HTTP/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Review read adapter rejects a historical Issue projected from another project", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ issue_id: "FILMOS-ISSUE-historical", project_id: "historical-project", evidence: { redacted: true } }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const source = new HttpReviewReadSource(`http://127.0.0.1:${port}`, "review-token-review-token-123456");
    await assert.rejects(
      source.read("issue_get_evidence", { issue_id: "FILMOS-ISSUE-historical" }, "current-project"),
      (error: any) => error?.code === "PROJECT_SCOPE_DENIED",
    );
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

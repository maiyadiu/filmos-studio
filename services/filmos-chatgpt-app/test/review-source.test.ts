import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { HttpReviewReadSource } from "../src/review-source.js";

test("Review read adapter stays loopback, bearer protected, and Project Grant scoped", async () => {
  let observed: { path: string; authorization: string | undefined } | null = null;
  const server = createServer((req, res) => {
    observed = { path: req.url ?? "", authorization: req.headers.authorization };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ issue_id: "FILMOS-ISSUE-test", evidence: { redacted: true } }));
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
    assert.match(observed?.path ?? "", /project_id=project-scope-a/);
    assert.throws(() => new HttpReviewReadSource("https://review.example.com", token), /must use loopback HTTP/);
    assert.throws(() => new HttpReviewReadSource("https://127.0.0.1:17920", token), /must use loopback HTTP/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

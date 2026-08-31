import assert from "node:assert/strict";
import test from "node:test";

import { CodexReviewWatcher } from "../src/watcher.mjs";

test("Codex Watcher emits only new or changed issue projections", async () => {
  let version = 1;
  const fetchImpl = async () => new Response(JSON.stringify({ issues: [{ issue_id: "FILMOS-ISSUE-1", content_hash: `hash-${version}`, state: "EVIDENCE_FROZEN" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const watcher = new CodexReviewWatcher({ baseUrl: "http://127.0.0.1:17920", token: "token-token-token-token-token", projectId: "filmos-global", fetchImpl });
  assert.equal((await watcher.poll()).length, 1);
  assert.equal((await watcher.poll()).length, 0);
  version = 2;
  assert.equal((await watcher.poll()).length, 1);
});

test("Codex Watcher stops promptly when its owner aborts the local watch", async () => {
  const controller = new AbortController();
  const watcher = new CodexReviewWatcher({
    baseUrl: "http://127.0.0.1:17920",
    token: "token-token-token-token-token",
    projectId: "filmos-global",
    intervalMs: 250,
    fetchImpl: async () => new Response(JSON.stringify({ issues: [] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const watching = watcher.watch(() => undefined, controller.signal);
  controller.abort(new Error("OWNER_STOPPED_WATCHER"));
  await assert.rejects(watching, /OWNER_STOPPED_WATCHER/);
});

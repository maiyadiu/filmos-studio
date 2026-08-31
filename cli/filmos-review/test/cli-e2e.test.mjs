import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createReviewBusHttp } from "../../../services/filmos-review-bus/src/server.mjs";
import { ReviewBusService } from "../../../services/filmos-review-bus/src/service.mjs";
import { ReviewBusStore } from "../../../services/filmos-review-bus/src/store.mjs";

const execFileAsync = promisify(execFile);

test("filmos CLI creates a real IssueSession through the loopback Review Bus", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "filmos-review-cli-"));
  const token = "bus-token-1234567890-abcdefghijkl";
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store);
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken: "bridge-token-1234567890-abcdefghijkl", constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const input = resolve(temp, "issue.json");
  writeFileSync(input, JSON.stringify({ project_id: "filmos-global", what_happened: "button unclear", expected_result: "clear label", location: "settings", blocks_work: false }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [resolve(import.meta.dirname, "../filmos"), "issue", "create", "--json", input], { env: { ...process.env, FILMOS_REVIEW_BUS_TOKEN: token, FILMOS_REVIEW_BUS_BASE_URL: `http://127.0.0.1:${port}` } });
    const receipt = JSON.parse(stdout);
    assert.match(receipt.issue_id, /^FILMOS-ISSUE-/);
    assert.equal(receipt.state, "EVIDENCE_REQUIRED");
    assert.ok(service.requireIssue(receipt.issue_id).evidence.manifest.contentHash);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

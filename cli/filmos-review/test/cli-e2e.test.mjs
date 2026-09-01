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

test("filmos CLI fails closed for legacy intake and still reads existing IssueSessions", async () => {
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
    const environment = { ...process.env, FILMOS_REVIEW_BUS_TOKEN: token, FILMOS_REVIEW_BUS_BASE_URL: `http://127.0.0.1:${port}` };
    await assert.rejects(
      execFileAsync(process.execPath, [resolve(import.meta.dirname, "../filmos"), "issue", "create", "--json", input], { env: environment }),
      (error) => error.code === 1 && error.stderr.trim() === "INTAKE_PROTOCOL_UPGRADE_REQUIRED",
    );

    const existing = service.createIssue({
      project_id: "filmos-global",
      issue_id: "FILMOS-ISSUE-cli-existing",
      what_happened: "existing issue",
      expected_result: "remain readable",
      location: "settings",
      blocks_work: false,
    }, "acceptance-fixture");
    const { stdout } = await execFileAsync(process.execPath, [resolve(import.meta.dirname, "../filmos"), "issue", "status", "--issue", existing.issue_id, "--project", "filmos-global"], { env: environment });
    const projection = JSON.parse(stdout);
    assert.equal(projection.issue_id, existing.issue_id);
    assert.equal(projection.state, "OBSERVED_IN_USE");
    assert.equal(projection.content_hash, service.requireIssue(existing.issue_id).content_hash);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

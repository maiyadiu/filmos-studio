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

test("filmos CLI advances an immutable Candidate A into a clean Candidate B round", async () => {
  const token = "bus-token-1234567890-abcdefghijkl";
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store, { candidateEvidenceVerifier: { verify: async (candidate) => ({ verified: true, candidate_commit: candidate.candidate_commit, tree: candidate.tree, artifact_digest: candidate.artifact_digest, evidence_index_hash: candidate.evidence_index_hash }) } });
  const issue = service.createIssue({ issue_id: "FILMOS-ISSUE-cli-round", project_id: "filmos-global", what_happened: "Candidate A failed", expected_result: "Candidate B can start", location: "review", blocks_work: true, lane: "fast" });
  await service.submitCandidate(issue.issue_id, { candidate_id: "candidate-a", base_commit: "6ea93bfa08381264a1379fe938ade3a7513c7bba", candidate_commit: "d".repeat(40), tree: "e".repeat(40), branch: "fix/example", github_run: { id: 123, head_sha: "d".repeat(40), conclusion: "success" }, artifact_id: "artifact-1", artifact_digest: `sha256:${"f".repeat(64)}`, artifact_commit: "d".repeat(40), evidence_index_hash: "a".repeat(64), task_package_content_hash: "99ebaf3b0415c3704c488dbfc23828ecccc3b5b03486a3bf759c586681782893", constitution_content_hash: "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41", candidate_nonce: "nonce-1234567890-abcdef", changed_files: ["web/copy.ts"], known_limitations: [] });
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken: "bridge-token-1234567890-abcdefghijkl", constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  try {
    const { stdout } = await execFileAsync(process.execPath, [resolve(import.meta.dirname, "../filmos"), "review", "next-round", "--issue", issue.issue_id], { env: { ...process.env, FILMOS_REVIEW_BUS_TOKEN: token, FILMOS_REVIEW_BUS_BASE_URL: `http://127.0.0.1:${port}` } });
    assert.equal(JSON.parse(stdout).state, "CODEX_IMPLEMENTING");
    const projection = service.requireIssue(issue.issue_id);
    assert.equal(projection.current_round, 2);
    assert.equal(projection.active_candidate, null);
    assert.equal(projection.candidate_history[0].candidate_id, "candidate-a");
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); store.close(); }
});

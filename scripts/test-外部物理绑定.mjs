import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PHASE7, bindPhase6Package, sha256, validateNestedProcessDerivation } from "./filmos-external-read-runtime.mjs";

// This check belongs to the frozen workstation, not portable CI: the real
// validator pins OS executable hashes and Python 3.14 symlinks. No service,
// Production database, saved context or Keychain operation is invoked.
test("pinned workstation validator retains physical metadata and command resolution", async () => {
  const result = await validateNestedProcessDerivation();
  assert.equal(result.evidence_standard, "PINNED_CODE_PLUS_READY_POST_ZERO_SURVIVORS_ACCEPTED");
  assert.equal(Object.keys(result.files).length, 9);
  for (const value of Object.values(result.files)) {
    assert.ok(value.path.startsWith("/"));
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    assert.ok(value.size > 0);
    assert.equal(Number.isInteger(value.mode), true);
  }
  assert.ok(result.minimal_path_resolution.python3.startsWith("/"));
  assert.ok(result.minimal_path_resolution.git.startsWith("/"));
  assert.equal(result.total_transient_process_invocations, "52..53");
  assert.equal(result.total_source_fingerprint_invocations, 3);
  assert.equal(result.total_git_invocations, 31);
});

test("pinned Phase 6 template retains exact bytes, twelve tokens and historical source references", async () => {
  const template = await readFile(PHASE7.templatePath, "utf8");
  assert.equal(sha256(template), PHASE7.templateSha256);
  const source = { git_commit_sha: "1".repeat(40), git_tree_sha: "2".repeat(40), source_fingerprint_sha256: "3".repeat(64), build_id: "development-synthetic-pinned-test" };
  const bound = {
    project_grant_id: "synthetic-grant",
    project_grant_issued_at: "2026-09-05T01:00:00.000Z",
    project_grant_expires_at: "2026-09-05T02:00:00.000Z",
    challenge_id: "synthetic-challenge",
    context_receipt_id: "filmos-live:" + "a".repeat(64),
    live_context_expires_at: "2026-09-05T01:05:00.000Z",
    content_unit_id: "synthetic-unit",
    canvas_id: "synthetic-canvas",
    canvas_state_hash: "b".repeat(64),
  };
  const result = bindPhase6Package(template, bound, source);
  assert.equal(Object.keys(result.placeholderValues).length, 12);
  assert.equal(result.sourceReplacements.length, 4);
  assert.equal(result.sourceReplacements.reduce((sum, item) => sum + item.occurrence_count, 0), 5);
  assert.doesNotMatch(result.output, /<JIT_[A-Z0-9_]+>/);
  for (const oldValue of Object.values(PHASE7.legacySource)) assert.equal(result.output.includes(oldValue), false);
  assert.match(result.output, /ee8aac7d044fce067487b18a82b4eaf9c7b4c9f5/);
  assert.match(result.output, /964f590a52c75c40b878a869742b5f37631efeb2/);
  assert.equal(await readFile(PHASE7.templatePath, "utf8"), template);
});

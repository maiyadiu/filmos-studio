import assert from "node:assert/strict";
import test from "node:test";
import { validateNestedProcessDerivation } from "./filmos-external-read-runtime.mjs";

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

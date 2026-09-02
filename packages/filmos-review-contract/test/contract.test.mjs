import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("canonical Review Contract bindings are current in every runtime", () => {
  execFileSync(process.execPath, ["scripts/generate.mjs", "--check"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
});

test("contract covers governance authority and desktop boundary", () => {
  const value = JSON.parse(readFileSync(new URL("../contract.v1.json", import.meta.url), "utf8"));
  assert.deepEqual(value.lanes, ["fast", "core", "architecture"]);
  assert.equal(value.ids.submission_prefix, "FILMOS-SUBMISSION");
  assert.equal(value.submission.required_keys.includes("project_id"), true);
  assert.equal(value.formal_issue_receipt.required_keys.includes("formal_issue_id"), true);
  assert.equal(value.architecture_hash_binding.required_keys.includes("architecture_transition_contract_hash"), true);
  assert.deepEqual(Object.keys(value.desktop_rpc.actions).sort(), ["chatgptHostRequest", "reviewCenterRequest", "reviewIssueAttachmentRequest", "reviewIssueFinalizeRequest", "reviewIssueRequest"]);
});

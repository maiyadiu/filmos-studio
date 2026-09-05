import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { checkArchitectureDrift, checkGitArchitectureDrift, constitutionHash } from "../architecture-drift-gate.mjs";

test("constitution hash is deterministic and current", () => {
  const value = JSON.parse(readFileSync(resolve(import.meta.dirname, "../FILMOS_CONSTITUTION.json"), "utf8"));
  assert.equal(constitutionHash(value), value.content_hash);
});

test("drift gate blocks Developer Governance inside Film Core and unsafe shortcuts", () => {
  const result = checkArchitectureDrift({
    changedFiles: ["film-core/review-bus/session.py"],
    patch: "automatic approve then skip QC",
    declaredScope: [],
  });
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((item) => item.gate === "DEVELOPER-GOVERNANCE-OUTSIDE-FILM-CORE-001"));
  assert.ok(result.findings.some((item) => item.gate === "CANDIDATE-QC-BOUNDARY-001"));
});

test("constitutional amendments require an architecture declaration", () => {
  const blocked = checkArchitectureDrift({ changedFiles: ["governance/FILMOS_CONSTITUTION.json"] });
  assert.equal(blocked.passed, false);
  const allowed = checkArchitectureDrift({ changedFiles: ["governance/FILMOS_CONSTITUTION.json"], declaredScope: ["constitution_amendment"] });
  assert.equal(allowed.passed, true);
});

function repository(t) {
  const root = mkdtempSync(resolve(tmpdir(), "filmos-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const write = (path, text) => {
    mkdirSync(resolve(root, path, ".."), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  write("baseline.txt", "automatic approve then skip QC\n");
  git("add", ".");
  git("commit", "-qm", "fixture baseline");
  return { root, git, write };
}

test("actual worktree checks staged and untracked forbidden paths without synthetic input", (t) => {
  const { root, git, write } = repository(t);
  write("film-core/review-bus/new.py", "pass\n");
  write("backend/service/developer-governance.mjs", "export {};\n");
  git("add", "film-core");
  const result = checkGitArchitectureDrift({ root });
  assert.equal(result.passed, false);
  assert.equal(result.input_kind, "GIT_WORKTREE");
  assert.equal(result.findings.length, 2);
  assert.equal(result.untracked_content_not_scanned, 1);
});

test("actual commit range catches constitution changes and rejects unknown base", (t) => {
  const { root, git, write } = repository(t);
  const base = git("rev-parse", "HEAD");
  write("governance/FILMOS_CONSTITUTION.md", "changed\n");
  git("add", ".");
  git("commit", "-qm", "amendment fixture");
  assert.equal(checkGitArchitectureDrift({ root, base, head: "HEAD" }).passed, false);
  assert.equal(checkGitArchitectureDrift({ root, base, head: "HEAD", declaredScope: ["constitution_amendment"] }).passed, true);
  assert.throws(() => checkGitArchitectureDrift({ root, base: "missing-base" }));
});

test("removed shortcuts are not introduced behavior; legitimate remote text is only a review signal", (t) => {
  const { root, write } = repository(t);
  write("baseline.txt", "remote client with confirmation\n");
  const result = checkGitArchitectureDrift({ root });
  assert.equal(result.passed, true);
  assert.deepEqual(result.review_signals, [{ gate: "LOCAL-FIRST-001" }]);
  assert.match(result.patch_sha256, /^[a-f0-9]{64}$/);
});

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_ID = "ARCHITECTURE-DRIFT-GATE-001";

const protectedPatterns = [
  { id: "NO-SECOND-AUTHORITY-001", test: /(?:second|parallel|alternate)[-_ ](?:film[-_ ]?core|candidate|broker|authority)/i },
  { id: "LOCAL-FIRST-001", test: /(?:remote|required cloud|cloud only|remote only)/i },
  { id: "BRAIN-ENGINE-SEPARATION-001", test: /(?:brain[^\n]{0,48}generation engine|generation engine[^\n]{0,48}brain).*(?:same|merge|unified identity)/i },
  { id: "CANDIDATE-QC-BOUNDARY-001", test: /(?:auto|automatic).{0,24}(?:approve|approved)|skip.{0,16}(?:candidate|qc)/i },
  { id: "HUMAN-COST-CONFIRMATION-001", test: /(?:paid|upload|external project).{0,40}(?:without|bypass|skip).{0,20}(?:confirm|approval)/i },
];

const forbiddenCorePaths = [
  /^film-core\/.*review-bus/i,
  /^film-core\/.*(?:issue-session|consensus-record)/i,
  /^backend\/.+developer-governance/i,
];

export function constitutionHash(contract) {
  const value = { ...contract };
  delete value.content_hash;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function checkArchitectureDrift({ changedFiles = [], patch = "", declaredScope = [] }) {
  const findings = [];
  for (const path of changedFiles) {
    if (forbiddenCorePaths.some((pattern) => pattern.test(path))) findings.push({ gate: "DEVELOPER-GOVERNANCE-OUTSIDE-FILM-CORE-001", path });
    if (path === "governance/FILMOS_CONSTITUTION.json" || path === "governance/FILMOS_CONSTITUTION.md") {
      if (!declaredScope.includes("constitution_amendment")) findings.push({ gate: "CONSTITUTION-NO-SILENT-AMEND-001", path });
    }
  }
  for (const rule of protectedPatterns) if (rule.test.test(patch)) findings.push({ gate: rule.id });
  return { gate_id: GATE_ID, passed: findings.length === 0, findings };
}

// Git-derived checks block structural boundaries. Keyword hits are review
// signals, not a semantic proof: e.g. a legitimate remote client contains "remote".
export function checkGitArchitectureDrift({ root, base = "HEAD", head = null, declaredScope = [] }) {
  const git = (...args) => execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  const commit = (ref) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  const baseCommit = commit(base);
  const headCommit = head ? commit(head) : null;
  const revisions = headCommit ? [baseCommit, headCommit] : [baseCommit];
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const changedFiles = git(...diffArgs, "--name-only", "-z", ...revisions, "--").split("\0").filter(Boolean);
  const untracked = headCommit ? [] : git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  const files = [...new Set([...changedFiles, ...untracked])].sort();
  const patch = git(...diffArgs, "--unified=0", ...revisions, "--");
  // Removed lines and diff context must not make a corrective patch look like
  // an introduction of the old behavior. Untracked material is not read.
  const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  const result = checkArchitectureDrift({ changedFiles: files, declaredScope });
  return {
    ...result,
    input_kind: headCommit ? "GIT_COMMIT_RANGE" : "GIT_WORKTREE",
    base_commit: baseCommit,
    head_commit: headCommit,
    changed_files: files,
    untracked_content_not_scanned: untracked.length,
    patch_sha256: createHash("sha256").update(patch).digest("hex"),
    review_signals: protectedPatterns.filter((rule) => rule.test.test(additions)).map(({ id }) => ({ gate: id })),
    coverage: "STRUCTURAL_PATHS_AND_CONSTITUTION_HASH_ONLY; KEYWORDS_REQUIRE_HUMAN_REVIEW",
  };
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const contract = JSON.parse(readFileSync(resolve(root, "governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const hash = constitutionHash(contract);
  if (hash !== contract.content_hash) throw new Error(`FILMOS-CONSTITUTION-HASH-001 failed: expected ${contract.content_hash}, got ${hash}`);
  const args = process.argv.slice(2);
  let result;
  if (args.length === 1 && !args[0].startsWith("--")) {
    result = checkArchitectureDrift(JSON.parse(readFileSync(resolve(args[0]), "utf8")));
  } else {
    let base = process.env.FILMOS_DIFF_BASE || "HEAD";
    let head = process.env.FILMOS_DIFF_HEAD || null;
    const declaredScope = [];
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
      if (flag === "--base") base = value;
      else if (flag === "--head") head = value;
      else if (flag === "--scope") declaredScope.push(value);
      else throw new Error(`unknown option: ${flag}`);
    }
    if (process.env.CI === "true" && (!process.env.FILMOS_DIFF_BASE || !process.env.FILMOS_DIFF_HEAD) && !args.includes("--head")) {
      throw new Error("ARCHITECTURE_DIFF_RANGE_REQUIRED: CI must supply actual base and head commits");
    }
    result = checkGitArchitectureDrift({ root, base, head, declaredScope });
  }
  process.stdout.write(`${JSON.stringify({ ...result, constitution_version: contract.constitution_version, constitution_content_hash: hash })}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))) main();

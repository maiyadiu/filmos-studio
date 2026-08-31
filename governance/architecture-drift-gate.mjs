#!/usr/bin/env node
import { createHash } from "node:crypto";
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

function main() {
  const root = resolve(import.meta.dirname, "..");
  const contract = JSON.parse(readFileSync(resolve(root, "governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const hash = constitutionHash(contract);
  if (hash !== contract.content_hash) throw new Error(`FILMOS-CONSTITUTION-HASH-001 failed: expected ${contract.content_hash}, got ${hash}`);
  const input = process.argv[2] ? JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")) : { changedFiles: [], patch: "", declaredScope: [] };
  const result = checkArchitectureDrift(input);
  process.stdout.write(`${JSON.stringify({ ...result, constitution_version: contract.constitution_version, constitution_content_hash: hash })}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))) main();

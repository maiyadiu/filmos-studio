import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkArchitectureDrift, constitutionHash } from "../architecture-drift-gate.mjs";

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

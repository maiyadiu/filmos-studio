#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { sha256 } from "../src/canonical.mjs";
import { loadInstalledSourceIdentity } from "../src/installed-source-identity.mjs";
import { ReviewBusService } from "../src/service.mjs";
import { createReviewBusHttp } from "../src/server.mjs";
import { ReviewBusStore } from "../src/store.mjs";

const projectId = "22222222-2222-4222-8222-222222222222";
const submissionId = "FILMOS-SUBMISSION-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const issueId = "FILMOS-ARCH-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const directory = mkdtempSync(resolve(tmpdir(), "filmos-stage-b-canary-"));
const repository = resolve(directory, "DeveloperRepository", "filmos-studio");
const resources = resolve(directory, "FilmOS Studio.app", "Contents", "Resources");
const locatorPath = resolve(directory, "review-bus", "developer-repository.json");
const databasePath = resolve(directory, "review-bus", "review-bus.sqlite");
mkdirSync(repository, { recursive: true });
mkdirSync(resources, { recursive: true });
mkdirSync(dirname(locatorPath), { recursive: true });

execFileSync("/usr/bin/git", ["-C", repository, "init", "-q"]);
execFileSync("/usr/bin/git", ["-C", repository, "config", "user.name", "FilmOS Canary"]);
execFileSync("/usr/bin/git", ["-C", repository, "config", "user.email", "filmos-canary@example.invalid"]);
execFileSync("/usr/bin/git", ["-C", repository, "remote", "add", "origin", "https://github.com/maiyadiu/filmos-studio.git"]);
execFileSync("/usr/bin/git", ["-C", repository, "remote", "set-url", "--push", "origin", "git@github.com:maiyadiu/filmos-studio.git"]);
writeFileSync(resolve(repository, "canary.txt"), "stage-b installed source identity\n");
execFileSync("/usr/bin/git", ["-C", repository, "add", "canary.txt"]);
execFileSync("/usr/bin/git", ["-C", repository, "commit", "-qm", "test: stage b installed identity"]);

const sourceCommit = git("rev-parse", "HEAD");
const sourceTree = git("rev-parse", "HEAD^{tree}");
const fingerprint = "b".repeat(64);
const buildId = `candidate-${sourceCommit.slice(0, 8)}-${sourceTree.slice(0, 8)}`;
const sourcePath = resolve(resources, "SourceIdentity.json");
const runtimePath = resolve(resources, "InternalRuntime.json");
writeFileSync(sourcePath, JSON.stringify({
  schema_version: "1.0.0",
  repository: "maiyadiu/filmos-studio",
  source_fingerprint_sha256: fingerprint,
  git_commit_sha: sourceCommit,
  git_tree_sha: sourceTree,
  source_file_count: 1,
  source_scopes: ["services/filmos-review-bus"],
  source_clean: true,
  build_id: buildId,
  release_channel: "candidate",
  external_paid_submit_enabled: false,
}));
writeFileSync(runtimePath, JSON.stringify({
  schema_version: 4,
  source_repository: "maiyadiu/filmos-studio",
  source_commit: sourceCommit,
  source_tree: sourceTree,
  source_fingerprint_sha256: fingerprint,
  build_id: buildId,
  release_channel: "candidate",
  external_paid_submit_enabled: false,
}));
writeFileSync(locatorPath, JSON.stringify({
  schema_version: "1.0.0",
  repository: "maiyadiu/filmos-studio",
  source_repository: repository,
  source_commit: sourceCommit,
  source_tree: sourceTree,
}));

const installedSourceIdentity = loadInstalledSourceIdentity({
  sourceIdentityPath: sourcePath,
  internalRuntimePath: runtimePath,
  repositoryLocatorPath: locatorPath,
});
const store = new ReviewBusStore(databasePath);
const service = new ReviewBusService(store);
const legacy = service.createIssue({
  issue_id: "FILMOS-ARCH-stage-b-legacy",
  project_id: projectId,
  what_happened: "Legacy Architecture history predates protocol v2.",
  expected_result: "Startup adds one semantic Anchor without rewriting history.",
  location: "canary:legacy",
  blocks_work: false,
  lane: "architecture",
}, "user", new Date("2026-09-02T00:00:00.000Z"), {
  baseCommit: sourceCommit,
  architectureProtocolVersion: null,
});
const legacyBaseCommit = legacy.base_commit;
const legacyPrefix = store.events(legacy.issue_id).map((event) => event.event_hash);
const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
const token = "stage-b-canary-token-1234567890-abcdefghijkl";
const server = createReviewBusHttp({
  service,
  store,
  busToken: token,
  bridgeToken: "stage-b-canary-bridge-1234567890-abcdefghijkl",
  constitution,
  installedSourceIdentity,
  now: () => new Date("2026-09-02T00:10:00.000Z"),
});

try {
  const anchored = service.requireIssue(legacy.issue_id);
  assert.equal(anchored.base_commit, legacyBaseCommit);
  assert.deepEqual(store.events(legacy.issue_id).slice(0, legacyPrefix.length).map((event) => event.event_hash), legacyPrefix);
  assert.equal(store.events(legacy.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 1);

  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const capturedAt = "2026-09-02T00:11:00.000Z";
  const submission = {
    submission_id: submissionId,
    project_id: projectId,
    what_happened: "Installed App must bind new Architecture intake to verified source identity.",
    expected_result: "Owner gate remains authoritative before Evidence Frozen.",
    location: "agent:/canvas/stage-b-canary",
    blocks_work: false,
    captured_at: capturedAt,
    risk: { architecture_gap: true },
    suggested_lane: "architecture",
    allowed_change_scope: [],
    app_build_id: buildId,
    app_tree: sourceTree,
    route: "/canvas/stage-b-canary",
    context_snapshot: { domainProjectId: projectId, runtimeStatus: { reviewBus: "ready" } },
    attachment_manifest: [],
  };
  const staged = await request(`${baseURL}/v1/submissions`, { method: "POST", headers, body: submission });
  assert.equal(staged.status, 201);
  const finalized = await request(`${baseURL}/v1/submissions/${submissionId}/finalize`, {
    method: "POST",
    headers,
    body: { project_id: projectId, capture_hash: staged.body.capture_hash },
  });
  assert.equal(finalized.status, 201);
  assert.equal(finalized.body.receipt.formal_issue_id, issueId);
  assert.equal(finalized.body.receipt.source_identity_hash, installedSourceIdentity.content_hash);
  const observed = service.requireIssue(issueId);
  assert.equal(observed.state, "REQUIREMENT_OBSERVED");
  assert.equal(observed.requirement_delta, undefined);
  assert.equal(store.events(issueId).filter((event) => event.event_type === "architecture.intake_evidence.recorded").length, 1);

  const requirement = await request(`${baseURL}/v1/issues/${issueId}/architecture/requirement-delta`, {
    method: "POST",
    headers,
    body: {
      current_flow: "Installed App submits one verified source-bound Architecture observation.",
      current_blocker: "Evidence must not bypass the Owner Requirement Delta gate.",
      target_experience: "Owner freezes scope before independent assessments begin.",
      must_preserve: ["Review Bus authority", "historical base commit"],
      may_change: ["Installed SourceIdentity composition"],
      success_criteria: ["Architecture assessments start only after formal Evidence Frozen"],
    },
  });
  assert.equal(requirement.status, 200);
  assert.equal(requirement.body.state, "REQUIREMENT_DELTA_FROZEN");
  const evidence = await request(`${baseURL}/v1/issues/${issueId}/evidence/freeze`, {
    method: "POST",
    headers,
    body: { source_commit: sourceCommit, items: observed.evidence.local_items },
  });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.state, "ARCHITECTURE_EVIDENCE_FROZEN");
  const assessment = await request(`${baseURL}/v1/issues/${issueId}/architecture/assessments/begin`, { method: "POST", headers, body: {} });
  assert.equal(assessment.status, 200);
  assert.equal(assessment.body.state, "ARCHITECTURE_ASSESSMENTS_PENDING");
  assert.equal(store.verifyEventChain(issueId), true);
  assert.equal(store.verifyEventChain(legacy.issue_id), true);

  const result = {
    schema_version: "filmos.review-stage-b-canary.v1",
    status: "PASS",
    installed_source_identity_hash: installedSourceIdentity.content_hash,
    installed_commit: sourceCommit,
    installed_tree: sourceTree,
    canonical_issue_id: issueId,
    submission_receipt_hash: finalized.body.receipt.receipt_hash,
    intake_state: observed.state,
    owner_gate_state: requirement.body.state,
    evidence_state: evidence.body.state,
    assessment_state: assessment.body.state,
    legacy_anchor_count: 1,
    legacy_base_commit_preserved: true,
    event_chains_verified: true,
    external_network_requests: 0,
    openai_model_api_calls: 0,
    paid_provider_operations: 0,
  };
  process.stdout.write(`${JSON.stringify({ ...result, result_hash: sha256(result) }, null, 2)}\n`);
} finally {
  if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

function git(...args) {
  return execFileSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

async function request(url, { method = "GET", headers, body } = {}) {
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

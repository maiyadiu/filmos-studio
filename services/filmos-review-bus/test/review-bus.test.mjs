import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { sha256 } from "../src/canonical.mjs";
import { defaultReadArtifactEvidenceIndex, GitHubEvidenceVerifier, resolveGitHubCLI } from "../src/github-evidence-verifier.mjs";
import { buildLiveRoundtripTrace } from "../src/live-roundtrip-trace.mjs";
import { ReviewBusService, candidateBinding, fileInScope } from "../src/service.mjs";
import { allowedOrigin, createReviewBusHttp } from "../src/server.mjs";
import { ReviewBusStore } from "../src/store.mjs";
import { redactEvidence } from "../src/redaction.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const commit = "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a";
const taskHash = "7cf9bed457611e44a6b1f1bbb96968f20d83edec0d7d00bedfc73c7cdea2a10f";
const constitutionHash = "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41";

test("GitHub CLI resolver honors an explicit executable for Dock-launched Review Bus", () => {
  assert.equal(resolveGitHubCLI({ FILMOS_GH_EXECUTABLE: "/bin/sh" }), "/bin/sh");
});

test("candidate scope matches exact paths even when the frozen descriptor marks a file as not yet existing", () => {
  assert.equal(fileInScope("web/new-view.ts", "web/new-view.ts（当前不存在）"), true);
  assert.equal(fileInScope("web/new-view.ts", "web/new-view.ts（冻结基线中不存在）"), true);
  assert.equal(fileInScope("web/other.ts", "web/new-view.ts（当前不存在）"), false);
  assert.equal(fileInScope("web/new-view.ts（当前不存在）", "web/new-view.ts（当前不存在）"), false);
});

test("GitHub evidence reader accepts exactly one Evidence Index inside the Handoff ZIP", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-nested-evidence-test-"));
  const packetDirectory = resolve(directory, "handoff", "packet");
  const handoffPath = resolve(directory, "handoff.zip");
  const artifactPath = resolve(directory, "artifact.zip");
  const evidence = Buffer.from('{"schemaVersion":"filmos.evidence-index.v1"}\n');
  try {
    mkdirSync(packetDirectory, { recursive: true });
    writeFileSync(resolve(packetDirectory, "EVIDENCE_INDEX.json"), evidence, { mode: 0o600 });
    execFileSync("zip", ["-q", "-r", handoffPath, "packet"], { cwd: resolve(directory, "handoff") });
    execFileSync("zip", ["-q", artifactPath, "handoff.zip"], { cwd: directory });
    assert.deepEqual(await defaultReadArtifactEvidenceIndex({ path: artifactPath }), evidence);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub evidence reader fails closed for missing or ambiguous Evidence Index bytes", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-nested-evidence-negative-test-"));
  const evidence = Buffer.from('{"schemaVersion":"filmos.evidence-index.v1"}\n');
  const missingPath = resolve(directory, "missing.zip");
  const duplicatePath = resolve(directory, "duplicate.zip");
  const nestedPath = resolve(directory, "handoff.zip");
  try {
    writeFileSync(resolve(directory, "README.json"), "{}\n", { mode: 0o600 });
    execFileSync("zip", ["-q", missingPath, "README.json"], { cwd: directory });
    await assert.rejects(() => defaultReadArtifactEvidenceIndex({ path: missingPath }), /ARTIFACT_EVIDENCE_INDEX_MISSING/);

    writeFileSync(resolve(directory, "EVIDENCE_INDEX.json"), evidence, { mode: 0o600 });
    execFileSync("zip", ["-q", nestedPath, "EVIDENCE_INDEX.json"], { cwd: directory });
    execFileSync("zip", ["-q", duplicatePath, "EVIDENCE_INDEX.json", "handoff.zip"], { cwd: directory });
    await assert.rejects(() => defaultReadArtifactEvidenceIndex({ path: duplicatePath }), /ARTIFACT_EVIDENCE_INDEX_AMBIGUOUS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  return { store, service };
}

function createCoreIssue(service, suffix = "a") {
  const issue = service.createIssue({ issue_id: `FILMOS-ISSUE-${suffix}`, project_id: projectId, what_happened: "Host request failed", expected_result: "ChatGPT answers", location: "Agent panel", blocks_work: true, lane: "core" });
  service.freezeEvidence(issue.issue_id, { source_commit: commit, items: [
    { kind: "reproduction", completeness_kind: "reproduction", content: { steps: ["click", "send"] } },
    { kind: "runtime", completeness_kind: "runtime", content: { state: "failed", runtime_key: "secret-value" } },
    { kind: "logs", completeness_kind: "logs", content: "Bearer abcdefghijklmnop /Users/alice/private/log.json" },
    { kind: "source", completeness_kind: "sourceMap", content: { file: "web/agent.tsx" } },
  ] });
  return service.requireIssue(issue.issue_id);
}

function createFastIssue(service, suffix, scope = ["web/copy.ts"]) {
  const issue = service.createIssue({ issue_id: `FILMOS-ISSUE-${suffix}`, project_id: projectId, what_happened: "Wording is unclear", expected_result: "Clear wording", location: scope[0], blocks_work: false, lane: "fast", allowed_change_scope: scope });
  return service.freezeEvidence(issue.issue_id, { source_commit: commit, items: [
    { kind: "reproduction", completeness_kind: "reproduction", content: { steps: ["open"] } },
    { kind: "runtime", completeness_kind: "runtime", content: { state: "ready" } },
    { kind: "logs", completeness_kind: "logs", content: "no runtime errors" },
    { kind: "source", completeness_kind: "sourceMap", content: { files: scope } },
  ] });
}

const codexAssessment = { reproduced: true, root_cause: "host context is stale", call_chain: ["ui", "host"], files: ["web/agent.tsx"], minimal_change: ["refresh context"], regression_risk: "low", tests: ["host context test"], rollback: ["revert"] };
const chatgptAssessment = { product_goal_fit: false, root_cause: "host context is stale", root_cause_explains_symptom: true, authority_risk: false, resolution_layer: "workflow", workflow_impact: "restores handoff", acceptance_gates: ["host ready"], scope_drift: false };
function candidate(overrides = {}) {
  const value = { candidate_id: "candidate-1", base_commit: commit, candidate_commit: "d".repeat(40), tree: "e".repeat(40), branch: "fix/example", github_run: { id: 123, head_sha: "d".repeat(40), conclusion: "success" }, artifact_id: "artifact-1", artifact_digest: `sha256:${"f".repeat(64)}`, artifact_commit: "d".repeat(40), evidence_index_hash: "a".repeat(64), task_package_content_hash: taskHash, constitution_content_hash: constitutionHash, candidate_nonce: "nonce-1234567890-abcdef", changed_files: ["web/agent.tsx"], known_limitations: [], ...overrides };
  const remote = { schema_version: "filmos.github-evidence-verification.v1", status: "VERIFIED", repository: "maiyadiu/filmos-studio", candidate_commit: value.candidate_commit, candidate_tree: value.tree, branch: value.branch, github_run_id: String(value.github_run.id), artifact_id: String(value.artifact_id), artifact_digest: value.artifact_digest, evidence_index_hash: value.evidence_index_hash, checks: { commit_exists: true, tree_matches: true, branch_exists: true, run_exists: true, run_head_matches: true, run_success: true, artifact_exists: true, artifact_run_matches: true, artifact_digest_matches: true, evidence_index_present: true, evidence_index_hash_matches: true }, verified_at: "2026-08-31T12:00:00.000Z" };
  return { ...value, github_remote_verification: overrides.github_remote_verification ?? { ...remote, content_hash: sha256(remote) } };
}
function strictFinding(findingId, overrides = {}) { return { finding_id: findingId, severity: "P0", category: "runtime", title: "Host context is stale", problem: "The current Host context cannot accept the request.", evidence: [{ source_type: "github_file", locator: "web/agent.tsx", line_start: 1 }], required_change: "Refresh the Host context before sending.", acceptance_gate: "Host readiness integration test passes.", ...overrides }; }
function reviewDecision(issueId, value, overrides = {}) { return { purpose: "CHATGPT_REVIEW_DECISION", issue_id: issueId, candidate_id: value.candidate_id, candidate_commit: value.candidate_commit, verdict: "CHANGES_REQUIRED", summary: "Candidate needs one bounded fix.", findings: [strictFinding("finding-round-1")], closed_finding_ids: [], reopened_finding_ids: [], accepted_limitations: [], scope_assessment: { task_package_hash_matches: true, constitution_hash_matches: true, out_of_scope_changes: [] }, confidence: "high", ...overrides }; }
function reachConsensus(service, issueId) {
  service.submitAssessment(issueId, "codex", codexAssessment);
  const proposed = service.submitAssessment(issueId, "chatgpt", chatgptAssessment);
  const proposalHash = proposed.consensus_proposal.contentHash;
  service.respondConsensus(issueId, "codex", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
  return service.respondConsensus(issueId, "chatgpt", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
}

test("consensus changes advance to an append-only assessment round with fresh evidence bindings", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "consensus-round");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const proposed = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  const firstHash = proposed.consensus_proposal.contentHash;
  service.respondConsensus(issue.issue_id, "codex", { proposal_content_hash: firstHash, position: "CHANGES_REQUESTED", requested_changes: ["narrow scope"] });
  service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: firstHash, position: "CHANGES_REQUESTED", requested_changes: ["bind evidence"] });

  const advanced = service.startNextAssessmentRound(issue.issue_id);
  assert.equal(advanced.state, "EVIDENCE_FROZEN");
  assert.equal(advanced.assessment_round, 2);
  assert.equal(advanced.assessment_round_history.length, 1);
  assert.equal(advanced.assessment_round_history[0].consensus_proposal.contentHash, firstHash);
  assert.equal(advanced.assessment_round_history[0].consensus_responses.length, 2);
  assert.deepEqual(advanced.assessments, {});
  assert.equal(advanced.consensus_proposal, null);
  const roundTwoCoordinationKey = service.pending(projectId).find((item) => item.issue_id === issue.issue_id).coordination_key;

  const codex = service.submitAssessment(issue.issue_id, "codex", codexAssessment).assessments.codex;
  assert.equal(codex.assessment_round, 2);
  assert.equal(codex.project_id, projectId);
  assert.equal(codex.evidence_manifest_hash, service.requireIssue(issue.issue_id).evidence.manifest.contentHash);
  assert.equal(codex.constitution_content_hash, constitutionHash);
  const second = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  assert.equal(second.consensus_proposal.assessmentRound, 2);
  assert.equal(second.consensus_proposal.evidenceManifestHash, codex.evidence_manifest_hash);
  assert.notEqual(second.consensus_proposal.contentHash, firstHash);
  service.respondConsensus(issue.issue_id, "codex", { proposal_content_hash: second.consensus_proposal.contentHash, position: "CHANGES_REQUESTED", requested_changes: ["refine gates"] });
  service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: second.consensus_proposal.contentHash, position: "CHANGES_REQUESTED", requested_changes: ["refine gates"] });
  const thirdRound = service.startNextAssessmentRound(issue.issue_id);
  assert.equal(thirdRound.state, "EVIDENCE_FROZEN");
  assert.equal(thirdRound.assessment_round, 3);
  const roundThreeCoordinationKey = service.pending(projectId).find((item) => item.issue_id === issue.issue_id).coordination_key;
  assert.notEqual(roundThreeCoordinationKey, roundTwoCoordinationKey);
  store.close();
});

test("consensus proposal preserves structured evidence gaps from the paired assessments", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "structured-evidence-gaps");
  const screenshotGap = "screenshot=false; structured context is not pixel evidence";
  const remoteReceiptGap = "GitHub Run, Artifact, and Evidence Index receipts are missing";
  service.submitAssessment(issue.issue_id, "codex", { ...codexAssessment, evidence_gaps: [screenshotGap] });
  const proposed = service.submitAssessment(issue.issue_id, "chatgpt", {
    ...chatgptAssessment,
    needs_more_evidence: true,
    evidence_gaps: [screenshotGap, remoteReceiptGap],
  });

  assert.deepEqual(proposed.consensus_delta.evidence_differences, [screenshotGap, remoteReceiptGap]);
  assert.deepEqual(proposed.consensus_proposal.evidenceGaps, [screenshotGap, remoteReceiptGap]);
  assert.equal(proposed.consensus_proposal.evidenceGaps.includes("additional_evidence_requested"), false);
  store.close();
});

test("Review Bus uses SQLite WAL, immutable events, and redacts the external evidence projection", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "sqlite");
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  assert.throws(() => store.db.exec("UPDATE review_events SET actor='tamper'"), /REVIEW_EVENT_APPEND_ONLY/);
  const redacted = service.readRedacted(issue.issue_id, projectId);
  const admin = service.readRedactedAdmin(issue.issue_id);
  assert.equal(admin.event_chain_verified, true);
  assert.equal("local_items" in redacted.evidence, false);
  const body = JSON.stringify(redacted);
  assert.equal(body.includes("secret-value"), false);
  assert.equal(body.includes("/Users/alice"), false);
  assert.match(body, /REDACTED_SECRET/);
  const backup = store.backup(resolve(directory, "backups/review-bus.sqlite"));
  assert.equal(existsSync(backup.destination), true);
  assert.match(backup.sha256, /^[0-9a-f]{64}$/);
  store.close();
});

test("GitHub verifier independently binds commit, tree, branch, successful Run, Artifact digest, and Artifact Evidence Index", async () => {
  const evidenceBytes = Buffer.from('{"schema_version":"test"}\n');
  const value = candidate({ artifact_id: "456", evidence_index_hash: sha256(evidenceBytes.toString("utf8")) });
  const apiJson = async (endpoint) => {
    if (endpoint.includes("/git/commits/")) return { sha: value.candidate_commit, tree: { sha: value.tree } };
    if (endpoint.includes("/branches/")) return { commit: { sha: value.candidate_commit } };
    if (endpoint.includes("/actions/runs/")) return { id: 123, head_sha: value.candidate_commit, conclusion: "success" };
    if (endpoint.includes("/actions/artifacts/")) return { id: 456, digest: value.artifact_digest, expired: false, workflow_run: { head_sha: value.candidate_commit } };
    throw new Error("unexpected endpoint");
  };
  let cleaned = false;
  const verifier = new GitHubEvidenceVerifier({ apiJson, downloadArtifact: async () => ({ cleanup: () => { cleaned = true; } }), readArtifactEvidenceIndex: async () => evidenceBytes, now: () => new Date("2026-08-31T12:00:00.000Z") });
  const receipt = await verifier.verify(value);
  assert.equal(receipt.status, "VERIFIED");
  assert.equal(receipt.checks.evidence_index_hash_matches, true);
  assert.equal(receipt.repository, "maiyadiu/filmos-studio");
  assert.equal(cleaned, true);
  await assert.rejects(() => new GitHubEvidenceVerifier({ apiJson: async (endpoint) => endpoint.includes("artifacts") ? { id: 456, digest: `sha256:${"0".repeat(64)}`, expired: false } : apiJson(endpoint), downloadArtifact: async () => ({}), readArtifactEvidenceIndex: async () => evidenceBytes }).verify(value), /artifact_digest_matches/);
});

test("formal live trace requires real GitHub receipts, A to B, restart, dual signoff, and exact ChatGPT writebacks", () => {
  const candidateA = candidate({ candidate_id: "candidate-A" });
  const candidateB = candidate({ candidate_id: "candidate-B", candidate_commit: "b".repeat(40), tree: "c".repeat(40), github_run: { id: 124, head_sha: "b".repeat(40), conclusion: "success" }, artifact_id: "artifact-B", artifact_commit: "b".repeat(40), candidate_nonce: "nonce-B-1234567890-abcdef" });
  const issue = {
    issue_id: "FILMOS-ISSUE-live-trace",
    project_id: projectId,
    state: "DUAL_APPROVED",
    current_round: 2,
    candidate_history: [
      { candidate: candidateA, status: "SUPERSEDED", round: 1, supersededByCandidateId: "candidate-B" },
      { candidate: candidateB, status: "APPROVED", round: 2 },
    ],
    findings: [{ finding_id: "finding-1", severity: "P0", status: "CLOSED" }],
    finding_responses: [{ finding_id: "finding-1", disposition: "FIXED_WITH_EVIDENCE" }],
    decision_history: [{ verdict: "CHANGES_REQUIRED" }, { verdict: "EXTERNAL_APPROVED" }],
    verdicts: { codex: "LOCAL_ACCEPTED", chatgpt: "EXTERNAL_APPROVED", machine: "PASS" },
    dual_signoff: { content_hash: "1".repeat(64) },
    issue_task_package: { contentHash: "2".repeat(64) },
    consensus_record: { contentHash: "3".repeat(64) },
    runtime_recovery: { observed_start_ids: ["runtime-first-1234567890", "runtime-second-123456789"] },
    codex_coordination: { status: "COMPLETED", session_id: "brain-session-live-123" },
    evidence: { manifest: { contentHash: "4".repeat(64) } },
    attachments: [{ attachment_id: "attachment-1", sha256: "5".repeat(64), size_bytes: 10 }],
  };
  const events = [
    ["assessment.chatgpt.submitted", "chatgpt"],
    ["consensus.responded", "chatgpt"],
    ["runtime.observed", "filmos-review-bus"],
    ["assessment.codex.submitted", "codex"],
    ["assessment.chatgpt.submitted", "chatgpt"],
    ["consensus.responded", "chatgpt"],
    ["chatgpt.review_decision", "chatgpt"],
    ["finding.codex_response", "codex"],
    ["runtime.observed", "filmos-review-bus"],
    ["chatgpt.review_decision", "chatgpt"],
    ["codex.coordination", "review-codex-coordinator"],
    ["verdict.codex", "codex"],
  ].map(([event_type, actor], index) => ({ event_type, actor, event_hash: String(index).padStart(64, "0") }));
  const trace = buildLiveRoundtripTrace(issue, events, { eventChainVerified: true, generatedAt: new Date("2026-08-31T12:00:00.000Z") });
  assert.equal(trace.status, "PASSED");
  assert.equal(trace.formal_github_remote_evidence, true);
  assert.equal(trace.chatgpt_user_gesture_writebacks.exact_count, 6);
  assert.equal(trace.chatgpt_user_gesture_writebacks.assessment, 2);
  assert.equal(trace.chatgpt_user_gesture_writebacks.consensus, 2);
  assert.equal(trace.chatgpt_user_gesture_writebacks.candidate_reviews, 2);
  const localOnly = structuredClone(issue);
  localOnly.candidate_history[1].candidate.github_remote_verification.verification_mode = "DETERMINISTIC_LOCAL_ACCEPTANCE_ONLY";
  assert.throws(() => buildLiveRoundtripTrace(localOnly, events, { eventChainVerified: true }), /FORMAL_GITHUB_REMOTE_EVIDENCE_REQUIRED/);
});

test("attachment bytes are durably hashed for local Codex access while ChatGPT sees only redacted metadata", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-attachment-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "attachment");
  const bytes = Buffer.from("real screenshot bytes");
  const stored = service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-pasted-1",
    media_type: "image/png",
    original_name: "private-desktop-name.png",
    base64: bytes.toString("base64"),
    captured_at: "2026-08-31T10:00:00.000Z",
  });
  assert.match(stored.attachment.sha256, /^[0-9a-f]{64}$/);
  const local = service.readLocalAttachment(issue.issue_id, "attachment-pasted-1", projectId);
  assert.deepEqual(local.bytes, bytes);
  assert.equal(local.metadata.original_name, "private-desktop-name.png");
  assert.equal(local.metadata.local_path.startsWith(resolve(directory, "evidence", issue.issue_id)), true);
  const redacted = service.readRedacted(issue.issue_id, projectId);
  const external = JSON.stringify(redacted);
  assert.equal(external.includes("private-desktop-name.png"), false);
  assert.equal(external.includes(directory), false);
  assert.equal(external.includes("evidence://"), true);
  assert.equal(redacted.evidence.manifest.completeness.screenshot, true);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("supplemental crash evidence is append-only after Task Package freeze and does not stale an approved candidate", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-supplemental-attachment-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "supplemental-attachment");
  const consensus = reachConsensus(service, issue.issue_id);
  const submitted = service.submitCandidate(issue.issue_id, candidate({
    consensus_record_hash: consensus.consensus_record.contentHash,
    task_package_content_hash: consensus.issue_task_package.contentHash,
  }));
  const before = service.requireIssue(issue.issue_id);
  const beforeManifestHash = before.evidence.manifest.contentHash;
  const beforeTaskPackageHash = before.task_package_content_hash;
  const beforeCandidateHash = before.active_candidate.content_hash;
  const stored = service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-chrome-crash-report",
    media_type: "text/plain",
    original_name: "chrome-crash.txt",
    base64: Buffer.from("Chrome SIGABRT report").toString("base64"),
    captured_at: "2026-09-01T04:00:38.858Z",
  });
  assert.equal(stored.issue.state, submitted.state);
  assert.equal(stored.issue.evidence.manifest.contentHash, beforeManifestHash);
  assert.equal(stored.issue.task_package_content_hash, beforeTaskPackageHash);
  assert.equal(stored.issue.active_candidate.content_hash, beforeCandidateHash);
  assert.equal(stored.issue.attachments.length, 1);
  assert.match(stored.issue.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(store.events(issue.issue_id).at(-1).event_type, "evidence.attachment.added");
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("blind assessment prevents anchoring until both experts submit", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "blind");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const blind = service.assessmentBlind(issue.issue_id, "chatgpt");
  assert.equal(blind.counterpart_assessment, null);
  assert.equal(blind.counterpart_sealed, true);
  service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  const paired = service.assessmentBlind(issue.issue_id, "chatgpt");
  assert.equal(paired.pair_complete, true);
  assert.equal(paired.counterpart_assessment.root_cause, codexAssessment.root_cause);
  assert.equal(service.requireIssue(issue.issue_id).state, "CONSENSUS_PROPOSED");
  store.close();
});

test("paired assessments auto-create a stable Consensus Proposal and dual responses freeze Record plus per-issue Task Package", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "proposal");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const proposed = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  assert.equal(proposed.state, "CONSENSUS_PROPOSED");
  assert.equal(proposed.consensus_proposal.codexPosition, "PENDING");
  assert.equal(proposed.consensus_proposal.chatgptPosition, "PENDING");
  assert.match(proposed.consensus_proposal.contentHash, /^[0-9a-f]{64}$/);
  const hash = proposed.consensus_proposal.contentHash;
  const codexAccepted = service.respondConsensus(issue.issue_id, "codex", { proposal_content_hash: hash, position: "ACCEPTED", requested_changes: [] });
  assert.equal(codexAccepted.consensus_proposal.contentHash, hash);
  assert.equal(codexAccepted.consensus_record, undefined);
  const frozen = service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: hash, position: "ACCEPTED", requested_changes: [] });
  assert.equal(frozen.state, "TASK_PACKAGE_FROZEN");
  assert.match(frozen.consensus_record.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(frozen.issue_task_package.consensusRecordHash, frozen.consensus_record.contentHash);
  assert.equal(frozen.issue_task_package.evidenceManifestHash, frozen.evidence.manifest.contentHash);
  assert.notEqual(frozen.issue_task_package.contentHash, frozen.build_lineage_task_package_hash);
  assert.throws(() => service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: hash, position: "ACCEPTED", requested_changes: [] }), /CONSENSUS_RESPONSE_IMMUTABLE/);
  store.close();
});

test("Task Package hash is issue-specific and candidate scope fails closed", () => {
  const { service, store } = fixture();
  const first = createFastIssue(service, "task-a", ["web/a.ts"]);
  const second = createFastIssue(service, "task-b", ["web/b.ts"]);
  assert.notEqual(first.issue_task_package.contentHash, second.issue_task_package.contentHash);
  assert.throws(() => service.submitCandidate(first.issue_id, candidate({ changed_files: ["web/b.ts"], task_package_content_hash: first.issue_task_package.contentHash })), /CANDIDATE_SCOPE_EXCEEDED/);
  assert.throws(() => service.submitCandidate(first.issue_id, candidate({ changed_files: ["web/a.ts"], task_package_content_hash: taskHash })), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("Core candidate needs consensus and Codex cannot self-approve external review", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "consensus");
  const value = candidate();
  assert.throws(() => service.submitCandidate(issue.issue_id, value), /IMPLEMENTATION_BLOCKED_NO_CONSENSUS/);
  const consensus = reachConsensus(service, issue.issue_id);
  value.consensus_record_hash = consensus.consensus_record.contentHash;
  value.task_package_content_hash = consensus.issue_task_package.contentHash;
  const submitted = service.submitCandidate(issue.issue_id, value);
  const binding = candidateBinding(submitted.active_candidate);
  assert.throws(() => service.recordVerdict(issue.issue_id, "codex", "EXTERNAL_APPROVED"), /REVIEW_CODEX_CANNOT_SELF_APPROVE/);
  assert.throws(() => service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding: { ...binding, candidate_commit: "0".repeat(40) } }), /CURRENT_CANDIDATE_BINDING_MISMATCH/);
  service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding });
  service.recordVerdict(issue.issue_id, "chatgpt", { verdict: "EXTERNAL_APPROVED", binding });
  const accepted = service.recordVerdict(issue.issue_id, "machine", { verdict: "PASS", binding });
  assert.equal(accepted.state, "DUAL_APPROVED");
  assert.equal(accepted.next_pilot_allowed, true);
  assert.ok(accepted.dual_signoff.content_hash);
  store.close();
});

test("late findings require taxonomy and Codex responses cannot close ChatGPT findings", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "finding");
  const consensus = reachConsensus(service, issue.issue_id);
  const candidateA = candidate({ consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash });
  const submittedA = service.submitCandidate(issue.issue_id, candidateA);
  service.submitChatGPTReviewDecision(issue.issue_id, reviewDecision(issue.issue_id, submittedA.active_candidate));
  service.respondFinding(issue.issue_id, { finding_id: "finding-round-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test-A"] });
  service.nextRound(issue.issue_id);
  const candidateB = candidate({ candidate_id: "candidate-2", candidate_commit: "b".repeat(40), tree: "c".repeat(40), github_run: { id: 124, head_sha: "b".repeat(40), conclusion: "success" }, artifact_id: "artifact-2", artifact_commit: "b".repeat(40), candidate_nonce: "nonce-B-1234567890-abcdef", consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash });
  service.submitCandidate(issue.issue_id, candidateB);
  assert.throws(() => service.addFinding(issue.issue_id, strictFinding("finding-2", { severity: "P1", title: "Late issue" })), /LATE_FINDING_CLASSIFICATION_REQUIRED/);
  service.addFinding(issue.issue_id, strictFinding("finding-2", { severity: "P1", title: "Late issue", late_finding_classification: "PREVIOUS_REVIEW_MISS", reason_newly_discoverable: "The second candidate exposes this path." }));
  const response = service.respondFinding(issue.issue_id, { finding_id: "finding-2", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test"] });
  assert.equal(response.findings.find((item) => item.finding_id === "finding-2").status, "OPEN");
  assert.throws(() => service.decideFinding(issue.issue_id, "finding-2", "DISPUTE_ACCEPTED", "codex"), /REVIEW_CODEX_CANNOT_SELF_CLOSE/);
  const closed = service.decideFinding(issue.issue_id, "finding-2", "DISPUTE_ACCEPTED", "chatgpt");
  assert.equal(closed.findings.find((item) => item.finding_id === "finding-2").status, "CLOSED");
  service.recordVerdict(issue.issue_id, "chatgpt", { verdict: "CHANGES_REQUIRED", binding: candidateBinding(service.requireIssue(issue.issue_id).active_candidate) });
  service.respondFinding(issue.issue_id, { finding_id: "finding-round-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test-B"] });
  const escalated = service.nextRound(issue.issue_id);
  assert.equal(escalated.current_round, 3);
  assert.equal(escalated.state, "OWNER_DECISION_REQUIRED");
  store.close();
});

test("Candidate A to B preserves immutable history, resets verdicts, and rejects stale candidate decisions", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "roundtrip");
  const consensus = reachConsensus(service, issue.issue_id);
  const candidateA = service.submitCandidate(issue.issue_id, candidate({ candidate_id: "candidate-A", consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash })).active_candidate;
  const bindingA = candidateBinding(candidateA);
  service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding: bindingA });
  service.submitChatGPTReviewDecision(issue.issue_id, reviewDecision(issue.issue_id, candidateA));
  service.respondFinding(issue.issue_id, { finding_id: "finding-round-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["candidate-A-test"] });
  const oldChallenge = store.issueChallenge({ purpose: "CHATGPT_REVIEW_DECISION", issueId: issue.issue_id, candidateId: candidateA.candidate_id, candidateCommit: candidateA.candidate_commit });
  const advanced = service.startNextRound(issue.issue_id);
  assert.equal(advanced.current_round, 2);
  assert.equal(advanced.active_candidate, null);
  assert.deepEqual(advanced.verdicts, { codex: null, chatgpt: null, machine: null });
  assert.equal(advanced.candidate_history[0].status, "SUPERSEDED");
  assert.equal(advanced.stale_candidate_bindings.length, 1);
  assert.ok(store.candidateChallenges({ issueId: issue.issue_id, candidateId: candidateA.candidate_id, candidateCommit: candidateA.candidate_commit })[0].revoked_at);
  assert.throws(() => store.consumeChallenge({ challengeId: oldChallenge.challenge_id, nonce: oldChallenge.nonce, purpose: "CHATGPT_REVIEW_DECISION", issueId: issue.issue_id, candidateId: candidateA.candidate_id, candidateCommit: candidateA.candidate_commit }), /REVIEW_REPLAY_BLOCKED/);
  const candidateB = service.submitCandidate(issue.issue_id, candidate({ candidate_id: "candidate-B", candidate_commit: "b".repeat(40), tree: "c".repeat(40), github_run: { id: 125, head_sha: "b".repeat(40), conclusion: "success" }, artifact_id: "artifact-B", artifact_commit: "b".repeat(40), candidate_nonce: "nonce-B-1234567890-abcdef", consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash })).active_candidate;
  const current = service.requireIssue(issue.issue_id);
  assert.equal(current.candidate_history.length, 2);
  assert.equal(current.candidate_history[0].supersededByCandidateId, "candidate-B");
  assert.equal(current.candidate_history[1].status, "ACTIVE");
  assert.throws(() => service.submitChatGPTReviewDecision(issue.issue_id, reviewDecision(issue.issue_id, candidateA, { findings: [], verdict: "EVIDENCE_REQUIRED" })), /CURRENT_CANDIDATE_BINDING_MISMATCH/);
  assert.equal(candidateB.round, 2);
  store.close();
});

test("invalid ChatGPT aggregate decision rolls back challenge use and every projection change", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "atomic");
  const consensus = reachConsensus(service, issue.issue_id);
  const active = service.submitCandidate(issue.issue_id, candidate({ consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash })).active_candidate;
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const bridgeToken = "bridge-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: "bus-token-1234567890-abcdefghijkl", bridgeToken, constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  try {
    const challengeResponse = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_REVIEW_DECISION", issue_id: issue.issue_id, candidate_id: active.candidate_id, candidate_commit: active.candidate_commit }) });
    const challenge = await challengeResponse.json();
    const before = service.requireIssue(issue.issue_id);
    const invalidDecision = reviewDecision(issue.issue_id, active, { findings: [{ finding_id: "finding-invalid", severity: "P0" }] });
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, purpose: "CHATGPT_REVIEW_DECISION", issue_id: issue.issue_id, candidate_id: active.candidate_id, candidate_commit: active.candidate_commit, decision: invalidDecision };
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(rejected.status, 409);
    assert.equal(service.requireIssue(issue.issue_id).entity_version, before.entity_version);
    const retry = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify({ ...body, decision: reviewDecision(issue.issue_id, active) }) });
    assert.equal(retry.status, 200);
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); store.close(); }
});

test("Chrome writeback challenge is one-time, candidate-bound, and replay protected", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "bridge");
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const busToken = "bus-token-1234567890-abcdefghijkl";
  const bridgeToken = "bridge-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken, bridgeToken, constitution });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  try {
    const challengeResponse = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(challengeResponse.status, 201);
    const challenge = await challengeResponse.json();
    const decision = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null, decision: chatgptAssessment };
    const accepted = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify(decision) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ack, true);
    const replay = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify(decision) });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "REVIEW_REPLAY_BLOCKED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("Fast lane rejects core, provider, budget, and authority changes", () => {
  const { service, store } = fixture();
  const issue = createFastIssue(service, "fast", ["film-core/schema.py"]);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ candidate_id: "micro", branch: "fix/micro", changed_files: ["film-core/schema.py"], task_package_content_hash: issue.issue_task_package.contentHash })), /FAST_LANE_SCOPE_DENIED/);
  store.close();
});

test("Architecture Lane requires Requirement Delta and a complete A/B/C option matrix", () => {
  const { service, store } = fixture();
  const issue = service.createIssue({ issue_id: "FILMOS-ARCH-options", project_id: projectId, what_happened: "current structure blocks real work", expected_result: "evolvable structure", location: "project workflow", blocks_work: true, lane: "architecture" });
  assert.throws(() => service.setArchitectureOptions(issue.issue_id, []), /REQUIREMENT_DELTA_REQUIRED/);
  service.freezeRequirementDelta(issue.issue_id, { current_flow: "single route", current_blocker: "multi route missing", target_experience: "per task routes", must_preserve: ["Film Core authority"], may_change: ["policy adapter"], success_criteria: ["Pilot copy passes"] });
  assert.throws(() => service.setArchitectureOptions(issue.issue_id, [{ option: "A" }, { option: "B" }]), /ARCHITECTURE_OPTIONS_A_B_C_REQUIRED/);
  const value = service.setArchitectureOptions(issue.issue_id, [{ option: "A", kind: "local extension" }, { option: "B", kind: "structure evolution" }, { option: "C", kind: "core rewrite" }]);
  assert.equal(value.state, "OPTION_COMPARISON");
  store.close();
});

test("candidate binding fails closed on wrong GitHub commit, artifact commit, or task hash", () => {
  const { service, store } = fixture();
  const issue = createFastIssue(service, "binding", ["web/agent.tsx"]);
  const dynamicHash = issue.issue_task_package.contentHash;
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: dynamicHash, github_run: { id: 1, head_sha: "0".repeat(40), conclusion: "success" } })), /GITHUB_RUN_COMMIT_MISMATCH/);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: dynamicHash, artifact_commit: "0".repeat(40) })), /ARTIFACT_COMMIT_MISMATCH/);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: "0".repeat(64) })), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("read-only artifact projection exposes the immutable artifact binding", async () => {
  const { service, store } = fixture();
  const issue = createFastIssue(service, "artifact", ["web/copy.ts"]);
  service.submitCandidate(issue.issue_id, candidate({ candidate_id: "artifact-candidate", branch: "fix/copy", changed_files: ["web/copy.ts"], task_package_content_hash: issue.issue_task_package.contentHash }));
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const token = "bus-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken: "bridge-token-1234567890-abcdefghijkl", constitution });
  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/review/issues/${issue.issue_id}/artifact?project_id=${projectId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.deepEqual(receipt.artifact, { artifact_id: "artifact-1", artifact_digest: `sha256:${"f".repeat(64)}`, artifact_commit: "d".repeat(40) });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
  }
});

test("Review Bus rejects an absent or drifting task-package binding at construction", () => {
  const store = new ReviewBusStore(":memory:");
  assert.throws(() => new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: "0".repeat(64) }), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("Issue IDs are canonical across App, MCP, and Chrome contracts", () => {
  const { service, store } = fixture();
  assert.throws(() => service.createIssue({ issue_id: "ISSUE-wrong", project_id: projectId, what_happened: "x", expected_result: "y", location: "z", blocks_work: false, lane: "fast" }), /INVALID_ISSUE_ID/);
  const normal = service.createIssue({ project_id: projectId, what_happened: "x", expected_result: "y", location: "z", blocks_work: false, lane: "fast" });
  const architecture = service.createIssue({ project_id: projectId, what_happened: "x", expected_result: "y", location: "z", blocks_work: false, lane: "architecture" });
  assert.match(normal.issue_id, /^FILMOS-ISSUE-/);
  assert.match(architecture.issue_id, /^FILMOS-ARCH-/);
  store.close();
});

test("append locks before projection read so two database connections preserve one chain and monotonic versions", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-concurrency-"));
  const databasePath = resolve(directory, "review-bus.sqlite");
  const store = new ReviewBusStore(databasePath);
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  const issue = service.createIssue({ issue_id: "FILMOS-ISSUE-concurrent", project_id: projectId, what_happened: "probe", expected_result: "serialized", location: "review bus", blocks_work: false, lane: "fast" });
  const workerPath = new URL("./append-worker.mjs", import.meta.url);
  const storeModule = new URL("../src/store.mjs", import.meta.url).href;
  const run = (actor) => new Promise((resolvePromise, reject) => {
    const worker = new Worker(workerPath, { workerData: { storeModule, databasePath, issueId: issue.issue_id, actor } });
    worker.once("message", (message) => message.ok ? resolvePromise(message) : reject(new Error(message.error)));
    worker.once("error", reject);
  });
  await Promise.all([run("worker-a"), run("worker-b")]);
  const projection = store.get(issue.issue_id);
  assert.equal(projection.entity_version, 3);
  assert.deepEqual(new Set(projection.concurrency_probes), new Set(["worker-a", "worker-b"]));
  assert.equal(store.events(issue.issue_id).length, 3);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("redaction covers macOS paths with spaces, /var/folders, and Windows user paths", () => {
  const redacted = JSON.stringify(redactEvidence({
    mac: "/Users/apple/Library/Application Support/FilmOS Studio/review-bus/log.json",
    temp: "/var/folders/sw/abc/T/private capture.png",
    windows: "C:\\Users\\Alice Smith\\AppData\\Local\\FilmOS\\secret.log",
  }));
  assert.equal(redacted.includes("Application Support"), false);
  assert.equal(redacted.includes("/var/folders"), false);
  assert.equal(redacted.includes("Alice Smith"), false);
  assert.equal((redacted.match(/LOCAL_PATH/g) ?? []).length, 3);
});

test("loopback origins with ports are accepted while remote and deceptive origins are rejected", () => {
  assert.equal(allowedOrigin("http://127.0.0.1:43100"), true);
  assert.equal(allowedOrigin("http://localhost:43100"), true);
  assert.equal(allowedOrigin("http://[::1]:43100"), true);
  assert.equal(allowedOrigin("https://127.0.0.1:43100"), false);
  assert.equal(allowedOrigin("http://127.0.0.1.evil.example:43100"), false);
  assert.equal(allowedOrigin("https://evil.example"), false);
});

test("single issue intake always freezes a manifest and fails closed when evidence is incomplete", async () => {
  const { service, store } = fixture();
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const token = "bus-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken: "bridge-token-1234567890-abcdefghijkl", constitution });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/issues`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://127.0.0.1:43100" }, body: JSON.stringify({ project_id: "filmos-global", what_happened: "dialog crashed", expected_result: "dialog stays open", location: "global settings", blocks_work: true, app_build_id: "pilot-0", app_tree: "1".repeat(40), route: "/settings" }) });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.state, "EVIDENCE_REQUIRED");
    const projection = service.requireIssue(receipt.issue_id);
    assert.ok(projection.evidence.manifest.contentHash);
    assert.equal(projection.evidence.manifest.completeness.reproduction, true);
    assert.equal(projection.evidence.manifest.completeness.logs, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("Chrome pairing revoke invalidates the bridge token and every unused challenge", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "revoke");
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const bridgeToken = "bridge-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: "bus-token-1234567890-abcdefghijkl", bridgeToken, constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  try {
    const challenge = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(challenge.status, 201);
    const revoke = await fetch(`http://127.0.0.1:${port}/v1/bridge/revoke`, { method: "POST", headers, body: "{}" });
    assert.equal(revoke.status, 200);
    assert.ok((await revoke.json()).outstanding_challenges_revoked >= 1);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, "LOCAL_PAIRING_REQUIRED");
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("six-digit pairing codes are one-time and issue revocable per-client session tokens", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "pair-client");
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const server = createReviewBusHttp({ service, store, busToken: "bus-token-1234567890-abcdefghijkl", bridgeToken: "legacy-bridge-token-1234567890-abcdef", constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  try {
    const pairing = store.createPairingCode();
    const pair = await fetch(`http://127.0.0.1:${port}/v1/bridge/pair`, { method: "POST", headers: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" }, body: JSON.stringify({ pairing_code: pairing.pairing_code, client_name: "Acceptance Chrome" }) });
    assert.equal(pair.status, 201);
    const session = await pair.json();
    assert.match(session.bridge_session_token, /^bridge-session-/);
    const replay = await fetch(`http://127.0.0.1:${port}/v1/bridge/pair`, { method: "POST", headers: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" }, body: JSON.stringify({ pairing_code: pairing.pairing_code, client_name: "Replay" }) });
    assert.equal(replay.status, 401);
    const headers = { authorization: `Bearer ${session.bridge_session_token}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
    const challenge = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(challenge.status, 201);
    const revoked = await fetch(`http://127.0.0.1:${port}/v1/bridge/revoke`, { method: "POST", headers, body: "{}" });
    assert.equal(revoked.status, 200);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(denied.status, 401);
    assert.equal(store.listBridgeClients()[0].revoked_at !== null, true);
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); store.close(); }
});

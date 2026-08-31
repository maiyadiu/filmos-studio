import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { ReviewBusService, candidateBinding } from "../src/service.mjs";
import { allowedOrigin, createReviewBusHttp } from "../src/server.mjs";
import { ReviewBusStore } from "../src/store.mjs";
import { redactEvidence } from "../src/redaction.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const commit = "6ea93bfa08381264a1379fe938ade3a7513c7bba";
const taskHash = "99ebaf3b0415c3704c488dbfc23828ecccc3b5b03486a3bf759c586681782893";
const constitutionHash = "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41";

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

const codexAssessment = { reproduced: true, root_cause: "host context is stale", call_chain: ["ui", "host"], files: ["web/agent.tsx"], minimal_change: ["refresh context"], regression_risk: "low", tests: ["host context test"], rollback: ["revert"] };
const chatgptAssessment = { product_goal_fit: false, root_cause: "host context is stale", root_cause_explains_symptom: true, authority_risk: false, resolution_layer: "workflow", workflow_impact: "restores handoff", acceptance_gates: ["host ready"], scope_drift: false };
function candidate(overrides = {}) { return { candidate_id: "candidate-1", base_commit: commit, candidate_commit: "d".repeat(40), tree: "e".repeat(40), branch: "fix/example", github_run: { id: 123, head_sha: "d".repeat(40), conclusion: "success" }, artifact_id: "artifact-1", artifact_digest: `sha256:${"f".repeat(64)}`, artifact_commit: "d".repeat(40), evidence_index_hash: "a".repeat(64), task_package_content_hash: taskHash, constitution_content_hash: constitutionHash, candidate_nonce: "nonce-1234567890-abcdef", changed_files: ["web/agent.tsx"], known_limitations: [], ...overrides }; }

test("Review Bus uses SQLite WAL, immutable events, and redacts the external evidence projection", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "sqlite");
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  assert.throws(() => store.db.exec("UPDATE review_events SET actor='tamper'"), /REVIEW_EVENT_APPEND_ONLY/);
  const redacted = service.readRedacted(issue.issue_id, projectId);
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
  assert.equal(service.requireIssue(issue.issue_id).state, "CONSENSUS_REVIEW");
  store.close();
});

test("Core candidate needs consensus and Codex cannot self-approve external review", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "consensus");
  const value = candidate();
  assert.throws(() => service.submitCandidate(issue.issue_id, value), /IMPLEMENTATION_BLOCKED_NO_CONSENSUS/);
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  service.setConsensus(issue.issue_id, { rootCause: "host context is stale", resolutionLayer: "workflow", allowedChangeScope: ["web/agent.tsx"], explicitNonGoals: ["Film Core"], implementationPlan: ["refresh"], acceptanceGates: ["host ready"], rollbackPlan: ["revert"], codexAccepted: true, chatgptAccepted: true });
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
  service.addFinding(issue.issue_id, { finding_id: "finding-1", severity: "P0", summary: "unsafe" });
  service.nextRound(issue.issue_id);
  assert.throws(() => service.addFinding(issue.issue_id, { finding_id: "finding-2", severity: "P1", summary: "late" }), /LATE_FINDING_CLASSIFICATION_REQUIRED/);
  service.addFinding(issue.issue_id, { finding_id: "finding-2", severity: "P1", summary: "late", late_finding_classification: "PREVIOUS_REVIEW_MISS" });
  const response = service.respondFinding(issue.issue_id, { finding_id: "finding-2", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test"] });
  assert.equal(response.findings.find((item) => item.finding_id === "finding-2").status, "OPEN");
  assert.throws(() => service.decideFinding(issue.issue_id, "finding-2", "DISPUTE_ACCEPTED", "codex"), /REVIEW_CODEX_CANNOT_SELF_CLOSE/);
  const closed = service.decideFinding(issue.issue_id, "finding-2", "DISPUTE_ACCEPTED", "chatgpt");
  assert.equal(closed.findings.find((item) => item.finding_id === "finding-2").status, "CLOSED");
  const escalated = service.nextRound(issue.issue_id);
  assert.equal(escalated.current_round, 3);
  assert.equal(escalated.state, "OWNER_DECISION_REQUIRED");
  store.close();
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
  const issue = service.createIssue({ issue_id: "FILMOS-ISSUE-fast", project_id: projectId, what_happened: "wording", expected_result: "clear wording", location: "button", blocks_work: false, lane: "fast" });
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ candidate_id: "micro", branch: "fix/micro", changed_files: ["film-core/schema.py"] })), /FAST_LANE_SCOPE_DENIED/);
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
  const issue = service.createIssue({ issue_id: "FILMOS-ISSUE-binding", project_id: projectId, what_happened: "wording", expected_result: "clear", location: "button", blocks_work: false, lane: "fast" });
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ github_run: { id: 1, head_sha: "0".repeat(40), conclusion: "success" } })), /GITHUB_RUN_COMMIT_MISMATCH/);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ artifact_commit: "0".repeat(40) })), /ARTIFACT_COMMIT_MISMATCH/);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: "0".repeat(64) })), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("read-only artifact projection exposes the immutable artifact binding", async () => {
  const { service, store } = fixture();
  const issue = service.createIssue({ issue_id: "FILMOS-ISSUE-artifact", project_id: projectId, what_happened: "wording", expected_result: "clear", location: "button", blocks_work: false, lane: "fast" });
  service.submitCandidate(issue.issue_id, candidate({ candidate_id: "artifact-candidate", branch: "fix/copy", changed_files: ["web/copy.ts"] }));
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

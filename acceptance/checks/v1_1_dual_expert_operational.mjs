#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { sha256 } from "../../services/filmos-review-bus/src/canonical.mjs";
import { CONSTITUTION_HASH, TASK_PACKAGE_HASH } from "../../services/filmos-review-bus/src/contracts.mjs";
import { candidateBinding, ReviewBusService } from "../../services/filmos-review-bus/src/service.mjs";
import { createReviewBusHttp } from "../../services/filmos-review-bus/src/server.mjs";
import { ReviewBusStore } from "../../services/filmos-review-bus/src/store.mjs";

const BASE_COMMIT = "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "FILMOS-ISSUE-operational-roundtrip";
const BUS_TOKEN = "operational-bus-token-1234567890abcdef";
const LEGACY_BRIDGE_TOKEN = "operational-bridge-token-1234567890abcdef";
const EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SCREENSHOT_BYTES = Buffer.from("FilmOS V1.1 pasted screenshot operational evidence\n", "utf8");
const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../governance/FILMOS_CONSTITUTION.json"), "utf8"));

const directory = mkdtempSync(resolve(tmpdir(), "filmos-v1-1-operational-"));
const databasePath = resolve(directory, "review-bus.sqlite");
let runtime;
let restartCount = 0;
let chatgptUserGestureClicks = 0;

try {
  runtime = await startRuntime();
  const first = runtime;

  await request(first.url, "POST", "/v1/issues", {
    project_id: PROJECT_ID,
    issue_id: ISSUE_ID,
    what_happened: "Feedback must trigger the dual-expert operational loop.",
    expected_result: "Codex assessment, ChatGPT writeback, Candidate A to B, and dual signoff are durable.",
    location: "web/src/components/governance/ReportIssuePortal.tsx",
    blocks_work: true,
    risk: { core_state: true },
    screenshot_refs: ["clipboard://pasted-screenshot"],
    app_build_id: "operational-preflight",
    app_tree: "local-acceptance-only",
    route: "/projects/11111111-1111-4111-8111-111111111111/chapters",
    context_snapshot: {
      projectId: PROJECT_ID,
      domainProjectId: PROJECT_ID,
      contentUnitId: "content-unit-1",
      sceneId: null,
      directorUnitId: null,
      shotId: null,
      runtimeStatus: { reviewBus: "ready" },
      providerStatus: { externalPaidSubmit: false },
      recentAuditIds: ["audit-operational-1"],
      recentErrorCodes: [],
    },
  });
  assert.equal((await full(first.url)).lane, "core");

  const uploaded = await request(first.url, "POST", `/v1/issues/${ISSUE_ID}/attachments`, {
    attachment_id: "attachment-pasted-operational",
    media_type: "image/png",
    original_name: "pasted-feedback.png",
    base64: SCREENSHOT_BYTES.toString("base64"),
    captured_at: "2026-08-31T12:00:00.000Z",
  });
  const screenshotHash = createHash("sha256").update(SCREENSHOT_BYTES).digest("hex");
  assert.equal(uploaded.attachment.sha256, screenshotHash);

  await request(first.url, "POST", `/v1/issues/${ISSUE_ID}/assessments/codex`, {
    reproduced: true,
    root_cause: "The feedback loop requires durable user-gesture writeback and coordinator activation.",
    call_chain: ["ReportIssuePortal", "Review Bus", "Review Codex Coordinator"],
    files: ["web/src/components/governance/ReportIssuePortal.tsx", "canvas-agent/src/brains/review-codex-coordinator.ts"],
    minimal_change: ["Persist attachment bytes", "Coordinate pending issue", "Require explicit ChatGPT writeback"],
    regression_risk: "bounded",
    tests: ["operational roundtrip"],
    rollback: ["revert bounded candidate"],
  });

  const pairing = await request(first.url, "POST", "/v1/review/pairing-codes", {});
  const paired = await request(first.url, "POST", "/v1/bridge/pair", {
    pairing_code: pairing.pairing_code,
    client_name: "FilmOS Chrome Review Bridge Operational Gate",
  }, { token: null, origin: EXTENSION_ORIGIN });
  assert.match(paired.bridge_session_token, /^bridge-session-[A-Za-z0-9_-]{24,}$/);
  await expectFailure(() => request(first.url, "POST", "/v1/bridge/pair", {
    pairing_code: pairing.pairing_code,
    client_name: "replay",
  }, { token: null, origin: EXTENSION_ORIGIN }), "PAIRING_CODE_INVALID_OR_EXPIRED");

  await bridgeDecision(first.url, paired.bridge_session_token, "CHATGPT_ASSESSMENT", null, {
    product_goal_fit: true,
    root_cause: "The feedback loop requires durable user-gesture writeback and coordinator activation.",
    root_cause_explains_symptom: true,
    authority_risk: false,
    resolution_layer: "workflow",
    workflow_impact: "Completes the two-expert review path.",
    acceptance_gates: ["Candidate A to B roundtrip", "restart recovery", "dual signoff"],
    scope_drift: false,
  });

  let issue = await full(first.url);
  await request(first.url, "POST", `/v1/issues/${ISSUE_ID}/consensus/responses/codex`, {
    proposal_content_hash: issue.consensus_proposal.contentHash,
    position: "ACCEPTED",
    requested_changes: [],
  });
  await bridgeDecision(first.url, paired.bridge_session_token, "CHATGPT_CONSENSUS_DECISION", null, {
    proposal_content_hash: issue.consensus_proposal.contentHash,
    position: "ACCEPTED",
    requested_changes: [],
  });

  issue = await full(first.url);
  const candidateA = candidate("A", "a", 9001, issue);
  await request(first.url, "POST", `/v1/issues/${ISSUE_ID}/candidates`, candidateA);
  issue = await full(first.url);
  await bridgeDecision(first.url, paired.bridge_session_token, "CHATGPT_REVIEW_DECISION", issue.active_candidate, {
    purpose: "CHATGPT_REVIEW_DECISION",
    issue_id: ISSUE_ID,
    candidate_id: issue.active_candidate.candidate_id,
    candidate_commit: issue.active_candidate.candidate_commit,
    verdict: "CHANGES_REQUIRED",
    summary: "Candidate A exposes one reproducible P0 that requires a bounded correction.",
    findings: [finding("finding-candidate-a")],
    closed_finding_ids: [],
    reopened_finding_ids: [],
    accepted_limitations: [],
    scope_assessment: { task_package_hash_matches: true, constitution_hash_matches: true, out_of_scope_changes: [] },
    confidence: "high",
  });
  await request(first.url, "POST", `/v1/issues/${ISSUE_ID}/finding-responses`, {
    finding_id: "finding-candidate-a",
    disposition: "FIXED_WITH_EVIDENCE",
    evidence: ["operational://candidate-b-regression-test"],
  });
  await request(first.url, "POST", `/v1/issues/${ISSUE_ID}/rounds/next`, {});

  await stopRuntime(first);
  runtime = null;
  restartCount += 1;
  runtime = await startRuntime();
  const second = runtime;

  issue = await full(second.url);
  assert.equal(issue.current_round, 2);
  assert.equal(issue.active_candidate, null);
  assert.equal(issue.candidate_history.length, 1);
  assert.equal(issue.candidate_history[0].status, "SUPERSEDED");
  const localAttachment = await binary(second.url, `/v1/review/internal/issues/${ISSUE_ID}/attachments/attachment-pasted-operational?project_id=${PROJECT_ID}`);
  assert.deepEqual(localAttachment.bytes, SCREENSHOT_BYTES);
  assert.equal(localAttachment.sha256, screenshotHash);

  const candidateB = candidate("B", "b", 9002, issue);
  await request(second.url, "POST", `/v1/issues/${ISSUE_ID}/candidates`, candidateB);
  issue = await full(second.url);
  await bridgeDecision(second.url, paired.bridge_session_token, "CHATGPT_REVIEW_DECISION", issue.active_candidate, {
    purpose: "CHATGPT_REVIEW_DECISION",
    issue_id: ISSUE_ID,
    candidate_id: issue.active_candidate.candidate_id,
    candidate_commit: issue.active_candidate.candidate_commit,
    verdict: "EXTERNAL_APPROVED",
    summary: "Candidate B closes the previously identified P0 with bound evidence.",
    findings: [],
    closed_finding_ids: ["finding-candidate-a"],
    reopened_finding_ids: [],
    accepted_limitations: [],
    scope_assessment: { task_package_hash_matches: true, constitution_hash_matches: true, out_of_scope_changes: [] },
    confidence: "high",
  });
  issue = await full(second.url);
  const binding = candidateBinding(issue.active_candidate);
  await request(second.url, "POST", `/v1/issues/${ISSUE_ID}/verdicts/codex`, { verdict: "LOCAL_ACCEPTED", binding });
  await request(second.url, "POST", `/v1/issues/${ISSUE_ID}/verdicts/machine`, { verdict: "PASS", binding });

  issue = await full(second.url);
  const events = second.store.events(ISSUE_ID);
  const openP0 = issue.findings.filter((item) => item.severity === "P0" && item.status !== "CLOSED");
  assert.equal(issue.state, "DUAL_APPROVED");
  assert.equal(issue.next_pilot_allowed, true);
  assert.equal(issue.candidate_history.length, 2);
  assert.equal(new Set(issue.candidate_history.map((entry) => entry.candidate.candidate_id)).size, 2);
  assert.equal(issue.candidate_history[0].status, "SUPERSEDED");
  assert.equal(issue.candidate_history[0].supersededByCandidateId, "candidate-B");
  assert.equal(issue.candidate_history[1].status, "APPROVED");
  assert.equal(openP0.length, 0);
  assert.equal(second.store.verifyEventChain(ISSUE_ID), true);
  assert.equal(issue.verdicts.codex, "LOCAL_ACCEPTED");
  assert.equal(issue.verdicts.chatgpt, "EXTERNAL_APPROVED");
  assert.equal(issue.verdicts.machine, "PASS");
  assert.ok(issue.dual_signoff?.content_hash);
  assert.ok(issue.issue_task_package?.contentHash);
  assert.equal(issue.active_candidate.github_remote_verification.verification_mode, "DETERMINISTIC_LOCAL_ACCEPTANCE_ONLY");

  const result = {
    schema_version: "filmos.v1-1-dual-expert-operational-preflight.v1",
    gate_id: "V1-1-DUAL-EXPERT-OPERATIONAL-AUTOMATED-001",
    status: "PASSED",
    classification: "AUTOMATED_OPERATIONAL_PREFLIGHT_NOT_EXTERNAL_LIVE_GATE",
    issue_id: ISSUE_ID,
    state: issue.state,
    candidate_roundtrip: {
      rounds: 2,
      candidate_a: issue.candidate_history[0].candidate.candidate_id,
      candidate_a_status: issue.candidate_history[0].status,
      candidate_b: issue.candidate_history[1].candidate.candidate_id,
      candidate_b_status: issue.candidate_history[1].status,
    },
    restart_recovery: { restarts: restartCount, database: "sqlite-wal", event_chain_verified: true },
    evidence: { screenshot_sha256: screenshotHash, bytes_preserved_after_restart: true, manifest_hash: issue.evidence.manifest.contentHash },
    issue_task_package_hash: issue.issue_task_package.contentHash,
    consensus_record_hash: issue.consensus_record.contentHash,
    codex_signoff: issue.verdicts.codex,
    chatgpt_signoff: issue.verdicts.chatgpt,
    machine_verdict: issue.verdicts.machine,
    open_p0: openP0.length,
    duplicate_candidates: false,
    event_count: events.length,
    chrome_pairing: { one_time_code: true, persisted_client_after_restart: true, raw_long_token_paste: false },
    documented_chatgpt_user_gesture_clicks: chatgptUserGestureClicks,
    formal_github_remote_evidence: false,
    external_live_gate: "REQUIRED_SEPARATELY",
    external_network_requests: 0,
    external_paid_operations: 0,
    openai_model_api_calls: 0,
    real_provider_operations: 0,
  };
  console.log(JSON.stringify({ ...result, content_hash: sha256(result) }));
} finally {
  if (runtime) await stopRuntime(runtime).catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}

async function startRuntime() {
  const store = new ReviewBusStore(databasePath);
  const service = new ReviewBusService(store, { baseCommit: BASE_COMMIT, taskPackageContentHash: TASK_PACKAGE_HASH });
  const githubVerifier = { async verify(value) { return remoteReceipt(value); } };
  const server = createReviewBusHttp({ service, store, busToken: BUS_TOKEN, bridgeToken: LEGACY_BRIDGE_TOKEN, constitution, githubVerifier, listenPort: 0 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return { store, service, server, url: `http://127.0.0.1:${address.port}` };
}

async function stopRuntime(value) {
  await new Promise((resolvePromise, rejectPromise) => value.server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  value.store.close();
}

async function request(baseUrl, method, path, body, options = {}) {
  const token = options.token === undefined ? BUS_TOKEN : options.token;
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.origin ? { origin: options.origin } : {}), ...(options.userGesture ? { "x-filmos-user-gesture": "1" } : {}) };
  const response = await fetch(new URL(path, baseUrl), { method, headers, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.code ?? `HTTP_${response.status}`), { code: value.code, status: response.status });
  return value;
}

async function full(baseUrl) {
  const response = await fetch(new URL(`/v1/review/internal/issues/${ISSUE_ID}/full-context?project_id=${PROJECT_ID}`, baseUrl), { headers: { authorization: `Bearer ${BUS_TOKEN}` } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.code);
  return value;
}

async function binary(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), { headers: { authorization: `Bearer ${BUS_TOKEN}` } });
  if (!response.ok) throw new Error(`BINARY_${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), sha256: response.headers.get("x-filmos-sha256") };
}

async function bridgeDecision(baseUrl, clientToken, purpose, activeCandidate, decision) {
  const candidate = activeCandidate ?? {};
  const challenge = await request(baseUrl, "POST", "/v1/bridge/challenge", {
    purpose,
    issue_id: ISSUE_ID,
    candidate_id: candidate.candidate_id ?? null,
    candidate_commit: candidate.candidate_commit ?? null,
  }, { token: clientToken, origin: EXTENSION_ORIGIN, userGesture: true });
  chatgptUserGestureClicks += 1;
  const envelope = {
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    purpose,
    issue_id: ISSUE_ID,
    candidate_id: candidate.candidate_id ?? null,
    candidate_commit: candidate.candidate_commit ?? null,
    decision,
  };
  const applied = await request(baseUrl, "POST", "/v1/bridge/decision", envelope, { token: clientToken, origin: EXTENSION_ORIGIN, userGesture: true });
  await expectFailure(() => request(baseUrl, "POST", "/v1/bridge/decision", envelope, { token: clientToken, origin: EXTENSION_ORIGIN, userGesture: true }), "REVIEW_REPLAY_BLOCKED");
  return applied;
}

function candidate(label, fill, runId, issue) {
  const commit = fill.repeat(40);
  return {
    candidate_id: `candidate-${label}`,
    base_commit: BASE_COMMIT,
    candidate_commit: commit,
    tree: String.fromCharCode(fill.charCodeAt(0) + 1).repeat(40),
    branch: `fix/operational-candidate-${label.toLowerCase()}`,
    github_run: { id: runId, head_sha: commit, conclusion: "success" },
    artifact_id: `artifact-${label}`,
    artifact_digest: `sha256:${fill.repeat(64)}`,
    artifact_commit: commit,
    evidence_index_hash: String.fromCharCode(fill.charCodeAt(0) + 2).repeat(64),
    task_package_content_hash: issue.issue_task_package.contentHash,
    consensus_record_hash: issue.consensus_record.contentHash,
    constitution_content_hash: CONSTITUTION_HASH,
    candidate_nonce: `candidate-${label}-nonce-1234567890abcdef`,
    changed_files: ["web/src/components/governance/ReportIssuePortal.tsx", "canvas-agent/src/brains/review-codex-coordinator.ts"],
    known_limitations: ["Automated preflight uses local deterministic GitHub evidence adapter; formal live gate must use GitHub."],
  };
}

function remoteReceipt(value) {
  const base = {
    schema_version: "filmos.github-evidence-verification.v1",
    status: "VERIFIED",
    verification_mode: "DETERMINISTIC_LOCAL_ACCEPTANCE_ONLY",
    repository: "maiyadiu/filmos-studio",
    candidate_commit: value.candidate_commit,
    candidate_tree: value.tree,
    branch: value.branch,
    github_run_id: String(value.github_run.id),
    artifact_id: String(value.artifact_id),
    artifact_digest: value.artifact_digest,
    evidence_index_hash: value.evidence_index_hash,
    checks: { local_adapter_only: true },
    verified_at: "2026-08-31T12:00:00.000Z",
  };
  return { ...base, content_hash: sha256(base) };
}

function finding(findingId) {
  return {
    finding_id: findingId,
    severity: "P0",
    category: "runtime",
    title: "Coordinator restart path needs bound evidence",
    problem: "Candidate A does not yet prove the restart path.",
    evidence: [{ source_type: "artifact", locator: "operational://candidate-a/restart" }],
    required_change: "Complete Candidate B and prove restart recovery.",
    acceptance_gate: "Operational roundtrip restarts and reaches dual approval.",
  };
}

async function expectFailure(action, code) {
  try {
    await action();
  } catch (error) {
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

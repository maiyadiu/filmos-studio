import { randomUUID } from "node:crypto";

import { problem, sha256 } from "./canonical.mjs";
import { ARCHITECTURE_STATES, CONSTITUTION_HASH, CONSTITUTION_VERSION, LATE_FINDING_TAXONOMY, MAIN_STATES, MAX_AUTOMATIC_ROUNDS, TASK_PACKAGE_HASH, assertFastScope, classifyLane } from "./contracts.mjs";
import { evidenceManifest, redactEvidence } from "./redaction.mjs";

const pendingStates = new Set([...MAIN_STATES, ...ARCHITECTURE_STATES].filter((state) => !["PILOT_DEPLOYED", "OBSERVING_IN_USE", "ARCHITECTURE_ADOPTED"].includes(state)));

export class ReviewBusService {
  constructor(store, options = {}) {
    this.store = store;
    this.baseCommit = options.baseCommit ?? "6ea93bfa08381264a1379fe938ade3a7513c7bba";
    this.taskPackageContentHash = options.taskPackageContentHash ?? TASK_PACKAGE_HASH;
    this.candidateEvidenceVerifier = options.candidateEvidenceVerifier ?? null;
    if (this.taskPackageContentHash !== TASK_PACKAGE_HASH) throw problem("TASK_PACKAGE_HASH_MISMATCH");
  }

  createIssue(report, actor = "user", now = new Date()) {
    requireFields(report, ["project_id", "what_happened", "expected_result", "location", "blocks_work"]);
    const lane = report.lane ?? classifyLane(report.risk ?? {});
    if (!["fast", "core", "architecture"].includes(lane)) throw problem("INVALID_LANE");
    const issueId = report.issue_id ?? `${lane === "architecture" ? "FILMOS-ARCH" : "FILMOS-ISSUE"}-${randomUUID()}`;
    const expectedPattern = lane === "architecture" ? /^FILMOS-ARCH-[A-Za-z0-9-]{1,120}$/ : /^FILMOS-ISSUE-[A-Za-z0-9-]{1,120}$/;
    if (!expectedPattern.test(issueId)) throw problem("INVALID_ISSUE_ID");
    const existing = this.store.get(issueId);
    if (existing) {
      if (existing.project_id !== report.project_id || existing.lane !== lane || sha256(existing.report) !== sha256(report)) throw problem("ISSUE_IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const initialState = lane === "architecture" ? "REQUIREMENT_OBSERVED" : "OBSERVED_IN_USE";
    return this.store.append({
      issueId, projectId: report.project_id, lane, eventType: "issue.observed", actor,
      payload: { report }, now,
      mutate: () => ({
        schema_version: "filmos.review-session.v1", issue_id: issueId, project_id: report.project_id,
        lane, state: initialState, report, base_commit: this.baseCommit,
        constitution_version: CONSTITUTION_VERSION, constitution_content_hash: CONSTITUTION_HASH,
        task_package_content_hash: this.taskPackageContentHash, current_round: 1,
        max_automatic_rounds: MAX_AUTOMATIC_ROUNDS, assessments: {}, findings: [], finding_responses: [],
        candidate_history: [], stale_candidate_bindings: [],
        verdicts: { codex: null, chatgpt: null, machine: null }, next_pilot_allowed: false,
      }),
    });
  }

  freezeEvidence(issueId, input, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (!Array.isArray(input.items) || input.items.length === 0) throw problem("EVIDENCE_REQUIRED");
    const items = input.items.map((item) => ({ ...item, captured_at: item.captured_at ?? now.toISOString() }));
    const redactedItems = redactEvidence(items);
    const manifest = evidenceManifest({ issueId, sourceCommit: input.source_commit ?? current.base_commit, items, frozenAt: now.toISOString() });
    const complete = manifest.completeness.reproduction && manifest.completeness.runtime && manifest.completeness.logs && manifest.completeness.sourceMap;
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "evidence.frozen", actor,
      payload: { manifest, redacted_items: redactedItems }, now,
      mutate: (next) => {
        next.evidence = { local_items: items, redacted_items: redactedItems, manifest };
        next.state = complete ? (next.lane === "architecture" ? "ARCHITECTURE_EVIDENCE_FROZEN" : "EVIDENCE_FROZEN") : "EVIDENCE_REQUIRED";
        return next;
      },
    });
  }

  submitAssessment(issueId, actor, assessment, now = new Date()) {
    if (!['codex', 'chatgpt'].includes(actor)) throw problem("INVALID_ASSESSOR");
    const current = this.requireIssue(issueId);
    if (!current.evidence?.manifest || current.state === "EVIDENCE_REQUIRED") throw problem("EVIDENCE_REQUIRED");
    if (current.assessments[actor]) throw problem("ASSESSMENT_IMMUTABLE");
    requireFields(assessment, actor === "codex"
      ? ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"]
      : ["product_goal_fit", "root_cause_explains_symptom", "authority_risk", "resolution_layer", "workflow_impact", "acceptance_gates", "scope_drift"]);
    const sealed = { ...assessment, assessor: actor, submitted_at: now.toISOString(), content_hash: sha256(assessment), sealed_until_pair_complete: true };
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: `assessment.${actor}.submitted`, actor,
      payload: { content_hash: sealed.content_hash }, now,
      mutate: (next) => {
        next.assessments[actor] = sealed;
        const paired = Boolean(next.assessments.codex && next.assessments.chatgpt);
        next.state = paired ? "CONSENSUS_REVIEW" : actor === "codex"
          ? (next.lane === "architecture" ? "CHATGPT_ARCHITECTURE_ASSESSMENT" : "CHATGPT_ASSESSING")
          : (next.lane === "architecture" ? "CODEX_ARCHITECTURE_ASSESSMENT" : "CODEX_ASSESSING");
        if (paired) next.consensus_delta = consensusDelta(next.assessments.codex, next.assessments.chatgpt);
        return next;
      },
    });
  }

  assessmentBlind(issueId, viewer) {
    if (!['codex', 'chatgpt'].includes(viewer)) throw problem("INVALID_ASSESSOR");
    const current = this.requireIssue(issueId);
    const own = current.assessments?.[viewer] ?? null;
    const paired = Boolean(current.assessments?.codex && current.assessments?.chatgpt);
    if (!paired) return { issue_id: issueId, own_assessment: own, counterpart_assessment: null, counterpart_sealed: true, pair_complete: false };
    const counterpart = viewer === "codex" ? current.assessments.chatgpt : current.assessments.codex;
    return { issue_id: issueId, own_assessment: own, counterpart_assessment: counterpart, counterpart_sealed: false, pair_complete: true, consensus_delta: current.consensus_delta };
  }

  setConsensus(issueId, record, actor = "system", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (!current.assessments?.codex || !current.assessments?.chatgpt) throw problem("PAIR_ASSESSMENT_REQUIRED");
    requireFields(record, ["rootCause", "resolutionLayer", "allowedChangeScope", "explicitNonGoals", "implementationPlan", "acceptanceGates", "rollbackPlan", "codexAccepted", "chatgptAccepted"]);
    if (record.codexAccepted !== true || record.chatgptAccepted !== true) throw problem("CONSENSUS_NOT_DUAL_ACCEPTED");
    const base = { ...record, issueId, constitutionVersion: CONSTITUTION_VERSION, constitutionContentHash: CONSTITUTION_HASH, createdAt: now.toISOString() };
    const consensusRecord = { ...base, contentHash: sha256(base) };
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "consensus.reached", actor,
      payload: { content_hash: consensusRecord.contentHash }, now,
      mutate: (next) => { next.consensus_record = consensusRecord; next.state = "CONSENSUS_REACHED"; return next; },
    });
  }

  freezeRequirementDelta(issueId, delta, actor = "user", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.lane !== "architecture") throw problem("ARCHITECTURE_LANE_REQUIRED");
    requireFields(delta, ["current_flow", "current_blocker", "target_experience", "must_preserve", "may_change", "success_criteria"]);
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "architecture.requirement_delta.frozen", actor, payload: delta, now,
      mutate: (next) => { next.requirement_delta = { ...delta, content_hash: sha256(delta) }; next.state = "REQUIREMENT_DELTA_FROZEN"; return next; } });
  }

  setArchitectureOptions(issueId, options, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.lane !== "architecture" || !current.requirement_delta) throw problem("REQUIREMENT_DELTA_REQUIRED");
    const names = new Set((options ?? []).map((item) => item.option));
    if (!["A", "B", "C"].every((name) => names.has(name))) throw problem("ARCHITECTURE_OPTIONS_A_B_C_REQUIRED");
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "architecture.options.recorded", actor, payload: { options }, now,
      mutate: (next) => { next.architecture_options = options; next.state = "OPTION_COMPARISON"; return next; } });
  }

  async submitCandidate(issueId, candidate, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.state === "OWNER_DECISION_REQUIRED") throw problem("OWNER_DECISION_REQUIRED");
    if (actor !== "codex") throw problem("CANDIDATE_SUBMITTER_MUST_BE_CODEX");
    if (current.active_candidate) throw problem("ACTIVE_CANDIDATE_IMMUTABLE");
    requireFields(candidate, ["candidate_id", "base_commit", "candidate_commit", "tree", "branch", "github_run", "artifact_id", "artifact_digest", "artifact_commit", "evidence_index_hash", "task_package_content_hash", "constitution_content_hash", "candidate_nonce", "changed_files", "known_limitations"]);
    if (candidate.base_commit !== current.base_commit) throw problem("CANDIDATE_BASE_MISMATCH");
    validateCandidateBinding(candidate, current);
    if (current.lane === "fast") assertFastScope(candidate.changed_files, candidate.patch_summary ?? "");
    else if (!current.consensus_record) throw problem("IMPLEMENTATION_BLOCKED_NO_CONSENSUS");
    if (current.lane === "architecture" && (!current.requirement_delta || !current.architecture_options)) throw problem("ARCHITECTURE_CONSENSUS_PREREQUISITES_MISSING");
    if (!this.candidateEvidenceVerifier) throw problem("REMOTE_EVIDENCE_VERIFIER_REQUIRED");
    const remoteEvidenceReceipt = await this.candidateEvidenceVerifier.verify(candidate);
    if (remoteEvidenceReceipt?.verified !== true) throw problem("REMOTE_EVIDENCE_VERIFICATION_FAILED");
    const base = { ...candidate, issue_id: issueId, constitution_version: CONSTITUTION_VERSION, constitution_content_hash: CONSTITUTION_HASH, task_package_content_hash: current.task_package_content_hash, remote_evidence_receipt: remoteEvidenceReceipt, submitted_at: now.toISOString() };
    const activeCandidate = { ...base, content_hash: sha256(base) };
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "candidate.submitted", actor, payload: { candidate: activeCandidate }, now,
      mutate: (next) => { if (next.active_candidate) throw problem("ACTIVE_CANDIDATE_IMMUTABLE"); next.active_candidate = activeCandidate; next.state = "CODEX_IMPLEMENTING"; return next; } });
  }

  addFinding(issueId, finding, actor = "chatgpt", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "chatgpt") throw problem("EXTERNAL_FINDING_ACTOR_REQUIRED");
    requireFields(finding, ["finding_id", "severity", "summary"]);
    if (current.current_round > 1 && !LATE_FINDING_TAXONOMY.includes(finding.late_finding_classification)) throw problem("LATE_FINDING_CLASSIFICATION_REQUIRED");
    if (finding.late_finding_classification === "SCOPE_EXPANSION") finding.status = "OWNER_DECISION_REQUIRED";
    const candidateIdentity = current.active_candidate ? { candidate_id: current.active_candidate.candidate_id, candidate_commit: current.active_candidate.candidate_commit, candidate_content_hash: current.active_candidate.content_hash } : {};
    const value = { ...finding, ...candidateIdentity, status: finding.status ?? "OPEN", round: current.current_round, created_at: now.toISOString() };
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "finding.added", actor, payload: value, now,
      mutate: (next) => { next.findings.push(value); if (value.status === "OWNER_DECISION_REQUIRED") next.state = "OWNER_DECISION_REQUIRED"; return next; } });
  }

  respondFinding(issueId, response, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "codex") throw problem("CODEX_RESPONSE_ACTOR_REQUIRED");
    requireFields(response, ["finding_id", "disposition", "evidence"]);
    if (!["DISPUTED_FALSE_POSITIVE", "NEEDS_MORE_EVIDENCE", "NEEDS_OWNER_DECISION", "BLOCKED_EXTERNAL", "FIXED_WITH_EVIDENCE"].includes(response.disposition)) throw problem("INVALID_FINDING_RESPONSE");
    const value = { ...response, response_id: `finding-response-${randomUUID()}`, created_at: now.toISOString() };
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "finding.codex_response", actor, payload: value, now,
      mutate: (next) => { next.finding_responses.push(value); return next; } });
  }

  decideFinding(issueId, findingId, decision, actor = "chatgpt", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "chatgpt") throw problem("REVIEW_CODEX_CANNOT_SELF_CLOSE");
    if (!["DISPUTE_ACCEPTED", "FINDING_REMAINS", "EVIDENCE_REQUIRED", "OWNER_DECISION_REQUIRED"].includes(decision)) throw problem("INVALID_FINDING_DECISION");
    const finding = current.findings.find((item) => item.finding_id === findingId);
    if (!finding) throw problem("FINDING_NOT_FOUND", "FINDING_NOT_FOUND", 404);
    if (finding.candidate_id && finding.candidate_id !== current.active_candidate?.candidate_id) throw problem("STALE_CANDIDATE_BINDING");
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "finding.external_decision", actor, payload: { finding_id: findingId, decision }, now,
      mutate: (next) => { const item = next.findings.find((entry) => entry.finding_id === findingId); item.status = decision === "DISPUTE_ACCEPTED" ? "CLOSED" : decision; return next; } });
  }

  applyChatGPTReviewDecision(issueId, input, challenge, now = new Date()) {
    const current = this.requireIssue(issueId);
    if (!current.active_candidate) throw problem("CURRENT_CANDIDATE_BINDING_REQUIRED");
    if (input.candidate_id !== current.active_candidate.candidate_id) throw problem("CANDIDATE_BINDING_MISMATCH");
    if (input.candidate_commit !== current.active_candidate.candidate_commit) throw problem("CANDIDATE_COMMIT_MISMATCH");
    const decision = input.decision;
    requireFields(decision, ["verdict", "binding", "findings"]);
    if (!["EXTERNAL_APPROVED", "CHANGES_REQUIRED"].includes(decision.verdict)) throw problem("INVALID_VERDICT");
    assertCurrentCandidateBinding(current, decision.binding);
    if (!Array.isArray(decision.findings)) throw problem("INVALID_FINDINGS");
    const existingIds = new Set(current.findings.map((item) => item.finding_id));
    const findingIds = new Set();
    const candidateIdentity = { candidate_id: current.active_candidate.candidate_id, candidate_commit: current.active_candidate.candidate_commit, candidate_content_hash: current.active_candidate.content_hash };
    const findings = decision.findings.map((finding) => {
      requireFields(finding, ["finding_id", "severity", "summary"]);
      if (!/^finding-[A-Za-z0-9-]{1,120}$/.test(finding.finding_id) || existingIds.has(finding.finding_id) || findingIds.has(finding.finding_id)) throw problem("INVALID_FINDING");
      if (!["P0", "P1", "P2"].includes(finding.severity)) throw problem("INVALID_FINDING_SEVERITY");
      if (typeof finding.summary !== "string" || !finding.summary.trim() || finding.summary.length > 4000) throw problem("INVALID_FINDING");
      if ((finding.candidate_id != null && finding.candidate_id !== candidateIdentity.candidate_id) || (finding.candidate_commit != null && finding.candidate_commit !== candidateIdentity.candidate_commit)) throw problem("CANDIDATE_BINDING_MISMATCH");
      if (current.current_round > 1 && !LATE_FINDING_TAXONOMY.includes(finding.late_finding_classification)) throw problem("LATE_FINDING_CLASSIFICATION_REQUIRED");
      findingIds.add(finding.finding_id);
      const status = finding.late_finding_classification === "SCOPE_EXPANSION" ? "OWNER_DECISION_REQUIRED" : finding.status ?? "OPEN";
      if (!["OPEN", "OWNER_DECISION_REQUIRED"].includes(status)) throw problem("INVALID_FINDING_STATUS");
      return { ...finding, ...candidateIdentity, status, round: current.current_round, created_at: now.toISOString() };
    });
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "chatgpt.review_decision", actor: "chatgpt",
      payload: { candidate: candidateIdentity, verdict: decision.verdict, findings }, challenge, now,
      mutate: (next) => {
        next.findings.push(...findings);
        next.verdicts.chatgpt = decision.verdict;
        next.verdict_bindings ??= {};
        next.verdict_bindings.chatgpt = decision.binding;
        next.state = findings.some((item) => item.status === "OWNER_DECISION_REQUIRED") ? "OWNER_DECISION_REQUIRED" : "CHATGPT_EXTERNAL_REVIEW";
        next.next_pilot_allowed = pilotAllowed(next);
        if (next.next_pilot_allowed) { next.state = "DUAL_APPROVED"; next.dual_signoff = dualSignoff(next, now); }
        return next;
      },
    });
  }

  recordVerdict(issueId, actor, input, now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.state === "OWNER_DECISION_REQUIRED") throw problem("OWNER_DECISION_REQUIRED");
    const verdict = typeof input === "string" ? input : input?.verdict;
    const allowed = actor === "codex" ? ["LOCAL_ACCEPTED", "CHANGES_REQUIRED"] : actor === "chatgpt" ? ["EXTERNAL_APPROVED", "CHANGES_REQUIRED"] : actor === "machine" ? ["PASS", "FAIL"] : [];
    if (!allowed.includes(verdict)) throw problem(actor === "codex" && verdict === "EXTERNAL_APPROVED" ? "REVIEW_CODEX_CANNOT_SELF_APPROVE" : "INVALID_VERDICT");
    const binding = typeof input === "object" ? input.binding : null;
    assertCurrentCandidateBinding(current, binding);
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: `verdict.${actor}`, actor, payload: { verdict }, now,
      mutate: (next) => {
        next.verdicts[actor] = verdict;
        next.verdict_bindings ??= {};
        next.verdict_bindings[actor] = binding;
        if (actor === "codex" && verdict === "LOCAL_ACCEPTED") next.state = "CODEX_LOCAL_ACCEPTED";
        if (actor === "chatgpt" && verdict === "EXTERNAL_APPROVED") next.state = "CHATGPT_EXTERNAL_REVIEW";
        if (actor === "machine" && verdict === "PASS") next.state = "MACHINE_PASS";
        next.next_pilot_allowed = pilotAllowed(next);
        if (next.next_pilot_allowed) { next.state = "DUAL_APPROVED"; next.dual_signoff = dualSignoff(next, now); }
        return next;
      },
    });
  }

  deployPilot(issueId, release, actor = "system", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (!pilotAllowed(current)) throw problem("PILOT_GATE_BLOCKED");
    const value = { ...release, issue_id: issueId, candidate_binding: candidateBinding(current.active_candidate), constitution_version: CONSTITUTION_VERSION, constitution_content_hash: CONSTITUTION_HASH, task_package_content_hash: current.task_package_content_hash, created_at: now.toISOString() };
    value.content_hash = sha256(value);
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "pilot.deployed", actor, payload: value, now,
      mutate: (next) => { next.pilot_release = value; next.state = next.lane === "architecture" ? "PILOT_MIGRATION" : "PILOT_DEPLOYED"; next.next_pilot_allowed = true; return next; } });
  }

  nextRound(issueId, actor = "system", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.state === "OWNER_DECISION_REQUIRED") throw problem("OWNER_DECISION_REQUIRED");
    const nextRound = current.current_round + 1;
    const p0 = current.findings.filter((item) => item.severity === "P0" && item.status !== "CLOSED").length;
    const supersededAt = now.toISOString();
    const staleBinding = current.active_candidate ? { ...candidateBinding(current.active_candidate), superseded_at: supersededAt, superseded_in_round: nextRound } : null;
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "review.round.advanced", actor,
      payload: { round: nextRound, superseded_candidate_id: current.active_candidate?.candidate_id ?? null }, now,
      revokeCandidateChallenges: current.active_candidate ? { issueId, candidateId: current.active_candidate.candidate_id, candidateCommit: current.active_candidate.candidate_commit } : null,
      mutate: (next) => {
        next.candidate_history ??= [];
        next.stale_candidate_bindings ??= [];
        if (next.active_candidate) next.candidate_history.push({ ...next.active_candidate, lifecycle_status: "SUPERSEDED", superseded_at: supersededAt, superseded_in_round: nextRound });
        if (staleBinding) next.stale_candidate_bindings.push(staleBinding);
        next.active_candidate = null;
        next.verdicts = { codex: null, chatgpt: null, machine: null };
        next.verdict_bindings = {};
        delete next.dual_signoff;
        next.next_pilot_allowed = false;
        next.current_round = nextRound;
        next.state = nextRound > next.max_automatic_rounds && p0 > 0 ? "OWNER_DECISION_REQUIRED" : "CODEX_IMPLEMENTING";
        return next;
      },
    });
  }

  pending(projectId) { return this.store.list({ projectId }).filter((item) => pendingStates.has(item.state)).map(readSummary); }
  readRedacted(issueId, projectId) { const value = this.requireScoped(issueId, projectId); return redactedProjection(value); }
  requireIssue(issueId) { const value = this.store.get(issueId); if (!value) throw problem("ISSUE_NOT_FOUND", "ISSUE_NOT_FOUND", 404); return value; }
  requireScoped(issueId, projectId) { const value = this.requireIssue(issueId); if (value.project_id !== projectId) throw problem("PROJECT_SCOPE_DENIED", "PROJECT_SCOPE_DENIED", 403); return value; }
}

function consensusDelta(codex, chatgpt) {
  const agreements = [], disagreements = [], evidenceDifferences = [];
  if (String(codex.root_cause).toLowerCase() === String(chatgpt.root_cause ?? "").toLowerCase()) agreements.push("root_cause"); else disagreements.push("root_cause");
  if (chatgpt.root_cause_explains_symptom === true) agreements.push("symptom_explanation"); else disagreements.push("symptom_explanation");
  if (codex.needs_more_evidence || chatgpt.needs_more_evidence) evidenceDifferences.push("additional_evidence_requested");
  const base = { agreements, disagreements, evidence_differences: evidenceDifferences, scope_conflict: chatgpt.scope_drift === true };
  return { ...base, content_hash: sha256(base) };
}

function pilotAllowed(value) {
  if (!value.active_candidate || value.state === "OWNER_DECISION_REQUIRED") return false;
  const unresolved = value.findings.filter((item) => item.status !== "CLOSED" && (!item.candidate_id || item.candidate_id === value.active_candidate.candidate_id));
  const blocking = unresolved.filter((item) => item.severity === "P0" || (item.severity === "P1" && item.accepted_limitation !== true));
  const currentBinding = candidateBinding(value.active_candidate);
  const verdictsBound = ["codex", "chatgpt", "machine"].every((actor) => value.verdict_bindings?.[actor] && sha256(value.verdict_bindings[actor]) === sha256(currentBinding));
  const externalBindings = value.active_candidate.github_run?.head_sha === value.active_candidate.candidate_commit
    && value.active_candidate.github_run?.conclusion === "success"
    && value.active_candidate.artifact_commit === value.active_candidate.candidate_commit
    && value.active_candidate.remote_evidence_receipt?.verified === true;
  return value.verdicts.codex === "LOCAL_ACCEPTED" && value.verdicts.chatgpt === "EXTERNAL_APPROVED" && value.verdicts.machine === "PASS" && blocking.length === 0 && verdictsBound && externalBindings && value.active_candidate.constitution_content_hash === CONSTITUTION_HASH && value.active_candidate.task_package_content_hash === value.task_package_content_hash;
}

function dualSignoff(value, now) {
  const base = { issue_id: value.issue_id, candidate_binding: candidateBinding(value.active_candidate), codex: "LOCAL_ACCEPTED", chatgpt: "EXTERNAL_APPROVED", machine: "PASS", constitution_content_hash: CONSTITUTION_HASH, task_package_content_hash: value.task_package_content_hash, signed_at: now.toISOString() };
  return { ...base, content_hash: sha256(base) };
}

function readSummary(value) { return { issue_id: value.issue_id, project_id: value.project_id, lane: value.lane, state: value.state, what_happened: value.report.what_happened, blocks_work: value.report.blocks_work, updated_at: value.updated_at, content_hash: value.content_hash }; }
function redactedProjection(value) { const next = structuredClone(value); if (next.evidence) delete next.evidence.local_items; return redactEvidence(next); }
function requireFields(value, fields) { for (const field of fields) if (!(field in (value ?? {}))) throw problem(`MISSING_${field.toUpperCase()}`); }

function validateCandidateBinding(candidate, current) {
  if (!/^[0-9a-f]{40,64}$/.test(candidate.candidate_commit) || !/^[0-9a-f]{40,64}$/.test(candidate.tree)) throw problem("INVALID_CANDIDATE_GIT_BINDING");
  if (!candidate.github_run || !candidate.github_run.id || candidate.github_run.head_sha !== candidate.candidate_commit) throw problem("GITHUB_RUN_COMMIT_MISMATCH");
  if (!candidate.artifact_id || !/^sha256:[0-9a-f]{64}$/.test(candidate.artifact_digest) || candidate.artifact_commit !== candidate.candidate_commit) throw problem("ARTIFACT_COMMIT_MISMATCH");
  if (!/^[0-9a-f]{64}$/.test(candidate.evidence_index_hash)) throw problem("INVALID_EVIDENCE_INDEX_HASH");
  if (candidate.task_package_content_hash !== current.task_package_content_hash) throw problem("TASK_PACKAGE_HASH_MISMATCH");
  if (candidate.constitution_content_hash !== CONSTITUTION_HASH) throw problem("CONSTITUTION_HASH_MISMATCH");
  if (typeof candidate.candidate_nonce !== "string" || candidate.candidate_nonce.length < 16) throw problem("CANDIDATE_NONCE_REQUIRED");
}

export function candidateBinding(candidate) {
  return { candidate_id: candidate.candidate_id, base_commit: candidate.base_commit, candidate_commit: candidate.candidate_commit, tree: candidate.tree, branch: candidate.branch, github_run: candidate.github_run, artifact_id: candidate.artifact_id, artifact_digest: candidate.artifact_digest, artifact_commit: candidate.artifact_commit, evidence_index_hash: candidate.evidence_index_hash, task_package_content_hash: candidate.task_package_content_hash, constitution_content_hash: candidate.constitution_content_hash, candidate_nonce: candidate.candidate_nonce, changed_files: candidate.changed_files, known_limitations: candidate.known_limitations, remote_evidence_receipt: candidate.remote_evidence_receipt, content_hash: candidate.content_hash };
}

function assertCurrentCandidateBinding(current, binding) {
  if (!current.active_candidate || !binding) throw problem("CURRENT_CANDIDATE_BINDING_REQUIRED");
  const expected = candidateBinding(current.active_candidate);
  if (sha256(binding) !== sha256(expected)) throw problem("CURRENT_CANDIDATE_BINDING_MISMATCH");
}

import { sha256 } from "./canonical.mjs";

export function buildLiveRoundtripTrace(issue, events, { eventChainVerified = false, generatedAt = new Date() } = {}) {
  const failures = [];
  const history = issue?.candidate_history ?? [];
  const findings = issue?.findings ?? [];
  const remoteReceipts = history.map((entry) => entry?.candidate?.github_remote_verification);
  const chatgptAssessmentEvents = events.filter((event) => event.actor === "chatgpt" && event.event_type === "assessment.chatgpt.submitted");
  const chatgptConsensusEvents = events.filter((event) => event.actor === "chatgpt" && event.event_type === "consensus.responded");
  const chatgptReviewEvents = events.filter((event) => event.actor === "chatgpt" && event.event_type === "chatgpt.review_decision");
  const expectedAssessments = assessmentRounds(issue).map((round) => round.assessment.content_hash);
  const expectedConsensusResponses = assessmentRounds(issue).map((round) => round.consensus_response.content_hash);
  const expectedReviewDecisions = issue?.decision_history ?? [];
  const chatgptEvents = [...chatgptAssessmentEvents, ...chatgptConsensusEvents, ...chatgptReviewEvents];

  requireGate(issue?.state === "DUAL_APPROVED", "DUAL_APPROVED_REQUIRED", failures);
  requireGate(history.length === 2, "EXACTLY_TWO_CANDIDATES_REQUIRED", failures);
  requireGate(history[0]?.status === "SUPERSEDED", "CANDIDATE_A_SUPERSEDED_REQUIRED", failures);
  requireGate(history[1]?.status === "APPROVED", "CANDIDATE_B_APPROVED_REQUIRED", failures);
  requireGate(history[0]?.supersededByCandidateId === history[1]?.candidate?.candidate_id, "CANDIDATE_A_B_LINK_REQUIRED", failures);
  requireGate(new Set(history.map((entry) => entry?.candidate?.candidate_id)).size === 2, "CANDIDATE_IDS_MUST_BE_UNIQUE", failures);
  requireGate(issue?.current_round === 2, "CANDIDATE_ROUND_TWO_REQUIRED", failures);
  requireGate(issue?.verdicts?.codex === "LOCAL_ACCEPTED", "CODEX_SIGNOFF_REQUIRED", failures);
  requireGate(issue?.verdicts?.chatgpt === "EXTERNAL_APPROVED", "CHATGPT_SIGNOFF_REQUIRED", failures);
  requireGate(issue?.verdicts?.machine === "PASS", "MACHINE_PASS_REQUIRED", failures);
  requireGate(Boolean(issue?.dual_signoff?.content_hash), "DUAL_SIGNOFF_RECEIPT_REQUIRED", failures);
  requireGate(findings.filter((item) => item.severity === "P0" && item.status !== "CLOSED").length === 0, "OPEN_P0_MUST_BE_ZERO", failures);
  requireGate((issue?.decision_history ?? []).length === 2, "TWO_CHATGPT_REVIEW_DECISIONS_REQUIRED", failures);
  requireGate((issue?.decision_history ?? [])[0]?.verdict === "CHANGES_REQUIRED", "CANDIDATE_A_FINDING_REQUIRED", failures);
  requireGate((issue?.decision_history ?? [])[1]?.verdict === "EXTERNAL_APPROVED", "CANDIDATE_B_APPROVAL_REQUIRED", failures);
  requireGate((issue?.finding_responses ?? []).some((item) => item.disposition === "FIXED_WITH_EVIDENCE"), "CODEX_FINDING_RESPONSE_REQUIRED", failures);
  requireGate(Boolean(issue?.issue_task_package?.contentHash), "ISSUE_TASK_PACKAGE_REQUIRED", failures);
  requireGate(Boolean(issue?.consensus_record?.contentHash), "CONSENSUS_RECORD_REQUIRED", failures);
  requireGate((issue?.runtime_recovery?.observed_start_ids ?? []).length >= 2, "RESTART_RECOVERY_REQUIRED", failures);
  requireGate(eventChainVerified === true, "EVENT_CHAIN_VERIFICATION_REQUIRED", failures);
  requireGate(assessmentRoundHistoryValid(issue), "ASSESSMENT_ROUND_HISTORY_INTEGRITY_REQUIRED", failures);
  requireGate(expectedAssessments.length > 0 && exactProjectionEvents(issue.issue_id, chatgptAssessmentEvents, expectedAssessments, (event) => event.payload?.content_hash), "CHATGPT_ASSESSMENT_WRITEBACK_REQUIRED", failures);
  requireGate(expectedConsensusResponses.length > 0 && exactProjectionEvents(issue.issue_id, chatgptConsensusEvents, expectedConsensusResponses, (event) => event.payload?.content_hash), "CHATGPT_CONSENSUS_WRITEBACK_REQUIRED", failures);
  requireGate(exactProjectionEvents(issue.issue_id, chatgptReviewEvents, expectedReviewDecisions.map((decision) => decision.content_hash), (event) => event.payload?.decision?.content_hash)
    && reviewDecisionsMatchCandidates(expectedReviewDecisions, history), "CHATGPT_A_B_REVIEW_WRITEBACK_REQUIRED", failures);
  requireGate(events.some((event) => event.event_type === "assessment.codex.submitted"), "CODEX_ASSESSMENT_REQUIRED", failures);
  requireGate(events.some((event) => event.event_type === "finding.codex_response"), "CODEX_FINDING_RESPONSE_EVENT_REQUIRED", failures);
  requireGate(events.some((event) => event.event_type === "verdict.codex" || (event.event_type === "candidate.approved" && event.actor === "codex")), "CODEX_VERDICT_EVENT_REQUIRED", failures);
  requireGate(Boolean(issue?.codex_coordination?.session_id) && events.some((event) => event.event_type === "codex.coordination"), "CODEX_SUBSCRIPTION_COORDINATION_REQUIRED", failures);
  requireGate(remoteReceipts.length === 2 && remoteReceipts.every(formalRemoteReceipt), "FORMAL_GITHUB_REMOTE_EVIDENCE_REQUIRED", failures);
  requireGate((issue?.attachments ?? []).length > 0 && (issue?.attachments ?? []).every((item) => /^[0-9a-f]{64}$/.test(item.sha256 ?? "")), "HASHED_ATTACHMENT_EVIDENCE_REQUIRED", failures);
  if (failures.length) throw Object.assign(new Error(failures.join(",")), { code: "LIVE_ROUNDTRIP_GATE_FAILED", failures });

  const base = {
    schema_version: "filmos.v1-1-dual-expert-live-roundtrip-trace.v1",
    gate_id: "V1-1-DUAL-EXPERT-LIVE-ROUNDTRIP-001",
    status: "PASSED",
    issue_id: issue.issue_id,
    project_id: issue.project_id,
    generated_at: generatedAt.toISOString(),
    candidate_a: candidateReceipt(history[0]),
    candidate_b: candidateReceipt(history[1]),
    candidate_rounds: 2,
    restart_recovery_count: issue.runtime_recovery.observed_start_ids.length - 1,
    event_chain_verified: true,
    event_chain_head: events.at(-1)?.event_hash ?? null,
    event_count: events.length,
    chatgpt_user_gesture_writebacks: {
      exact_count: chatgptEvents.length,
      assessment: chatgptAssessmentEvents.length,
      consensus: chatgptConsensusEvents.length,
      candidate_reviews: chatgptReviewEvents.length,
      assessment_rounds: expectedAssessments.length,
    },
    codex_coordination: {
      status: issue.codex_coordination?.status ?? null,
      session_id_hash: issue.codex_coordination?.session_id ? sha256(issue.codex_coordination.session_id) : null,
    },
    evidence_manifest_hash: issue.evidence?.manifest?.contentHash ?? null,
    attachment_hashes: issue.attachments.map((item) => ({ attachment_id: item.attachment_id, sha256: item.sha256, size_bytes: item.size_bytes })),
    issue_task_package_hash: issue.issue_task_package.contentHash,
    consensus_record_hash: issue.consensus_record.contentHash,
    dual_signoff_hash: issue.dual_signoff.content_hash,
    codex_signoff: issue.verdicts.codex,
    chatgpt_signoff: issue.verdicts.chatgpt,
    machine_verdict: issue.verdicts.machine,
    open_p0: 0,
    formal_github_remote_evidence: true,
    openai_model_api_calls: 0,
    real_provider_operations: 0,
    real_provider_cost: 0,
  };
  return { ...base, content_hash: sha256(base) };
}

function formalRemoteReceipt(receipt) {
  if (!receipt || receipt.status !== "VERIFIED" || receipt.repository !== "maiyadiu/filmos-studio" || receipt.verification_mode) return false;
  const payload = { ...receipt };
  delete payload.content_hash;
  return /^[0-9a-f]{64}$/.test(receipt.content_hash ?? "")
    && sha256(payload) === receipt.content_hash
    && Object.keys(receipt.checks ?? {}).length >= 10
    && Object.values(receipt.checks ?? {}).every(Boolean);
}

function candidateReceipt(entry) {
  const candidate = entry.candidate;
  return {
    candidate_id: candidate.candidate_id,
    status: entry.status,
    round: entry.round,
    commit: candidate.candidate_commit,
    tree: candidate.tree,
    branch: candidate.branch,
    github_run_id: String(candidate.github_run.id),
    artifact_id: String(candidate.artifact_id),
    artifact_digest: candidate.artifact_digest,
    evidence_index_hash: candidate.evidence_index_hash,
    github_verification_receipt_hash: candidate.github_remote_verification.content_hash,
  };
}

function assessmentRounds(issue) {
  const rounds = (issue?.assessment_round_history ?? []).map((entry) => ({
    round: entry.assessment_round,
    assessment: entry.assessments?.chatgpt,
    consensus_response: entry.consensus_responses?.find((response) => response.actor === "chatgpt"),
  }));
  if (issue?.assessments?.chatgpt || issue?.consensus_responses?.some((response) => response.actor === "chatgpt")) {
    rounds.push({
      round: issue.assessment_round ?? 1,
      assessment: issue.assessments?.chatgpt,
      consensus_response: issue.consensus_responses?.find((response) => response.actor === "chatgpt"),
    });
  }
  return rounds;
}

function assessmentRoundHistoryValid(issue) {
  let previousRound = 0;
  for (const entry of issue?.assessment_round_history ?? []) {
    const base = { ...entry };
    delete base.content_hash;
    if (!Number.isInteger(entry.assessment_round) || entry.assessment_round <= previousRound
      || !/^[0-9a-f]{64}$/.test(entry.content_hash ?? "") || sha256(base) !== entry.content_hash
      || !validAssessmentRound(entry.assessment_round, entry.assessments, entry.consensus_responses)) return false;
    previousRound = entry.assessment_round;
  }
  const currentRound = issue?.assessment_round ?? 1;
  return currentRound > previousRound && validAssessmentRound(currentRound, issue?.assessments, issue?.consensus_responses);
}

function validAssessmentRound(round, assessments, responses) {
  const chatgptResponses = (responses ?? []).filter((response) => response.actor === "chatgpt");
  return /^[0-9a-f]{64}$/.test(assessments?.chatgpt?.content_hash ?? "")
    && assessments.chatgpt.assessment_round === round
    && chatgptResponses.length === 1
    && /^[0-9a-f]{64}$/.test(chatgptResponses[0].content_hash ?? "");
}

function exactProjectionEvents(issueId, events, expectedHashes, readHash) {
  if (events.length !== expectedHashes.length || expectedHashes.length === 0) return false;
  const actual = events.map((event) => event.issue_id === issueId ? readHash(event) : null);
  if (actual.some((hash) => !/^[0-9a-f]{64}$/.test(hash ?? ""))) return false;
  return actual.toSorted().join("\n") === expectedHashes.toSorted().join("\n");
}

function reviewDecisionsMatchCandidates(decisions, history) {
  if (decisions.length !== 2 || history.length !== 2) return false;
  return decisions.every((decision, index) => {
    const candidate = history[index]?.candidate;
    return decision?.purpose === "CHATGPT_REVIEW_DECISION"
      && decision?.round === history[index]?.round
      && sha256(decision?.candidate_binding) === sha256(candidateBinding(candidate));
  });
}

function candidateBinding(candidate) {
  return {
    candidate_id: candidate?.candidate_id,
    base_commit: candidate?.base_commit,
    candidate_commit: candidate?.candidate_commit,
    tree: candidate?.tree,
    branch: candidate?.branch,
    github_run: candidate?.github_run,
    artifact_id: candidate?.artifact_id,
    artifact_digest: candidate?.artifact_digest,
    artifact_commit: candidate?.artifact_commit,
    evidence_index_hash: candidate?.evidence_index_hash,
    github_remote_verification: candidate?.github_remote_verification,
    task_package_content_hash: candidate?.task_package_content_hash,
    consensus_record_hash: candidate?.consensus_record_hash ?? null,
    constitution_content_hash: candidate?.constitution_content_hash,
    candidate_nonce: candidate?.candidate_nonce,
    changed_files: candidate?.changed_files,
    known_limitations: candidate?.known_limitations,
    content_hash: candidate?.content_hash,
  };
}

function requireGate(condition, code, failures) { if (!condition) failures.push(code); }

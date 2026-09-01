import { randomUUID } from "node:crypto";

import { exactObject, problem, sha256 } from "./canonical.mjs";
import { ARCHITECTURE_STATES, CONSTITUTION_HASH, CONSTITUTION_VERSION, LATE_FINDING_TAXONOMY, MAIN_STATES, MAX_AUTOMATIC_ROUNDS, TASK_PACKAGE_HASH, assertFastScope, classifyLane } from "./contracts.mjs";
import { evidenceManifest, redactEvidence } from "./redaction.mjs";

const pendingStates = new Set([...MAIN_STATES, ...ARCHITECTURE_STATES].filter((state) => !["PILOT_DEPLOYED", "OBSERVING_IN_USE", "ARCHITECTURE_ADOPTED"].includes(state)));
const MAX_MEDIA_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;

export class ReviewBusService {
  constructor(store, options = {}) {
    this.store = store;
    this.baseCommit = options.baseCommit ?? "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a";
    this.taskPackageContentHash = options.taskPackageContentHash ?? TASK_PACKAGE_HASH;
    if (this.taskPackageContentHash !== TASK_PACKAGE_HASH) throw problem("TASK_PACKAGE_HASH_MISMATCH");
  }

  createIssue(report, actor = "user", now = new Date(), { submissionId = null, baseCommit = null } = {}) {
    requireFields(report, ["project_id", "what_happened", "expected_result", "location", "blocks_work"]);
    if (submissionId !== null && !/^FILMOS-SUBMISSION-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submissionId)) throw problem("INVALID_SUBMISSION_ID");
    const lane = report.lane ?? classifyLane(report.risk ?? {});
    if (!["fast", "core", "architecture"].includes(lane)) throw problem("INVALID_LANE");
    const submissionSuffix = submissionId?.replace(/^FILMOS-SUBMISSION-/, "") ?? null;
    const issueId = submissionSuffix
      ? `${lane === "architecture" ? "FILMOS-ARCH" : "FILMOS-ISSUE"}-${submissionSuffix}`
      : (report.issue_id ?? `${lane === "architecture" ? "FILMOS-ARCH" : "FILMOS-ISSUE"}-${randomUUID()}`);
    const expectedPattern = lane === "architecture" ? /^FILMOS-ARCH-[A-Za-z0-9-]{1,120}$/ : /^FILMOS-ISSUE-[A-Za-z0-9-]{1,120}$/;
    if (!expectedPattern.test(issueId)) throw problem("INVALID_ISSUE_ID");
    if (this.store.get(issueId)) throw problem("ISSUE_ALREADY_EXISTS");
    const initialState = lane === "architecture" ? "REQUIREMENT_OBSERVED" : "OBSERVED_IN_USE";
    return this.store.append({
      issueId, projectId: report.project_id, lane, eventType: "issue.observed", actor,
      payload: { report }, now,
      mutate: () => ({
        schema_version: "filmos.review-session.v1", issue_id: issueId, submission_id: submissionId, project_id: report.project_id,
        lane, state: initialState, report, base_commit: baseCommit ?? this.baseCommit,
        constitution_version: CONSTITUTION_VERSION, constitution_content_hash: CONSTITUTION_HASH,
        build_lineage_task_package_hash: this.taskPackageContentHash, task_package_content_hash: null,
        issue_task_package: null, current_round: 1, assessment_round: 1,
        max_automatic_rounds: MAX_AUTOMATIC_ROUNDS, assessments: {}, findings: [], finding_responses: [],
        assessment_round_history: [], candidate_history: [], decision_history: [], stale_candidate_bindings: [],
        codex_coordination: { status: "IDLE", session_id: null, last_action: null, last_error_code: null },
        runtime_recovery: { observed_start_ids: [] },
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
        next.attachments = this.store.listAttachments(issueId);
        if (complete && next.lane === "fast") {
          const scope = fastAllowedChangeScope(next, items);
          if (scope.length > 0) {
            next.issue_task_package = issueTaskPackage(next, {
              allowedChangeScope: scope,
              explicitNonGoals: ["Film Core", "provider submission", "budget ledger", "authority changes"],
              implementationPlan: ["Apply the minimal bounded Fast Lane change."],
              acceptanceGates: ["Scoped regression test passes", "Fast Lane sensitive scope gate passes"],
              rollbackPlan: ["Revert the bounded candidate commit"],
            }, now);
            next.task_package_content_hash = next.issue_task_package.contentHash;
            next.state = "TASK_PACKAGE_FROZEN";
          } else next.state = "EVIDENCE_REQUIRED";
        } else next.state = complete ? (next.lane === "architecture" ? "ARCHITECTURE_EVIDENCE_FROZEN" : "EVIDENCE_FROZEN") : "EVIDENCE_REQUIRED";
        return next;
      },
    });
  }

  storeAttachment(issueId, input, actor = "user", now = new Date()) {
    const current = this.requireIssue(issueId);
    exactObject(input, ["attachment_id", "media_type", "original_name", "base64", "captured_at"]);
    requireFields(input, ["attachment_id", "media_type", "original_name", "base64"]);
    if (!/^attachment-[A-Za-z0-9-]{1,120}$/.test(input.attachment_id)) throw problem("INVALID_ATTACHMENT_ID");
    if (typeof input.media_type !== "string" || !(/^(image|video)\/[A-Za-z0-9.+-]{1,80}$/.test(input.media_type)
      || ["text/plain", "application/json"].includes(input.media_type))) throw problem("INVALID_ATTACHMENT_MEDIA_TYPE");
    if (typeof input.original_name !== "string" || !input.original_name.trim() || input.original_name.length > 255) throw problem("INVALID_ATTACHMENT_NAME");
    if (typeof input.base64 !== "string" || input.base64.length === 0 || input.base64.length > 35_000_000) throw problem("INVALID_ATTACHMENT_BYTES");
    const bytes = Buffer.from(input.base64, "base64");
    const maxBytes = input.media_type === "text/plain" ? MAX_TEXT_ATTACHMENT_BYTES : MAX_MEDIA_ATTACHMENT_BYTES;
    if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64").replace(/=+$/, "") !== input.base64.replace(/=+$/, "")) throw problem("INVALID_ATTACHMENT_BYTES");
    if (input.media_type === "text/plain") {
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw problem("INVALID_ATTACHMENT_BYTES"); }
    }
    const capturedAt = input.captured_at ? new Date(input.captured_at) : now;
    if (!Number.isFinite(capturedAt.getTime())) throw problem("INVALID_ATTACHMENT_CAPTURE_TIME");
    const redactedAlias = `evidence://${issueId}/${input.attachment_id}`;
    const metadata = this.store.storeAttachment({
      issueId,
      attachmentId: input.attachment_id,
      mediaType: input.media_type,
      originalName: input.original_name.trim(),
      redactedAlias,
      bytes,
      capturedAt,
    });
    const existingItems = current.evidence?.local_items ?? [];
    const withoutCurrent = existingItems.filter((item) => item.content?.attachment_id !== input.attachment_id);
    const item = {
      evidence_id: `evidence-${input.attachment_id}`,
      kind: input.media_type.startsWith("image/") ? "screenshot" : "attachment",
      completeness_kind: input.media_type.startsWith("image/") ? "screenshot" : "attachment",
      local_only: true,
      redacted_alias: redactedAlias,
      captured_at: capturedAt.toISOString(),
      content: {
        attachment_id: metadata.attachment_id,
        sha256: metadata.sha256,
        media_type: metadata.media_type,
        size_bytes: metadata.size_bytes,
        redacted_alias: metadata.redacted_alias,
      },
    };
    if (!current.issue_task_package) {
      const frozen = this.freezeEvidence(issueId, { source_commit: current.evidence?.manifest?.sourceCommit ?? current.base_commit, items: [...withoutCurrent, item] }, actor, now);
      return { issue: frozen, attachment: safeAttachmentMetadata(metadata) };
    }

    const existingFrozenItem = existingItems.find((entry) => entry.content?.attachment_id === input.attachment_id);
    if (existingFrozenItem) return { issue: current, attachment: safeAttachmentMetadata(metadata) };
    const existingSupplement = current.evidence?.supplemental_items?.find((entry) => entry.evidence_id === item.evidence_id);
    if (existingSupplement) return { issue: current, attachment: safeAttachmentMetadata(metadata) };
    const supplementBase = {
      ...item,
      authority_binding: supplementalAuthorityBinding(current),
      authority_effect: "NO_AUTOMATIC_AUTHORITY_CHANGE",
    };
    const supplement = { ...supplementBase, content_hash: sha256(supplementBase) };
    const appended = this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "evidence.supplemented", actor,
      payload: { supplemental_evidence: supplement }, now,
      mutate: (next) => {
        next.evidence.supplemental_items ??= [];
        next.evidence.supplemental_items.push(supplement);
        next.attachments = this.store.listAttachments(issueId);
        return next;
      },
    });
    return { issue: appended, attachment: safeAttachmentMetadata(metadata) };
  }

  readLocalAttachment(issueId, attachmentId, projectId) {
    this.requireScoped(issueId, projectId);
    const value = this.store.readAttachment(issueId, attachmentId);
    if (!value) throw problem("ATTACHMENT_NOT_FOUND", "ATTACHMENT_NOT_FOUND", 404);
    return value;
  }

  submitAssessment(issueId, actor, assessment, now = new Date()) {
    if (!['codex', 'chatgpt'].includes(actor)) throw problem("INVALID_ASSESSOR");
    const current = this.requireIssue(issueId);
    if (!current.evidence?.manifest || current.state === "EVIDENCE_REQUIRED") throw problem("EVIDENCE_REQUIRED");
    if (current.assessments[actor]) throw problem("ASSESSMENT_IMMUTABLE");
    requireFields(assessment, actor === "codex"
      ? ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"]
      : ["product_goal_fit", "root_cause_explains_symptom", "authority_risk", "resolution_layer", "workflow_impact", "acceptance_gates", "scope_drift"]);
    const binding = assessmentRoundBinding(current);
    const sealed = {
      ...assessment,
      assessor: actor,
      assessment_round: current.assessment_round ?? 1,
      project_id: current.project_id,
      evidence_manifest_hash: binding.evidence_manifest_hash,
      constitution_content_hash: binding.constitution_content_hash,
      submitted_at: now.toISOString(),
      content_hash: sha256({ assessment, binding, assessment_round: current.assessment_round ?? 1 }),
      sealed_until_pair_complete: true,
    };
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: `assessment.${actor}.submitted`, actor,
      payload: { content_hash: sealed.content_hash }, now,
      mutate: (next) => {
        next.assessments[actor] = sealed;
        const paired = Boolean(next.assessments.codex && next.assessments.chatgpt);
        next.state = paired ? "CONSENSUS_PROPOSED" : actor === "codex"
          ? (next.lane === "architecture" ? "CHATGPT_ARCHITECTURE_ASSESSMENT" : "CHATGPT_ASSESSING")
          : (next.lane === "architecture" ? "CODEX_ARCHITECTURE_ASSESSMENT" : "CODEX_ASSESSING");
        if (paired) {
          next.consensus_delta = consensusDelta(next.assessments.codex, next.assessments.chatgpt);
          next.consensus_proposal = consensusProposal(next, now);
          next.consensus_responses = [];
        }
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

  respondConsensus(issueId, actor, response, now = new Date()) {
    const current = this.requireIssue(issueId);
    if (!["codex", "chatgpt"].includes(actor)) throw problem("INVALID_CONSENSUS_ACTOR");
    if (!current.consensus_proposal) throw problem("CONSENSUS_PROPOSAL_REQUIRED");
    exactObject(response, ["proposal_content_hash", "position", "requested_changes"]);
    if (response.proposal_content_hash !== current.consensus_proposal.contentHash) throw problem("CONSENSUS_PROPOSAL_HASH_MISMATCH");
    if (!["ACCEPTED", "CHANGES_REQUESTED"].includes(response.position)) throw problem("INVALID_CONSENSUS_POSITION");
    if (!Array.isArray(response.requested_changes) || response.requested_changes.some((item) => typeof item !== "string" || !item.trim())) throw problem("INVALID_CONSENSUS_CHANGES");
    if (response.position === "CHANGES_REQUESTED" && response.requested_changes.length === 0) throw problem("CONSENSUS_CHANGES_REQUIRED");
    if (current.consensus_responses?.some((item) => item.actor === actor && item.proposal_content_hash === response.proposal_content_hash)) throw problem("CONSENSUS_RESPONSE_IMMUTABLE");
    const value = { ...response, actor, submitted_at: now.toISOString(), content_hash: sha256({ ...response, actor }) };
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "consensus.responded", actor,
      payload: value, now,
      mutate: (next) => {
        next.consensus_responses ??= [];
        next.consensus_responses.push(value);
        const key = actor === "codex" ? "codexPosition" : "chatgptPosition";
        next.consensus_proposal[key] = response.position;
        if (response.position === "CHANGES_REQUESTED") {
          next.state = "CONSENSUS_REVIEW";
          return next;
        }
        if (next.consensus_proposal.codexPosition === "ACCEPTED" && next.consensus_proposal.chatgptPosition === "ACCEPTED") {
          next.consensus_record = consensusRecord(next, now);
          next.issue_task_package = issueTaskPackage(next, next.consensus_record, now);
          next.task_package_content_hash = next.issue_task_package.contentHash;
          next.state = "TASK_PACKAGE_FROZEN";
        } else next.state = "CONSENSUS_PROPOSED";
        return next;
      },
    });
  }

  startNextAssessmentRound(issueId, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.state !== "CONSENSUS_REVIEW" || !current.consensus_proposal) throw problem("CONSENSUS_REVIEW_REQUIRED");
    if (current.consensus_record || current.issue_task_package || current.active_candidate) throw problem("CONSENSUS_ROUND_ALREADY_FROZEN");
    const responses = current.consensus_responses ?? [];
    const actors = new Set(responses.map((item) => item.actor));
    if (!actors.has("codex") || !actors.has("chatgpt")) throw problem("DUAL_CONSENSUS_RESPONSE_REQUIRED");
    if (!responses.some((item) => item.position === "CHANGES_REQUESTED")) throw problem("CONSENSUS_CHANGES_REQUIRED");
    const previousRound = current.assessment_round ?? 1;
    const archivedBase = {
      assessment_round: previousRound,
      assessments: current.assessments,
      consensus_delta: current.consensus_delta ?? null,
      consensus_proposal: current.consensus_proposal,
      consensus_responses: responses,
      ended_at: now.toISOString(),
      reason: "CONSENSUS_CHANGES_REQUESTED",
    };
    const archived = { ...archivedBase, content_hash: sha256(archivedBase) };
    const nextRound = previousRound + 1;
    return this.store.append({
      issueId, projectId: current.project_id, lane: current.lane, eventType: "assessment.round.advanced", actor,
      payload: { previous_round: previousRound, next_round: nextRound, archived_content_hash: archived.content_hash }, now,
      mutate: (next) => {
        next.assessment_round_history ??= [];
        next.assessment_round_history.push(archived);
        next.assessment_round = nextRound;
        next.assessments = {};
        next.consensus_delta = null;
        next.consensus_proposal = null;
        next.consensus_responses = [];
        next.consensus_record = null;
        next.issue_task_package = null;
        next.task_package_content_hash = null;
        next.state = next.lane === "architecture" ? "ARCHITECTURE_EVIDENCE_FROZEN" : "EVIDENCE_FROZEN";
        return next;
      },
    });
  }

  setConsensus() { throw problem("CONSENSUS_DUAL_RESPONSE_REQUIRED"); }

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

  acceptArchitectureOption(issueId, input, actor = "user", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (current.lane !== "architecture" || !current.architecture_options) throw problem("ARCHITECTURE_OPTIONS_REQUIRED");
    exactObject(input, ["option", "user_authorized"]);
    if (input.user_authorized !== true) throw problem("OWNER_AUTHORIZATION_REQUIRED");
    const selected = current.architecture_options.find((item) => item.option === input.option);
    if (!selected) throw problem("ARCHITECTURE_OPTION_NOT_FOUND");
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "architecture.option.accepted", actor, payload: input, now,
      mutate: (next) => { next.accepted_architecture_option = selected; next.state = "ARCHITECTURE_CHANGE_APPROVED"; return next; } });
  }

  submitCandidate(issueId, candidate, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "codex") throw problem("CANDIDATE_SUBMITTER_MUST_BE_CODEX");
    if (current.active_candidate) throw problem("ACTIVE_CANDIDATE_IMMUTABLE");
    requireFields(candidate, ["candidate_id", "base_commit", "candidate_commit", "tree", "branch", "github_run", "artifact_id", "artifact_digest", "artifact_commit", "evidence_index_hash", "github_remote_verification", "task_package_content_hash", "constitution_content_hash", "candidate_nonce", "changed_files", "known_limitations"]);
    if (candidate.base_commit !== current.base_commit) throw problem("CANDIDATE_BASE_MISMATCH");
    if (current.lane !== "fast" && !current.consensus_record) throw problem("IMPLEMENTATION_BLOCKED_NO_CONSENSUS");
    if (current.lane !== "fast" && candidate.consensus_record_hash !== current.consensus_record.contentHash) throw problem("CONSENSUS_RECORD_HASH_MISMATCH");
    validateCandidateBinding(candidate, current);
    if (current.lane === "fast") assertFastScope(candidate.changed_files, candidate.patch_summary ?? "");
    if (current.lane === "architecture" && (!current.requirement_delta || !current.architecture_options)) throw problem("ARCHITECTURE_CONSENSUS_PREREQUISITES_MISSING");
    const base = { ...candidate, issue_id: issueId, round: current.current_round, constitution_version: CONSTITUTION_VERSION, constitution_content_hash: CONSTITUTION_HASH, task_package_content_hash: current.task_package_content_hash, submitted_at: now.toISOString() };
    const activeCandidate = { ...base, content_hash: sha256(base) };
    const eventType = current.current_round > 1 ? "candidate.resubmitted" : "candidate.submitted";
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType, actor, payload: { candidate: activeCandidate, round: current.current_round }, now,
      mutate: (next) => {
        next.candidate_history ??= [];
        const previous = [...next.candidate_history].reverse().find((entry) => entry.status === "SUPERSEDED" && !entry.supersededByCandidateId);
        if (previous) {
          previous.supersededByCandidateId = activeCandidate.candidate_id;
          previous.contentHash = candidateHistoryHash(previous);
        }
        next.candidate_history.push(candidateHistoryEntry(activeCandidate, "ACTIVE"));
        next.active_candidate = activeCandidate;
        next.state = "WAITING_FOR_CHATGPT_REVIEW";
        return next;
      } });
  }

  addFinding(issueId, finding, actor = "chatgpt", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "chatgpt") throw problem("EXTERNAL_FINDING_ACTOR_REQUIRED");
    validateStrictFinding(finding, current);
    if (current.findings.some((item) => item.finding_id === finding.finding_id)) throw problem("FINDING_ALREADY_EXISTS");
    const status = finding.late_finding_classification === "SCOPE_EXPANSION" ? "OWNER_DECISION_REQUIRED" : (finding.status ?? "OPEN");
    const value = { ...finding, summary: finding.summary ?? finding.title, status, round: current.current_round, created_at: now.toISOString() };
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "finding.added", actor, payload: value, now,
      mutate: (next) => { next.findings.push(value); if (value.status === "OWNER_DECISION_REQUIRED") next.state = "OWNER_DECISION_REQUIRED"; return next; } });
  }

  submitChatGPTReviewDecision(issueId, envelope, actor = "chatgpt", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "chatgpt") throw problem("EXTERNAL_REVIEW_DECISION_ACTOR_REQUIRED");
    exactObject(envelope, ["purpose", "issue_id", "candidate_id", "candidate_commit", "verdict", "summary", "findings", "closed_finding_ids", "reopened_finding_ids", "accepted_limitations", "scope_assessment", "confidence"]);
    requireFields(envelope, ["purpose", "issue_id", "candidate_id", "candidate_commit", "verdict", "summary", "findings", "closed_finding_ids", "reopened_finding_ids", "accepted_limitations", "scope_assessment", "confidence"]);
    if (envelope.purpose !== "CHATGPT_REVIEW_DECISION" || envelope.issue_id !== issueId) throw problem("INVALID_CHATGPT_REVIEW_DECISION");
    if (typeof envelope.summary !== "string" || !envelope.summary.trim()) throw problem("INVALID_REVIEW_DECISION_SUMMARY");
    assertCurrentCandidateIdentity(current, envelope);
    if (!["EXTERNAL_APPROVED", "CHANGES_REQUIRED", "EVIDENCE_REQUIRED", "OWNER_DECISION_REQUIRED"].includes(envelope.verdict)) throw problem("INVALID_VERDICT");
    if (!["high", "medium", "low"].includes(envelope.confidence)) throw problem("INVALID_CONFIDENCE");
    if (!Array.isArray(envelope.findings) || !Array.isArray(envelope.closed_finding_ids) || !Array.isArray(envelope.reopened_finding_ids) || !Array.isArray(envelope.accepted_limitations)) throw problem("INVALID_CHATGPT_REVIEW_DECISION");
    requireFields(envelope.scope_assessment, ["task_package_hash_matches", "constitution_hash_matches", "out_of_scope_changes"]);
    exactObject(envelope.scope_assessment, ["task_package_hash_matches", "constitution_hash_matches", "out_of_scope_changes"]);
    if (typeof envelope.scope_assessment.task_package_hash_matches !== "boolean"
      || typeof envelope.scope_assessment.constitution_hash_matches !== "boolean"
      || !Array.isArray(envelope.scope_assessment.out_of_scope_changes)
      || envelope.scope_assessment.out_of_scope_changes.some((item) => typeof item !== "string" || !item.trim())) throw problem("INVALID_SCOPE_ASSESSMENT");
    const knownFindingIds = new Set(current.findings.map((item) => item.finding_id));
    const newFindingIds = new Set();
    const findings = envelope.findings.map((finding) => {
      validateStrictFinding(finding, current);
      if (knownFindingIds.has(finding.finding_id) || newFindingIds.has(finding.finding_id)) throw problem("FINDING_ALREADY_EXISTS");
      newFindingIds.add(finding.finding_id);
      const status = finding.late_finding_classification === "SCOPE_EXPANSION" ? "OWNER_DECISION_REQUIRED" : "OPEN";
      return { ...finding, summary: finding.summary ?? finding.title, status, round: current.current_round, created_at: now.toISOString() };
    });
    const closed = uniqueFindingIds(envelope.closed_finding_ids, knownFindingIds, "CLOSED_FINDING_NOT_FOUND");
    const reopened = uniqueFindingIds(envelope.reopened_finding_ids, knownFindingIds, "REOPENED_FINDING_NOT_FOUND");
    if (closed.some((findingId) => reopened.includes(findingId))) throw problem("FINDING_CLOSE_REOPEN_CONFLICT");
    const limitations = envelope.accepted_limitations.map((entry) => {
      requireFields(entry, ["finding_id", "reason"]);
      if (!knownFindingIds.has(entry.finding_id) || typeof entry.reason !== "string" || !entry.reason.trim()) throw problem("INVALID_ACCEPTED_LIMITATION");
      return { finding_id: entry.finding_id, reason: entry.reason.trim() };
    });
    const scopeExpansion = envelope.scope_assessment.task_package_hash_matches !== true
      || envelope.scope_assessment.constitution_hash_matches !== true
      || envelope.scope_assessment.out_of_scope_changes.length > 0
      || findings.some((finding) => finding.late_finding_classification === "SCOPE_EXPANSION");
    const projectedFindings = structuredClone(current.findings);
    for (const finding of projectedFindings) {
      if (closed.includes(finding.finding_id)) finding.status = "CLOSED";
      if (reopened.includes(finding.finding_id)) finding.status = "OPEN";
      const limitation = limitations.find((entry) => entry.finding_id === finding.finding_id);
      if (limitation) { finding.accepted_limitation = true; finding.accepted_limitation_reason = limitation.reason; }
    }
    projectedFindings.push(...findings);
    if (envelope.verdict === "EXTERNAL_APPROVED" && blockingFindings(projectedFindings).length > 0) throw problem("EXTERNAL_APPROVAL_BLOCKED_BY_FINDINGS");
    if (envelope.verdict === "CHANGES_REQUIRED" && blockingFindings(projectedFindings).length === 0) throw problem("CHANGES_REQUIRED_NEEDS_ACTIONABLE_FINDING");
    const decisionBase = { ...envelope, round: current.current_round, candidate_binding: candidateBinding(current.active_candidate), submitted_at: now.toISOString() };
    const decision = { ...decisionBase, content_hash: sha256(decisionBase) };
    if (current.decision_history?.some((item) => item.content_hash === decision.content_hash)) throw problem("REVIEW_DECISION_ALREADY_EXISTS");
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "chatgpt.review_decision", actor, payload: { decision }, now,
      mutate: (next) => {
        next.findings = projectedFindings;
        next.decision_history ??= [];
        next.decision_history.push(decision);
        next.verdicts.chatgpt = envelope.verdict;
        next.verdict_bindings ??= {};
        next.verdict_bindings.chatgpt = candidateBinding(next.active_candidate);
        next.next_pilot_allowed = false;
        if (scopeExpansion || envelope.verdict === "OWNER_DECISION_REQUIRED") next.state = "OWNER_DECISION_REQUIRED";
        else if (envelope.verdict === "CHANGES_REQUIRED") next.state = "CHANGES_REQUIRED";
        else if (envelope.verdict === "EVIDENCE_REQUIRED") next.state = "EVIDENCE_REQUIRED";
        else next.state = "EXTERNAL_APPROVED";
        return next;
      },
    });
  }

  respondFinding(issueId, response, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (actor !== "codex") throw problem("CODEX_RESPONSE_ACTOR_REQUIRED");
    requireFields(response, ["finding_id", "disposition", "evidence"]);
    if (!current.findings.some((item) => item.finding_id === response.finding_id)) throw problem("FINDING_NOT_FOUND", "FINDING_NOT_FOUND", 404);
    if (!Array.isArray(response.evidence) || response.evidence.length === 0) throw problem("FINDING_RESPONSE_EVIDENCE_REQUIRED");
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
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "finding.external_decision", actor, payload: { finding_id: findingId, decision }, now,
      mutate: (next) => { const item = next.findings.find((entry) => entry.finding_id === findingId); item.status = decision === "DISPUTE_ACCEPTED" ? "CLOSED" : decision; return next; } });
  }

  recordVerdict(issueId, actor, input, now = new Date()) {
    const current = this.requireIssue(issueId);
    const verdict = typeof input === "string" ? input : input?.verdict;
    const allowed = actor === "codex" ? ["LOCAL_ACCEPTED", "CHANGES_REQUIRED"] : actor === "chatgpt" ? ["EXTERNAL_APPROVED", "CHANGES_REQUIRED"] : actor === "machine" ? ["PASS", "FAIL"] : [];
    if (!allowed.includes(verdict)) throw problem(actor === "codex" && verdict === "EXTERNAL_APPROVED" ? "REVIEW_CODEX_CANNOT_SELF_APPROVE" : "INVALID_VERDICT");
    if (actor === "machine" && verdict === "PASS" && current.active_candidate?.github_remote_verification?.status !== "VERIFIED") {
      throw problem("GITHUB_REMOTE_VERIFICATION_REQUIRED");
    }
    const binding = typeof input === "object" ? input.binding : null;
    assertCurrentCandidateBinding(current, binding);
    const projected = structuredClone(current);
    projected.verdicts[actor] = verdict;
    projected.verdict_bindings ??= {};
    projected.verdict_bindings[actor] = binding;
    const eventType = pilotAllowed(projected) ? "candidate.approved" : `verdict.${actor}`;
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType, actor, payload: { verdict }, now,
      mutate: (next) => {
        next.verdicts[actor] = verdict;
        next.verdict_bindings ??= {};
        next.verdict_bindings[actor] = binding;
        if (actor === "codex" && verdict === "LOCAL_ACCEPTED") next.state = "CODEX_LOCAL_ACCEPTED";
        if ((actor === "codex" || actor === "chatgpt") && verdict === "CHANGES_REQUIRED") next.state = "CHANGES_REQUIRED";
        if (actor === "chatgpt" && verdict === "EXTERNAL_APPROVED") next.state = "EXTERNAL_APPROVED";
        if (actor === "machine" && verdict === "PASS") next.state = "MACHINE_PASS";
        if (actor === "machine" && verdict === "FAIL") next.state = "CHANGES_REQUIRED";
        next.next_pilot_allowed = pilotAllowed(next);
        if (next.next_pilot_allowed) {
          next.state = "DUAL_APPROVED";
          next.dual_signoff = dualSignoff(next, now);
          markActiveCandidateHistory(next, "APPROVED");
        }
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

  startNextRound(issueId, actor = "codex", now = new Date()) {
    const current = this.requireIssue(issueId);
    if (!current.active_candidate) throw problem("ACTIVE_CANDIDATE_REQUIRED");
    if (current.verdicts.chatgpt !== "CHANGES_REQUIRED") throw problem("CHANGES_REQUIRED_VERDICT_REQUIRED");
    const openFindings = current.findings.filter((item) => item.status !== "CLOSED" && item.accepted_limitation !== true);
    if (openFindings.length === 0) throw problem("OPEN_FINDING_REQUIRED");
    if (openFindings.some((item) => item.status === "OWNER_DECISION_REQUIRED")) throw problem("OWNER_DECISION_REQUIRED");
    const responded = new Set(current.finding_responses.map((item) => item.finding_id));
    if (openFindings.some((item) => !responded.has(item.finding_id))) throw problem("CODEX_FINDING_RESPONSE_REQUIRED");
    const nextRound = current.current_round + 1;
    const p0 = current.findings.filter((item) => item.severity === "P0" && item.status !== "CLOSED").length;
    const superseded = current.active_candidate;
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "candidate.supersede", actor,
      payload: { round: nextRound, superseded_candidate_id: superseded.candidate_id, superseded_candidate_commit: superseded.candidate_commit },
      revokeCandidate: { candidate_id: superseded.candidate_id, candidate_commit: superseded.candidate_commit }, now,
      mutate: (next) => {
        markActiveCandidateHistory(next, "SUPERSEDED", { supersededAt: now.toISOString() });
        next.stale_candidate_bindings ??= [];
        next.stale_candidate_bindings.push({ ...candidateBinding(superseded), stale_at: now.toISOString(), stale_reason: "NEXT_REVIEW_ROUND" });
        next.active_candidate = null;
        next.verdicts = { codex: null, chatgpt: null, machine: null };
        next.verdict_bindings = {};
        next.dual_signoff = null;
        next.next_pilot_allowed = false;
        next.current_round = nextRound;
        next.state = nextRound > next.max_automatic_rounds && p0 > 0 ? "OWNER_DECISION_REQUIRED" : "CODEX_FIXING";
        return next;
      } });
  }

  nextRound(issueId, actor = "codex", now = new Date()) { return this.startNextRound(issueId, actor, now); }

  recordCodexCoordination(issueId, input, actor = "review-codex-coordinator", now = new Date()) {
    const current = this.requireIssue(issueId);
    exactObject(input, ["status", "session_id", "last_action", "last_error_code"]);
    if (!["IDLE", "RUNNING", "WAITING_EXTERNAL", "STOPPED_OWNER_GATE", "COMPLETED", "FAILED"].includes(input.status)) throw problem("INVALID_CODEX_COORDINATION_STATUS");
    for (const field of ["session_id", "last_action", "last_error_code"]) if (input[field] !== null && typeof input[field] !== "string") throw problem("INVALID_CODEX_COORDINATION_RECORD");
    const value = { ...input, updated_at: now.toISOString() };
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "codex.coordination", actor, payload: value, now,
      mutate: (next) => { next.codex_coordination = value; return next; } });
  }

  recordRuntimeObservation(issueId, runtimeInstanceId, now = new Date()) {
    const current = this.requireIssue(issueId);
    if (typeof runtimeInstanceId !== "string" || runtimeInstanceId.length < 16) throw problem("INVALID_RUNTIME_INSTANCE_ID");
    if (current.runtime_recovery?.observed_start_ids?.includes(runtimeInstanceId)) return current;
    return this.store.append({ issueId, projectId: current.project_id, lane: current.lane, eventType: "runtime.observed", actor: "filmos-review-bus", payload: { runtime_instance_id: runtimeInstanceId }, now,
      mutate: (next) => {
        next.runtime_recovery ??= { observed_start_ids: [] };
        next.runtime_recovery.observed_start_ids.push(runtimeInstanceId);
        return next;
      } });
  }

  pending(projectId) { return this.store.list({ projectId }).filter((item) => pendingStates.has(item.state)).map(readSummary); }
  pendingAll() { return this.store.list().filter((item) => pendingStates.has(item.state)).map(readSummary); }
  listRedactedAdmin() { return this.store.list().map((item) => redactedProjection(item)); }
  readRedactedAdmin(issueId) {
    return { ...redactedProjection(this.requireIssue(issueId)), event_chain_verified: this.store.verifyEventChain(issueId) };
  }
  readRedacted(issueId, projectId) { const value = this.requireScoped(issueId, projectId); return redactedProjection(value); }
  readLocalFull(issueId, projectId) { return structuredClone(this.requireScoped(issueId, projectId)); }
  requireIssue(issueId) { const value = this.store.get(issueId); if (!value) throw problem("ISSUE_NOT_FOUND", "ISSUE_NOT_FOUND", 404); return value; }
  requireScoped(issueId, projectId) { const value = this.requireIssue(issueId); if (value.project_id !== projectId) throw problem("PROJECT_SCOPE_DENIED", "PROJECT_SCOPE_DENIED", 403); return value; }
}

function consensusDelta(codex, chatgpt) {
  const agreements = [], disagreements = [];
  const evidenceDifferences = uniqueStrings([
    ...(Array.isArray(codex.evidence_gaps) ? codex.evidence_gaps : []),
    ...(Array.isArray(chatgpt.evidence_gaps) ? chatgpt.evidence_gaps : []),
  ]);
  if (String(codex.root_cause).toLowerCase() === String(chatgpt.root_cause ?? "").toLowerCase()) agreements.push("root_cause"); else disagreements.push("root_cause");
  if (chatgpt.root_cause_explains_symptom === true) agreements.push("symptom_explanation"); else disagreements.push("symptom_explanation");
  if (evidenceDifferences.length === 0 && (codex.needs_more_evidence || chatgpt.needs_more_evidence)) evidenceDifferences.push("additional_evidence_requested");
  const base = { agreements, disagreements, evidence_differences: evidenceDifferences, scope_conflict: chatgpt.scope_drift === true };
  return { ...base, content_hash: sha256(base) };
}

function consensusProposal(value, now) {
  const codex = value.assessments.codex;
  const chatgpt = value.assessments.chatgpt;
  const delta = value.consensus_delta;
  const base = {
    proposalId: `consensus-proposal-${randomUUID()}`,
    issueId: value.issue_id,
    assessmentRound: value.assessment_round ?? 1,
    projectId: value.project_id,
    evidenceManifestHash: value.evidence?.manifest?.contentHash ?? value.evidence?.manifest?.content_hash ?? null,
    constitutionContentHash: value.constitution_content_hash,
    agreements: delta.agreements,
    disagreements: delta.disagreements,
    evidenceGaps: delta.evidence_differences,
    proposedRootCause: String(codex.root_cause),
    proposedResolutionLayer: String(chatgpt.resolution_layer),
    proposedAllowedChangeScope: uniqueStrings(codex.files),
    proposedNonGoals: uniqueStrings(chatgpt.explicit_non_goals ?? []),
    proposedImplementationPlan: uniqueStrings(codex.minimal_change),
    proposedAcceptanceGates: uniqueStrings([...(chatgpt.acceptance_gates ?? []), ...(codex.tests ?? [])]),
    proposedRollbackPlan: uniqueStrings(codex.rollback),
    createdAt: now.toISOString(),
  };
  return { ...base, codexPosition: "PENDING", chatgptPosition: "PENDING", contentHash: sha256(base) };
}

function assessmentRoundBinding(value) {
  return {
    project_id: value.project_id,
    evidence_manifest_hash: value.evidence?.manifest?.contentHash ?? value.evidence?.manifest?.content_hash ?? null,
    constitution_content_hash: value.constitution_content_hash,
  };
}

function consensusRecord(value, now) {
  const proposal = value.consensus_proposal;
  const base = {
    consensusRecordId: `consensus-record-${randomUUID()}`,
    proposalId: proposal.proposalId,
    issueId: value.issue_id,
    rootCause: proposal.proposedRootCause,
    resolutionLayer: proposal.proposedResolutionLayer,
    allowedChangeScope: proposal.proposedAllowedChangeScope,
    explicitNonGoals: proposal.proposedNonGoals,
    implementationPlan: proposal.proposedImplementationPlan,
    acceptanceGates: proposal.proposedAcceptanceGates,
    rollbackPlan: proposal.proposedRollbackPlan,
    codexAccepted: true,
    chatgptAccepted: true,
    constitutionVersion: CONSTITUTION_VERSION,
    constitutionContentHash: CONSTITUTION_HASH,
    createdAt: now.toISOString(),
  };
  return { ...base, contentHash: sha256(base) };
}

function issueTaskPackage(value, source, now) {
  const base = {
    taskPackageId: `issue-task-package-${randomUUID()}`,
    issueId: value.issue_id,
    evidenceManifestHash: value.evidence?.manifest?.contentHash ?? value.evidence?.manifest?.content_hash ?? null,
    consensusRecordHash: value.lane === "fast" ? null : source.contentHash,
    constitutionHash: CONSTITUTION_HASH,
    buildLineageTaskPackageHash: value.build_lineage_task_package_hash,
    baseCommit: value.base_commit,
    allowedChangeScope: uniqueStrings(source.allowedChangeScope),
    explicitNonGoals: uniqueStrings(source.explicitNonGoals),
    implementationPlan: uniqueStrings(source.implementationPlan),
    acceptanceGates: uniqueStrings(source.acceptanceGates),
    rollbackPlan: uniqueStrings(source.rollbackPlan),
    createdAt: now.toISOString(),
  };
  return { ...base, contentHash: sha256(base) };
}

function fastAllowedChangeScope(value, items) {
  const reported = Array.isArray(value.report.allowed_change_scope) ? value.report.allowed_change_scope : [];
  const observed = items.filter((item) => item.completeness_kind === "sourceMap")
    .flatMap((item) => [item.content?.file, ...(Array.isArray(item.content?.files) ? item.content.files : [])])
    .filter(Boolean);
  return uniqueStrings([...reported, ...observed]);
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function pilotAllowed(value) {
  if (!value.active_candidate) return false;
  const unresolved = value.findings.filter((item) => item.status !== "CLOSED");
  const blocking = unresolved.filter((item) => item.severity === "P0" || (item.severity === "P1" && item.accepted_limitation !== true));
  const currentBinding = candidateBinding(value.active_candidate);
  const verdictsBound = ["codex", "chatgpt", "machine"].every((actor) => value.verdict_bindings?.[actor] && sha256(value.verdict_bindings[actor]) === sha256(currentBinding));
  const externalBindings = value.active_candidate.github_run?.head_sha === value.active_candidate.candidate_commit
    && value.active_candidate.github_run?.conclusion === "success"
    && value.active_candidate.artifact_commit === value.active_candidate.candidate_commit
    && value.active_candidate.github_remote_verification?.status === "VERIFIED"
    && value.active_candidate.github_remote_verification?.candidate_commit === value.active_candidate.candidate_commit;
  return value.verdicts.codex === "LOCAL_ACCEPTED" && value.verdicts.chatgpt === "EXTERNAL_APPROVED" && value.verdicts.machine === "PASS" && blocking.length === 0 && verdictsBound && externalBindings && value.active_candidate.constitution_content_hash === CONSTITUTION_HASH && value.active_candidate.task_package_content_hash === value.task_package_content_hash;
}

function dualSignoff(value, now) {
  const base = { issue_id: value.issue_id, candidate_binding: candidateBinding(value.active_candidate), codex: "LOCAL_ACCEPTED", chatgpt: "EXTERNAL_APPROVED", machine: "PASS", constitution_content_hash: CONSTITUTION_HASH, task_package_content_hash: value.task_package_content_hash, signed_at: now.toISOString() };
  return { ...base, content_hash: sha256(base) };
}

function readSummary(value) {
  const coordinationKey = sha256({ state: value.state, assessment_round: value.assessment_round, current_round: value.current_round, evidence: value.evidence?.manifest?.contentHash ?? null, assessments: value.assessments, consensus: value.consensus_record?.contentHash ?? value.consensus_proposal?.contentHash ?? null, task_package: value.issue_task_package?.contentHash ?? null, candidate: value.active_candidate?.content_hash ?? null, findings: value.findings, responses: value.finding_responses, verdicts: value.verdicts });
  return { issue_id: value.issue_id, project_id: value.project_id, lane: value.lane, state: value.state, what_happened: value.report.what_happened, blocks_work: value.report.blocks_work, updated_at: value.updated_at, content_hash: value.content_hash, coordination_key: coordinationKey };
}
function redactedProjection(value) {
  const next = structuredClone(value);
  if (next.evidence) delete next.evidence.local_items;
  if (Array.isArray(next.attachments)) next.attachments = next.attachments.map(safeAttachmentMetadata);
  return redactEvidence(next);
}
function requireFields(value, fields) { for (const field of fields) if (!(field in (value ?? {}))) throw problem(`MISSING_${field.toUpperCase()}`); }

function validateStrictFinding(finding, current) {
  assertOnlyKeys(finding, ["finding_id", "severity", "category", "title", "problem", "evidence", "required_change", "acceptance_gate", "late_finding_classification", "reason_newly_discoverable", "summary", "status"]);
  requireFields(finding, ["finding_id", "severity", "category", "title", "problem", "evidence", "required_change", "acceptance_gate"]);
  if (!/^finding-[A-Za-z0-9-]{1,120}$/.test(finding.finding_id)) throw problem("INVALID_FINDING_ID");
  if (!["P0", "P1", "P2"].includes(finding.severity)) throw problem("INVALID_FINDING_SEVERITY");
  for (const field of ["category", "title", "problem", "required_change", "acceptance_gate"]) {
    if (typeof finding[field] !== "string" || !finding[field].trim()) throw problem(`INVALID_FINDING_${field.toUpperCase()}`);
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) throw problem("FINDING_EVIDENCE_REQUIRED");
  const sourceTypes = new Set(["github_file", "github_diff", "ci_log", "artifact", "filmos"]);
  for (const evidence of finding.evidence) {
    assertOnlyKeys(evidence, ["source_type", "locator", "line_start", "line_end", "content_hash", "note"]);
    requireFields(evidence, ["source_type", "locator"]);
    if (!sourceTypes.has(evidence.source_type) || typeof evidence.locator !== "string" || !evidence.locator.trim()) throw problem("INVALID_FINDING_EVIDENCE");
    if (evidence.line_start !== undefined && (!Number.isInteger(evidence.line_start) || evidence.line_start < 1)) throw problem("INVALID_FINDING_EVIDENCE_LINE");
    if (evidence.line_end !== undefined && (!Number.isInteger(evidence.line_end) || evidence.line_end < (evidence.line_start ?? 1))) throw problem("INVALID_FINDING_EVIDENCE_LINE");
    if (evidence.content_hash !== undefined && !/^[0-9a-f]{64}$/.test(evidence.content_hash)) throw problem("INVALID_FINDING_EVIDENCE_HASH");
  }
  if (current.current_round > 1) {
    if (!LATE_FINDING_TAXONOMY.includes(finding.late_finding_classification)) throw problem("LATE_FINDING_CLASSIFICATION_REQUIRED");
    if (typeof finding.reason_newly_discoverable !== "string" || !finding.reason_newly_discoverable.trim()) throw problem("LATE_FINDING_REASON_REQUIRED");
  }
}

function assertOnlyKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw problem("INVALID_BODY");
}

function uniqueFindingIds(values, knownIds, code) {
  const unique = [...new Set(values)];
  if (unique.length !== values.length || unique.some((findingId) => typeof findingId !== "string" || !knownIds.has(findingId))) throw problem(code);
  return unique;
}

function blockingFindings(findings) {
  return findings.filter((item) => item.status !== "CLOSED" && item.status !== "ACCEPTED_LIMITATION"
    && (item.severity === "P0" || (item.severity === "P1" && item.accepted_limitation !== true)));
}

function candidateHistoryEntry(candidate, status, extras = {}) {
  const base = { candidate, status, round: candidate.round, ...extras };
  return { ...base, contentHash: sha256(base) };
}

function candidateHistoryHash(entry) {
  const base = { ...entry };
  delete base.contentHash;
  return sha256(base);
}

function markActiveCandidateHistory(value, status, extras = {}) {
  value.candidate_history ??= [];
  const entry = [...value.candidate_history].reverse().find((item) => item.status === "ACTIVE" && item.candidate.candidate_id === value.active_candidate?.candidate_id);
  if (!entry) throw problem("ACTIVE_CANDIDATE_HISTORY_REQUIRED");
  entry.status = status;
  Object.assign(entry, extras);
  entry.contentHash = candidateHistoryHash(entry);
}

function validateCandidateBinding(candidate, current) {
  if (typeof candidate.candidate_id !== "string" || !candidate.candidate_id.trim()) throw problem("INVALID_CANDIDATE_ID");
  if (typeof candidate.branch !== "string" || !candidate.branch.trim()) throw problem("INVALID_CANDIDATE_BRANCH");
  if (!Array.isArray(candidate.changed_files) || !Array.isArray(candidate.known_limitations)) throw problem("INVALID_CANDIDATE_COLLECTION");
  if (!/^[0-9a-f]{40,64}$/.test(candidate.candidate_commit) || !/^[0-9a-f]{40,64}$/.test(candidate.tree)) throw problem("INVALID_CANDIDATE_GIT_BINDING");
  if (!candidate.github_run || !candidate.github_run.id || candidate.github_run.head_sha !== candidate.candidate_commit) throw problem("GITHUB_RUN_COMMIT_MISMATCH");
  if (!candidate.artifact_id || !/^sha256:[0-9a-f]{64}$/.test(candidate.artifact_digest) || candidate.artifact_commit !== candidate.candidate_commit) throw problem("ARTIFACT_COMMIT_MISMATCH");
  if (!/^[0-9a-f]{64}$/.test(candidate.evidence_index_hash)) throw problem("INVALID_EVIDENCE_INDEX_HASH");
  const remote = candidate.github_remote_verification;
  const remotePayload = remote ? { ...remote } : null;
  if (remotePayload) delete remotePayload.content_hash;
  if (!remote || remote.status !== "VERIFIED" || remote.candidate_commit !== candidate.candidate_commit || remote.candidate_tree !== candidate.tree
    || String(remote.github_run_id) !== String(candidate.github_run.id) || String(remote.artifact_id) !== String(candidate.artifact_id)
    || remote.artifact_digest !== candidate.artifact_digest || remote.evidence_index_hash !== candidate.evidence_index_hash
    || !remote.content_hash || sha256(remotePayload) !== remote.content_hash) throw problem("GITHUB_REMOTE_VERIFICATION_REQUIRED");
  if (!current.issue_task_package || !current.task_package_content_hash) throw problem("ISSUE_TASK_PACKAGE_REQUIRED");
  if (candidate.task_package_content_hash !== current.task_package_content_hash) throw problem("TASK_PACKAGE_HASH_MISMATCH");
  const allowedScope = current.issue_task_package.allowedChangeScope ?? [];
  if (candidate.changed_files.some((file) => !allowedScope.some((scope) => fileInScope(file, scope)))) throw problem("CANDIDATE_SCOPE_EXCEEDED");
  if (candidate.constitution_content_hash !== CONSTITUTION_HASH) throw problem("CONSTITUTION_HASH_MISMATCH");
  if (typeof candidate.candidate_nonce !== "string" || candidate.candidate_nonce.length < 16) throw problem("CANDIDATE_NONCE_REQUIRED");
}

export function fileInScope(file, descriptor) {
  const scope = descriptor.replace(/\s*（(?:当前|冻结基线中)不存在）\s*$/u, "");
  if (scope.endsWith("/**")) return file === scope.slice(0, -3) || file.startsWith(scope.slice(0, -2));
  if (scope.endsWith("/")) return file.startsWith(scope);
  return file === scope;
}

export function candidateBinding(candidate) {
  return { candidate_id: candidate.candidate_id, base_commit: candidate.base_commit, candidate_commit: candidate.candidate_commit, tree: candidate.tree, branch: candidate.branch, github_run: candidate.github_run, artifact_id: candidate.artifact_id, artifact_digest: candidate.artifact_digest, artifact_commit: candidate.artifact_commit, evidence_index_hash: candidate.evidence_index_hash, github_remote_verification: candidate.github_remote_verification, task_package_content_hash: candidate.task_package_content_hash, consensus_record_hash: candidate.consensus_record_hash ?? null, constitution_content_hash: candidate.constitution_content_hash, candidate_nonce: candidate.candidate_nonce, changed_files: candidate.changed_files, known_limitations: candidate.known_limitations, content_hash: candidate.content_hash };
}

function assertCurrentCandidateBinding(current, binding) {
  if (!current.active_candidate || !binding) throw problem("CURRENT_CANDIDATE_BINDING_REQUIRED");
  const expected = candidateBinding(current.active_candidate);
  if (sha256(binding) !== sha256(expected)) throw problem("CURRENT_CANDIDATE_BINDING_MISMATCH");
}

function assertCurrentCandidateIdentity(current, value) {
  if (!current.active_candidate) throw problem("CURRENT_CANDIDATE_BINDING_REQUIRED");
  if (current.active_candidate.candidate_id !== value.candidate_id || current.active_candidate.candidate_commit !== value.candidate_commit) throw problem("CURRENT_CANDIDATE_BINDING_MISMATCH");
}

function safeAttachmentMetadata(value) {
  return {
    attachment_id: value.attachment_id,
    media_type: value.media_type,
    size_bytes: value.size_bytes,
    sha256: value.sha256,
    redacted_alias: value.redacted_alias,
    captured_at: value.captured_at,
  };
}

function supplementalAuthorityBinding(value) {
  return {
    evidence_manifest_hash: value.evidence?.manifest?.contentHash ?? value.evidence?.manifest?.content_hash ?? null,
    task_package_content_hash: value.issue_task_package?.contentHash ?? null,
    candidate_binding_hash: value.active_candidate ? sha256(candidateBinding(value.active_candidate)) : null,
    candidate_history_hash: sha256(value.candidate_history ?? []),
    verdict_bindings_hash: sha256(value.verdict_bindings ?? {}),
    dual_signoff_hash: value.dual_signoff?.content_hash ?? null,
  };
}

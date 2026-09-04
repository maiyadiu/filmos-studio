import { randomUUID } from "node:crypto";

import { exactObject, problem, sha256 } from "./canonical.mjs";
import {
  ARCHITECTURE_PROTOCOL_VERSION,
} from "./architecture-protocol.mjs";
import { evidenceManifest, redactEvidence } from "./redaction.mjs";

export function isArchitectureV2(value) {
  return value?.lane === "architecture" && value.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION;
}

export function recordArchitectureIntakeEvidence({ store, current, input, actor, now }) {
  assertProtocol(current);
  if (current.state !== "REQUIREMENT_OBSERVED" || actor !== "system") throw problem("REQUIREMENT_DELTA_REQUIRED");
  const semanticHash = evidenceFreezeSemanticHash(input, current);
  if (current.intake_evidence_receipt) {
    if (current.intake_evidence_receipt.semantic_hash !== semanticHash) throw problem("EVIDENCE_FROZEN_CONFLICT", "EVIDENCE_FROZEN_CONFLICT", 409);
    return freezeOperationResult(current, current.intake_evidence_receipt, true);
  }
  const items = input.items.map((item) => ({ ...item, captured_at: item.captured_at ?? now.toISOString() }));
  const redactedItems = redactEvidence(items);
  const manifest = evidenceManifest({ issueId: current.issue_id, sourceCommit: input.source_commit ?? current.base_commit, items, frozenAt: now.toISOString() });
  const complete = manifest.completeness.reproduction
    && manifest.completeness.runtime
    && manifest.completeness.logs
    && manifest.completeness.sourceMap;
  if (!complete) throw problem("EVIDENCE_REQUIRED", "EVIDENCE_REQUIRED", 422);
  const receipt = freezeReceipt({
    issueId: current.issue_id,
    kind: "intake_evidence",
    semanticHash,
    actor,
    fromState: current.state,
    toState: current.state,
    now,
  });
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.intake_evidence.recorded",
    actor,
    payload: { manifest, redacted_items: redactedItems, receipt_hash: receipt.receipt_hash },
    now,
    transitionAction: "operational",
    mutate: (next) => {
      next.evidence = { local_items: items, redacted_items: redactedItems, manifest };
      next.attachments = store.listAttachments(current.issue_id);
      next.intake_evidence_receipt = receipt;
      return next;
    },
  });
  return freezeOperationResult(appended, receipt, false);
}

export function freezeArchitectureEvidence({ store, current, input, actor, now }) {
  const semanticHash = evidenceFreezeSemanticHash(input, current);
  const existingReceipt = current.freeze_receipts?.evidence ?? null;
  if (existingReceipt) {
    if (existingReceipt.semantic_hash !== semanticHash) throw problem("EVIDENCE_FROZEN_CONFLICT", "EVIDENCE_FROZEN_CONFLICT", 409);
    return freezeOperationResult(current, existingReceipt, true);
  }
  if (!current.requirement_delta) throw problem("REQUIREMENT_DELTA_REQUIRED");
  const items = input.items.map((item) => ({ ...item, captured_at: item.captured_at ?? now.toISOString() }));
  const redactedItems = redactEvidence(items);
  const manifest = evidenceManifest({
    issueId: current.issue_id,
    sourceCommit: input.source_commit ?? current.base_commit,
    items,
    frozenAt: now.toISOString(),
  });
  const complete = manifest.completeness.reproduction
    && manifest.completeness.runtime
    && manifest.completeness.logs
    && manifest.completeness.sourceMap;
  if (!complete) throw problem("EVIDENCE_REQUIRED", "EVIDENCE_REQUIRED", 422);
  const receipt = freezeReceipt({
    issueId: current.issue_id,
    kind: "evidence",
    semanticHash,
    actor,
    fromState: current.state,
    toState: "ARCHITECTURE_EVIDENCE_FROZEN",
    now,
  });
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "evidence.frozen",
    actor,
    payload: { manifest, redacted_items: redactedItems, freeze_receipt_hash: receipt.receipt_hash },
    now,
    transitionAction: "evidence.freeze",
    mutate: (next) => {
      next.evidence = { local_items: items, redacted_items: redactedItems, manifest };
      next.attachments = store.listAttachments(current.issue_id);
      next.freeze_receipts.evidence = receipt;
      next.state = "ARCHITECTURE_EVIDENCE_FROZEN";
      return next;
    },
  });
  return freezeOperationResult(appended, receipt, false);
}

export function beginArchitectureAssessments({ store, current, actor, now }) {
  assertProtocol(current);
  if (!current.evidence?.manifest) throw problem("EVIDENCE_REQUIRED");
  const binding = assessmentRoundBinding(current);
  const bindingHash = sha256(binding);
  return store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.assessments.started",
    actor,
    payload: { binding_hash: bindingHash, assessment_round: current.assessment_round ?? 1 },
    now,
    transitionAction: "assessment.begin",
    mutate: (next) => {
      next.assessment_slots = {
        codex: { status: "EMPTY", binding_hash: bindingHash },
        chatgpt: { status: "EMPTY", binding_hash: bindingHash },
      };
      next.assessment_receipts = {};
      next.assessments = {};
      next.state = "ARCHITECTURE_ASSESSMENTS_PENDING";
      return next;
    },
  });
}

export function submitArchitectureAssessment({ store, current, actor, assessment, now }) {
  assertProtocol(current);
  requireFields(assessment, actor === "codex"
    ? ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"]
    : ["product_goal_fit", "root_cause_explains_symptom", "authority_risk", "resolution_layer", "workflow_impact", "acceptance_gates", "scope_drift"]);
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: `assessment.${actor}.submitted`,
    actor,
    payload: ({ next }) => ({ receipt: next.assessment_receipts[actor] }),
    now,
    transitionAction: "assessment.submit",
    resolveCurrent: (latest) => {
      const context = architectureAssessmentContext(latest, actor, assessment);
      const existingReceipt = latest.assessment_receipts?.[actor] ?? null;
      if (!existingReceipt) {
        if (latest.state !== "ARCHITECTURE_ASSESSMENTS_PENDING") throw problem("ARCHITECTURE_ASSESSMENTS_NOT_PENDING");
        if (context.slot.status !== "EMPTY") throw problem("ASSESSMENT_IMMUTABLE");
        return null;
      }
      if (!replayableAssessmentReceipt(existingReceipt, context)) throw problem("ASSESSMENT_IMMUTABLE");
      if (existingReceipt.assessment_content_hash !== context.assessmentContentHash) {
        throw problem("ASSESSMENT_FROZEN_CONFLICT", "ASSESSMENT_FROZEN_CONFLICT", 409);
      }
      return freezeOperationResult(latest, existingReceipt, true);
    },
    mutate: (next, { eventId, createdAt }) => {
      if (next.state !== "ARCHITECTURE_ASSESSMENTS_PENDING") throw problem("ARCHITECTURE_ASSESSMENTS_NOT_PENDING");
      if (next.assessment_receipts?.[actor]) throw problem("ASSESSMENT_IMMUTABLE");
      const context = architectureAssessmentContext(next, actor, assessment);
      if (context.slot.status !== "EMPTY") throw problem("ASSESSMENT_IMMUTABLE");
      const assessmentId = `architecture-assessment-${randomUUID()}`;
      const sealed = {
        schema_version: "filmos.architecture-assessment.v2",
        assessment_id: assessmentId,
        assessment,
        actor,
        assessor: actor,
        assessment_round: context.assessmentRound,
        project_id: next.project_id,
        issue_id: next.issue_id,
        submission_id: next.submission_id ?? null,
        binding: context.binding,
        binding_hash: context.bindingHash,
        submitted_at: createdAt,
        event_id: eventId,
        content_hash: context.assessmentContentHash,
        sealed_until_pair_complete: true,
      };
      const receiptBase = {
        schema_version: "filmos.architecture-assessment-receipt.v2",
        assessment_id: assessmentId,
        project_id: next.project_id,
        issue_id: next.issue_id,
        submission_id: next.submission_id ?? null,
        actor,
        assessor: actor,
        assessment_round: context.assessmentRound,
        binding_hash: context.bindingHash,
        assessment_content_hash: context.assessmentContentHash,
        event_id: eventId,
        accepted_at: createdAt,
      };
      const receipt = { ...receiptBase, receipt_hash: sha256(receiptBase) };
      next.assessments[actor] = sealed;
      next.assessment_receipts[actor] = receipt;
      next.assessment_slots[actor] = {
        status: "SEALED",
        binding_hash: context.bindingHash,
        assessment_id: assessmentId,
        assessment_content_hash: context.assessmentContentHash,
        receipt_hash: receipt.receipt_hash,
        event_id: eventId,
      };
      const paired = Boolean(next.assessment_receipts.codex && next.assessment_receipts.chatgpt);
      if (paired) {
        const comparisonBase = {
          schema_version: "filmos.architecture-option-comparison.v2",
          issue_id: next.issue_id,
          assessment_round: next.assessment_round ?? 1,
          binding_hash: context.bindingHash,
          codex_assessment_hash: next.assessment_receipts.codex.assessment_content_hash,
          chatgpt_assessment_hash: next.assessment_receipts.chatgpt.assessment_content_hash,
        };
        next.option_comparison = { ...comparisonBase, content_hash: sha256(comparisonBase) };
        next.state = "OPTION_COMPARISON";
      } else next.state = "ARCHITECTURE_ASSESSMENTS_PENDING";
      return next;
    },
  });
  if (appended.operation_receipt && appended.idempotent_replay === true) return appended;
  return freezeOperationResult(appended, appended.assessment_receipts[actor], false);
}

export function freezeRequirementDelta({ store, current, delta, actor, now }) {
  assertProtocol(current);
  requireFields(delta, ["current_flow", "current_blocker", "target_experience", "must_preserve", "may_change", "success_criteria"]);
  const semanticHash = sha256(delta);
  const existingReceipt = current.freeze_receipts?.requirement_delta ?? null;
  if (existingReceipt) {
    if (existingReceipt.semantic_hash !== semanticHash) throw problem("REQUIREMENT_DELTA_FROZEN_CONFLICT", "REQUIREMENT_DELTA_FROZEN_CONFLICT", 409);
    return freezeOperationResult(current, existingReceipt, true);
  }
  const receipt = freezeReceipt({ issueId: current.issue_id, kind: "requirement_delta", semanticHash, actor, fromState: current.state, toState: "REQUIREMENT_DELTA_FROZEN", now });
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.requirement_delta.frozen",
    actor,
    payload: { delta, freeze_receipt_hash: receipt.receipt_hash },
    now,
    transitionAction: "requirement.freeze",
    mutate: (next) => {
      next.requirement_delta = { ...delta, semantic_hash: semanticHash, content_hash: sha256(delta) };
      next.freeze_receipts.requirement_delta = receipt;
      next.state = "REQUIREMENT_DELTA_FROZEN";
      return next;
    },
  });
  return freezeOperationResult(appended, receipt, false);
}

export function freezeArchitectureOptions({ store, current, options, actor, now }) {
  assertProtocol(current);
  const names = new Set((options ?? []).map((item) => item.option));
  if ((options ?? []).length !== 3 || names.size !== 3 || !["A", "B", "C"].every((name) => names.has(name))) throw problem("ARCHITECTURE_OPTIONS_A_B_C_REQUIRED");
  if (!current.option_comparison) throw problem("ARCHITECTURE_OPTION_COMPARISON_REQUIRED");
  const frozenOptions = [...options].sort((a, b) => a.option.localeCompare(b.option)).map((option) => ({ ...option, content_hash: sha256(option) }));
  const semanticHash = sha256({ option_comparison_hash: current.option_comparison.content_hash, options: frozenOptions });
  const existingReceipt = current.freeze_receipts?.architecture_options ?? null;
  if (existingReceipt) {
    if (existingReceipt.semantic_hash !== semanticHash) throw problem("ARCHITECTURE_OPTIONS_FROZEN_CONFLICT", "ARCHITECTURE_OPTIONS_FROZEN_CONFLICT", 409);
    return freezeOperationResult(current, existingReceipt, true);
  }
  if (current.state !== "OPTION_COMPARISON") throw problem("ARCHITECTURE_OPTION_COMPARISON_REQUIRED");
  const receipt = freezeReceipt({ issueId: current.issue_id, kind: "architecture_options", semanticHash, actor, fromState: current.state, toState: "OWNER_DECISION_REQUIRED", now });
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.options.frozen",
    actor,
    payload: { options: frozenOptions, freeze_receipt_hash: receipt.receipt_hash },
    now,
    transitionAction: "options.freeze",
    mutate: (next) => {
      next.architecture_options = { options: frozenOptions, semantic_hash: semanticHash, content_hash: semanticHash };
      next.freeze_receipts.architecture_options = receipt;
      next.state = "OWNER_DECISION_REQUIRED";
      return next;
    },
  });
  return freezeOperationResult(appended, receipt, false);
}

export function acceptArchitectureOption({ store, current, input, actor, now }) {
  if (!isArchitectureV2(current) || !current.architecture_options) throw problem("ARCHITECTURE_OPTIONS_REQUIRED");
  exactObject(input, ["option", "option_content_hash", "user_authorized"]);
  if (actor !== "user" || input.user_authorized !== true) throw problem("OWNER_AUTHORIZATION_REQUIRED");
  const selected = current.architecture_options.options.find((item) => item.option === input.option);
  if (!selected) throw problem("ARCHITECTURE_OPTION_NOT_FOUND");
  if (input.option_content_hash !== selected.content_hash) throw problem("ARCHITECTURE_OPTION_HASH_MISMATCH");
  const semanticHash = sha256({ option: input.option, option_content_hash: input.option_content_hash, user_authorized: true });
  const existingReceipt = current.freeze_receipts?.accepted_architecture_option ?? null;
  if (existingReceipt) {
    if (existingReceipt.semantic_hash !== semanticHash) throw problem("ARCHITECTURE_OPTION_FROZEN_CONFLICT", "ARCHITECTURE_OPTION_FROZEN_CONFLICT", 409);
    return freezeOperationResult(current, existingReceipt, true);
  }
  if (current.state !== "OWNER_DECISION_REQUIRED") throw problem("OWNER_DECISION_REQUIRED");
  const receipt = freezeReceipt({ issueId: current.issue_id, kind: "accepted_architecture_option", semanticHash, actor, fromState: current.state, toState: "ARCHITECTURE_OPTION_ACCEPTED", now });
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.option.accepted",
    actor,
    payload: { ...input, freeze_receipt_hash: receipt.receipt_hash },
    now,
    transitionAction: "option.accept",
    mutate: (next) => {
      next.accepted_architecture_option = { ...selected, accepted_at: now.toISOString(), semantic_hash: semanticHash, receipt_hash: receipt.receipt_hash };
      next.freeze_receipts.accepted_architecture_option = receipt;
      next.state = "ARCHITECTURE_OPTION_ACCEPTED";
      return next;
    },
  });
  return freezeOperationResult(appended, receipt, false);
}

function assertProtocol(value) {
  if (!isArchitectureV2(value)) throw problem("ARCHITECTURE_PROTOCOL_V2_REQUIRED");
}

function architectureAssessmentContext(value, actor, assessment) {
  assertProtocol(value);
  const slot = value.assessment_slots?.[actor];
  if (!slot) throw problem("ARCHITECTURE_ASSESSMENT_SLOT_REQUIRED");
  const assessmentRound = value.assessment_round ?? 1;
  const binding = assessmentRoundBinding(value);
  const bindingHash = sha256(binding);
  if (slot.binding_hash !== bindingHash) throw problem("ASSESSMENT_BINDING_MISMATCH");
  const assessmentContentHash = sha256({
    schema_version: "filmos.architecture-assessment.v2",
    project_id: value.project_id,
    issue_id: value.issue_id,
    submission_id: value.submission_id ?? null,
    actor,
    assessment_round: assessmentRound,
    binding_hash: bindingHash,
    assessment,
  });
  return {
    projectId: value.project_id,
    issueId: value.issue_id,
    submissionId: value.submission_id ?? null,
    actor,
    assessmentRound,
    binding,
    bindingHash,
    assessmentContentHash,
    slot,
    sealedAssessment: value.assessments?.[actor] ?? null,
  };
}

function replayableAssessmentReceipt(receipt, context) {
  const slot = context.slot;
  const sealed = context.sealedAssessment;
  if (receipt?.schema_version !== "filmos.architecture-assessment-receipt.v2"
    || typeof receipt.assessment_id !== "string"
    || !receipt.assessment_id.startsWith("architecture-assessment-")
    || typeof receipt.event_id !== "string"
    || !receipt.event_id.startsWith("review-event-")
    || receipt.project_id === undefined
    || receipt.issue_id === undefined
    || receipt.submission_id === undefined
    || receipt.actor === undefined
    || receipt.assessment_round === undefined
    || receipt.binding_hash === undefined
    || typeof receipt.assessment_content_hash !== "string"
    || typeof receipt.receipt_hash !== "string"
    || slot?.status !== "SEALED"
    || sealed?.schema_version !== "filmos.architecture-assessment.v2") return false;
  const { receipt_hash: receiptHash, ...receiptBase } = receipt;
  return receipt.project_id === context.projectId
    && receipt.issue_id === context.issueId
    && receipt.submission_id === context.submissionId
    && receipt.actor === context.actor
    && receipt.actor === receipt.assessor
    && receipt.assessment_round === context.assessmentRound
    && receipt.binding_hash === context.bindingHash
    && slot.assessment_id === receipt.assessment_id
    && slot.assessment_content_hash === receipt.assessment_content_hash
    && slot.receipt_hash === receipt.receipt_hash
    && slot.event_id === receipt.event_id
    && sealed.assessment_id === receipt.assessment_id
    && sealed.project_id === context.projectId
    && sealed.issue_id === context.issueId
    && sealed.submission_id === context.submissionId
    && sealed.actor === context.actor
    && sealed.assessor === context.actor
    && sealed.assessment_round === context.assessmentRound
    && sealed.binding_hash === context.bindingHash
    && sealed.content_hash === receipt.assessment_content_hash
    && sealed.event_id === receipt.event_id
    && sealed.submitted_at === receipt.accepted_at
    && sha256({
      schema_version: "filmos.architecture-assessment.v2",
      project_id: sealed.project_id,
      issue_id: sealed.issue_id,
      submission_id: sealed.submission_id,
      actor: sealed.actor,
      assessment_round: sealed.assessment_round,
      binding_hash: sealed.binding_hash,
      assessment: sealed.assessment,
    }) === receipt.assessment_content_hash
    && receiptHash === sha256(receiptBase);
}

function assessmentRoundBinding(value) {
  return {
    project_id: value.project_id,
    evidence_manifest_hash: value.evidence?.manifest?.contentHash ?? value.evidence?.manifest?.content_hash ?? null,
    constitution_content_hash: value.constitution_content_hash,
  };
}

function evidenceFreezeSemanticHash(input, current) {
  const items = [...input.items]
    .map((item) => structuredClone(item))
    .sort((a, b) => String(a.evidence_id ?? sha256(a)).localeCompare(String(b.evidence_id ?? sha256(b))));
  return sha256({ source_commit: input.source_commit ?? current.base_commit, items });
}

function freezeReceipt({ issueId, kind, semanticHash, actor, fromState, toState, now }) {
  const base = {
    schema_version: "filmos.freeze-receipt.v2",
    issue_id: issueId,
    object_kind: kind,
    semantic_hash: semanticHash,
    actor,
    from_state: fromState,
    to_state: toState,
    frozen_at: now.toISOString(),
  };
  return { ...base, receipt_hash: sha256(base) };
}

function freezeOperationResult(issue, receipt, idempotentReplay) {
  return {
    ...structuredClone(issue),
    operation_receipt: structuredClone(receipt),
    idempotent_replay: idempotentReplay,
  };
}

function requireFields(value, fields) {
  for (const field of fields) if (!(field in (value ?? {}))) throw problem(`MISSING_${field.toUpperCase()}`);
}

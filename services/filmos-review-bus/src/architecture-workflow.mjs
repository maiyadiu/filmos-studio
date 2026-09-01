import { exactObject, problem, sha256 } from "./canonical.mjs";
import {
  ARCHITECTURE_PROTOCOL_VERSION,
} from "./architecture-protocol.mjs";
import { evidenceManifest, redactEvidence } from "./redaction.mjs";

export function isArchitectureV2(value) {
  return value?.lane === "architecture" && value.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION;
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
  if (current.state !== "ARCHITECTURE_ASSESSMENTS_PENDING") throw problem("ARCHITECTURE_ASSESSMENTS_NOT_PENDING");
  if (!current.assessment_slots?.[actor]) throw problem("ARCHITECTURE_ASSESSMENT_SLOT_REQUIRED");
  if (current.assessment_receipts?.[actor]) throw problem("ASSESSMENT_IMMUTABLE");
  requireFields(assessment, actor === "codex"
    ? ["reproduced", "root_cause", "call_chain", "files", "minimal_change", "regression_risk", "tests", "rollback"]
    : ["product_goal_fit", "root_cause_explains_symptom", "authority_risk", "resolution_layer", "workflow_impact", "acceptance_gates", "scope_drift"]);
  const binding = assessmentRoundBinding(current);
  const bindingHash = sha256(binding);
  if (current.assessment_slots[actor].binding_hash !== bindingHash) throw problem("ASSESSMENT_BINDING_MISMATCH");
  const sealedBase = {
    assessment,
    assessor: actor,
    assessment_round: current.assessment_round ?? 1,
    project_id: current.project_id,
    binding,
    binding_hash: bindingHash,
    submitted_at: now.toISOString(),
  };
  const sealed = { ...sealedBase, content_hash: sha256(sealedBase), sealed_until_pair_complete: true };
  const receiptBase = {
    schema_version: "filmos.architecture-assessment-receipt.v2",
    issue_id: current.issue_id,
    assessor: actor,
    assessment_round: current.assessment_round ?? 1,
    binding_hash: bindingHash,
    assessment_content_hash: sealed.content_hash,
    accepted_at: now.toISOString(),
  };
  const receipt = { ...receiptBase, receipt_hash: sha256(receiptBase) };
  return store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: `assessment.${actor}.submitted`,
    actor,
    payload: { receipt },
    now,
    transitionAction: "assessment.submit",
    mutate: (next) => {
      next.assessments[actor] = sealed;
      next.assessment_receipts[actor] = receipt;
      next.assessment_slots[actor] = { status: "SEALED", binding_hash: bindingHash, receipt_hash: receipt.receipt_hash };
      const paired = Boolean(next.assessment_receipts.codex && next.assessment_receipts.chatgpt);
      if (paired) {
        const comparisonBase = {
          schema_version: "filmos.architecture-option-comparison.v2",
          issue_id: current.issue_id,
          assessment_round: next.assessment_round ?? 1,
          binding_hash: bindingHash,
          codex_assessment_hash: next.assessment_receipts.codex.assessment_content_hash,
          chatgpt_assessment_hash: next.assessment_receipts.chatgpt.assessment_content_hash,
        };
        next.option_comparison = { ...comparisonBase, content_hash: sha256(comparisonBase) };
        next.state = "OPTION_COMPARISON";
      } else next.state = "ARCHITECTURE_ASSESSMENTS_PENDING";
      return next;
    },
  });
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

import { randomUUID } from "node:crypto";

import { exactObject, problem, sha256 } from "./canonical.mjs";
import { ARCHITECTURE_TRANSITION_CONTRACT_HASH } from "./architecture-protocol.mjs";
import { isArchitectureV2 } from "./architecture-workflow.mjs";

export function proposeArchitectureConsensus({ store, current, actor, now }) {
  assertProtocol(current);
  if (current.state !== "ARCHITECTURE_OPTION_ACCEPTED" || !current.accepted_architecture_option?.receipt_hash) {
    throw problem("ARCHITECTURE_OPTION_ACCEPTED_REQUIRED");
  }
  assertAssessmentPair(current);
  const bindings = architectureAuthorityBindings(current);
  const proposalBase = {
    schema_version: "filmos.architecture-consensus-proposal.v2",
    proposal_id: `architecture-consensus-${randomUUID()}`,
    issue_id: current.issue_id,
    project_id: current.project_id,
    assessment_round: current.assessment_round ?? 1,
    bindings,
    accepted_option: current.accepted_architecture_option,
    codex_position: "PENDING",
    chatgpt_position: "PENDING",
    created_at: now.toISOString(),
  };
  const proposal = { ...proposalBase, content_hash: sha256(proposalBase) };
  return store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.consensus.proposed",
    actor,
    payload: { proposal_content_hash: proposal.content_hash, bindings },
    now,
    transitionAction: "consensus.propose",
    mutate: (next) => {
      next.consensus_proposal = proposal;
      next.consensus_responses = [];
      next.state = "CONSENSUS_PROPOSED";
      return next;
    },
  });
}

export function respondArchitectureConsensus({ store, current, actor, response, now }) {
  assertProtocol(current);
  if (!["codex", "chatgpt"].includes(actor)) throw problem("INVALID_CONSENSUS_ACTOR");
  if (current.state !== "CONSENSUS_PROPOSED" || !current.consensus_proposal) throw problem("CONSENSUS_PROPOSAL_REQUIRED");
  exactObject(response, ["proposal_content_hash", "position", "requested_changes"]);
  if (response.proposal_content_hash !== current.consensus_proposal.content_hash) throw problem("CONSENSUS_PROPOSAL_HASH_MISMATCH");
  if (!["ACCEPTED", "CHANGES_REQUESTED"].includes(response.position)) throw problem("INVALID_CONSENSUS_POSITION");
  if (!Array.isArray(response.requested_changes) || response.requested_changes.some((item) => typeof item !== "string" || !item.trim())) {
    throw problem("INVALID_CONSENSUS_CHANGES");
  }
  if (response.position === "CHANGES_REQUESTED" && response.requested_changes.length === 0) throw problem("CONSENSUS_CHANGES_REQUIRED");
  if (current.consensus_responses.some((item) => item.actor === actor)) throw problem("CONSENSUS_RESPONSE_IMMUTABLE");
  const responseBase = {
    schema_version: "filmos.architecture-consensus-response.v2",
    ...response,
    actor,
    accepted_option_hash: current.accepted_architecture_option.content_hash,
    submitted_at: now.toISOString(),
  };
  const value = { ...responseBase, content_hash: sha256(responseBase) };
  return store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "consensus.responded",
    actor,
    payload: value,
    now,
    transitionAction: "consensus.respond",
    mutate: (next) => {
      next.consensus_responses.push(value);
      const positionKey = actor === "codex" ? "codex_position" : "chatgpt_position";
      next.consensus_proposal[positionKey] = response.position;
      if (response.position === "CHANGES_REQUESTED") {
        archiveRejectedConsensusRound(next, now);
        next.state = "OPTION_COMPARISON";
        return next;
      }
      if (next.consensus_proposal.codex_position === "ACCEPTED" && next.consensus_proposal.chatgpt_position === "ACCEPTED") {
        const recordBase = {
          schema_version: "filmos.architecture-consensus-record.v2",
          consensus_record_id: `architecture-consensus-record-${randomUUID()}`,
          issue_id: next.issue_id,
          project_id: next.project_id,
          proposal_content_hash: next.consensus_proposal.content_hash,
          response_hashes: [...next.consensus_responses].sort((a, b) => a.actor.localeCompare(b.actor)).map((item) => item.content_hash),
          bindings: architectureAuthorityBindings(next),
          reached_at: now.toISOString(),
        };
        next.consensus_record = { ...recordBase, contentHash: sha256(recordBase), content_hash: sha256(recordBase) };
        next.state = "CONSENSUS_REACHED";
      } else next.state = "CONSENSUS_PROPOSED";
      return next;
    },
  });
}

export function freezeArchitectureTaskPackage({ store, current, input, actor, now }) {
  assertProtocol(current);
  validateTaskPackageInput(input);
  if (!current.consensus_record) throw problem("CONSENSUS_RECORD_REQUIRED");
  const bindings = architectureAuthorityBindings(current);
  const semanticBase = {
    schema_version: "filmos.architecture-task-package.v2",
    issue_id: current.issue_id,
    project_id: current.project_id,
    base_commit: current.base_commit,
    build_lineage_task_package_hash: current.build_lineage_task_package_hash,
    consensus_record_hash: current.consensus_record.contentHash ?? current.consensus_record.content_hash,
    bindings,
    allowedChangeScope: normalizedStrings(input.allowedChangeScope),
    explicitNonGoals: normalizedStrings(input.explicitNonGoals),
    implementationPlan: normalizedStrings(input.implementationPlan),
    acceptanceGates: normalizedStrings(input.acceptanceGates),
    rollbackPlan: normalizedStrings(input.rollbackPlan),
  };
  const semanticHash = sha256(semanticBase);
  if (current.task_package_receipt) {
    if (current.task_package_receipt.semantic_hash !== semanticHash) throw problem("TASK_PACKAGE_FROZEN_CONFLICT", "TASK_PACKAGE_FROZEN_CONFLICT", 409);
    return operationResult(current, current.task_package_receipt, true);
  }
  if (current.state !== "CONSENSUS_REACHED") throw problem("CONSENSUS_REACHED_REQUIRED");
  const taskBase = {
    ...semanticBase,
    taskPackageId: `architecture-task-package-${randomUUID()}`,
    createdAt: now.toISOString(),
  };
  const taskPackage = { ...taskBase, contentHash: sha256(taskBase), content_hash: sha256(taskBase), semantic_hash: semanticHash };
  const receiptBase = {
    schema_version: "filmos.task-package-freeze-receipt.v2",
    issue_id: current.issue_id,
    semantic_hash: semanticHash,
    task_package_content_hash: taskPackage.contentHash,
    frozen_at: now.toISOString(),
  };
  const receipt = { ...receiptBase, receipt_hash: sha256(receiptBase) };
  const appended = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.task_package.frozen",
    actor,
    payload: { task_package_content_hash: taskPackage.contentHash, receipt_hash: receipt.receipt_hash },
    now,
    transitionAction: "task-package.freeze",
    mutate: (next) => {
      next.issue_task_package = taskPackage;
      next.task_package_content_hash = taskPackage.contentHash;
      next.task_package_receipt = receipt;
      next.state = "TASK_PACKAGE_FROZEN";
      return next;
    },
  });
  return operationResult(appended, receipt, false);
}

export function startArchitectureImplementation({ store, current, actor, now }) {
  assertProtocol(current);
  if (!current.issue_task_package || !current.task_package_receipt) throw problem("ISSUE_TASK_PACKAGE_REQUIRED");
  return store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "architecture.implementation.started",
    actor,
    payload: {
      task_package_content_hash: current.task_package_content_hash,
      architecture_binding_hash: architectureCandidateBindingHash(current),
    },
    now,
    transitionAction: "implementation.start",
    mutate: (next) => {
      next.state = "CODEX_IMPLEMENTING";
      return next;
    },
  });
}

export function architectureCandidateBinding(current) {
  return {
    architecture_protocol_version: current.architecture_protocol_version,
    transition_contract_hash: current.architecture_transition_contract_hash,
    requirement_delta_hash: current.requirement_delta?.semantic_hash ?? null,
    evidence_manifest_hash: current.evidence?.manifest?.contentHash ?? current.evidence?.manifest?.content_hash ?? null,
    codex_assessment_receipt_hash: current.assessment_receipts?.codex?.receipt_hash ?? null,
    chatgpt_assessment_receipt_hash: current.assessment_receipts?.chatgpt?.receipt_hash ?? null,
    option_comparison_hash: current.option_comparison?.content_hash ?? null,
    architecture_options_hash: current.architecture_options?.semantic_hash ?? null,
    accepted_option_hash: current.accepted_architecture_option?.content_hash ?? null,
    accepted_option_receipt_hash: current.accepted_architecture_option?.receipt_hash ?? null,
    consensus_record_hash: current.consensus_record?.contentHash ?? current.consensus_record?.content_hash ?? null,
    task_package_content_hash: current.task_package_content_hash,
    constitution_content_hash: current.constitution_content_hash,
  };
}

export function architectureCandidateBindingHash(current) {
  const binding = architectureCandidateBinding(current);
  if (Object.values(binding).some((value) => value === null)) throw problem("ARCHITECTURE_AUTHORITY_BINDING_INCOMPLETE");
  return sha256(binding);
}

function architectureAuthorityBindings(current) {
  return {
    transition_contract_hash: current.architecture_transition_contract_hash ?? ARCHITECTURE_TRANSITION_CONTRACT_HASH,
    requirement_delta_hash: current.requirement_delta?.semantic_hash ?? null,
    evidence_manifest_hash: current.evidence?.manifest?.contentHash ?? current.evidence?.manifest?.content_hash ?? null,
    codex_assessment_receipt_hash: current.assessment_receipts?.codex?.receipt_hash ?? null,
    chatgpt_assessment_receipt_hash: current.assessment_receipts?.chatgpt?.receipt_hash ?? null,
    option_comparison_hash: current.option_comparison?.content_hash ?? null,
    architecture_options_hash: current.architecture_options?.semantic_hash ?? null,
    accepted_option_hash: current.accepted_architecture_option?.content_hash ?? null,
    accepted_option_receipt_hash: current.accepted_architecture_option?.receipt_hash ?? null,
    constitution_content_hash: current.constitution_content_hash,
  };
}

function assertAssessmentPair(current) {
  if (!current.assessment_receipts?.codex || !current.assessment_receipts?.chatgpt) throw problem("DUAL_ASSESSMENT_RECEIPTS_REQUIRED");
  if (current.assessment_receipts.codex.binding_hash !== current.assessment_receipts.chatgpt.binding_hash) throw problem("ASSESSMENT_BINDING_MISMATCH");
}

function archiveRejectedConsensusRound(next, now) {
  const archiveBase = {
    assessment_round: next.assessment_round ?? 1,
    option_comparison: next.option_comparison,
    architecture_options: next.architecture_options,
    accepted_architecture_option: next.accepted_architecture_option,
    consensus_proposal: next.consensus_proposal,
    consensus_responses: next.consensus_responses,
    ended_at: now.toISOString(),
    reason: "CONSENSUS_CHANGES_REQUESTED",
  };
  next.architecture_round_history ??= [];
  next.architecture_round_history.push({ ...archiveBase, content_hash: sha256(archiveBase) });
  const changes = next.consensus_responses.flatMap((item) => item.requested_changes);
  const comparisonBase = {
    schema_version: "filmos.architecture-option-comparison.v2",
    issue_id: next.issue_id,
    assessment_round: next.assessment_round ?? 1,
    revision: (next.option_comparison?.revision ?? 1) + 1,
    prior_comparison_hash: next.option_comparison?.content_hash ?? null,
    requested_changes: normalizedStrings(changes),
    codex_assessment_hash: next.assessment_receipts.codex.assessment_content_hash,
    chatgpt_assessment_hash: next.assessment_receipts.chatgpt.assessment_content_hash,
  };
  next.option_comparison = { ...comparisonBase, content_hash: sha256(comparisonBase) };
  next.freeze_receipt_history ??= [];
  next.freeze_receipt_history.push({
    architecture_options: next.freeze_receipts.architecture_options,
    accepted_architecture_option: next.freeze_receipts.accepted_architecture_option,
  });
  delete next.freeze_receipts.architecture_options;
  delete next.freeze_receipts.accepted_architecture_option;
  next.architecture_options = null;
  next.accepted_architecture_option = null;
  next.consensus_proposal = null;
  next.consensus_responses = [];
  next.consensus_record = null;
}

function validateTaskPackageInput(value) {
  exactObject(value, ["allowedChangeScope", "explicitNonGoals", "implementationPlan", "acceptanceGates", "rollbackPlan"]);
  for (const field of ["allowedChangeScope", "explicitNonGoals", "implementationPlan", "acceptanceGates", "rollbackPlan"]) {
    if (!Array.isArray(value[field]) || value[field].length === 0 || value[field].some((item) => typeof item !== "string" || !item.trim())) {
      throw problem(`INVALID_${field.replace(/[A-Z]/g, (match) => `_${match}`).toUpperCase()}`);
    }
  }
}

function normalizedStrings(values) {
  return [...new Set(values.map((item) => item.trim()))];
}

function operationResult(issue, receipt, idempotentReplay) {
  return { ...structuredClone(issue), operation_receipt: structuredClone(receipt), idempotent_replay: idempotentReplay };
}

function assertProtocol(value) {
  if (!isArchitectureV2(value)) throw problem("ARCHITECTURE_PROTOCOL_V2_REQUIRED");
}

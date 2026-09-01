import { sha256, problem } from "./canonical.mjs";

export const ARCHITECTURE_PROTOCOL_VERSION = "filmos.architecture-protocol.v2";
export const ARCHITECTURE_STATE_MAPPING_VERSION = "filmos.architecture-state-map.v2";

export const ARCHITECTURE_V2_STATES = Object.freeze([
  "REQUIREMENT_OBSERVED",
  "REQUIREMENT_DELTA_FROZEN",
  "ARCHITECTURE_EVIDENCE_FROZEN",
  "ARCHITECTURE_ASSESSMENTS_PENDING",
  "OPTION_COMPARISON",
  "OWNER_DECISION_REQUIRED",
  "ARCHITECTURE_OPTION_ACCEPTED",
  "CONSENSUS_PROPOSED",
  "CONSENSUS_REACHED",
  "TASK_PACKAGE_FROZEN",
  "CODEX_IMPLEMENTING",
  "CANDIDATE_UNDER_REVIEW",
  "DUAL_APPROVED",
  "PILOT_MIGRATION",
  "PILOT_OBSERVATION",
  "ARCHITECTURE_ADOPTED",
]);

const actionTable = Object.freeze({
  "protocol.v2.genesis": rule([null], ["REQUIREMENT_OBSERVED"], ["user", "system"]),
  "requirement.freeze": rule(["REQUIREMENT_OBSERVED"], ["REQUIREMENT_DELTA_FROZEN"], ["user", "system"]),
  "evidence.freeze": rule(["REQUIREMENT_DELTA_FROZEN"], ["ARCHITECTURE_EVIDENCE_FROZEN"], ["codex", "system"]),
  "assessment.begin": rule(["ARCHITECTURE_EVIDENCE_FROZEN"], ["ARCHITECTURE_ASSESSMENTS_PENDING"], ["review-codex-coordinator", "system"]),
  "assessment.submit": rule(["ARCHITECTURE_ASSESSMENTS_PENDING"], ["ARCHITECTURE_ASSESSMENTS_PENDING", "OPTION_COMPARISON"], ["codex", "chatgpt"]),
  "options.freeze": rule(["OPTION_COMPARISON"], ["OWNER_DECISION_REQUIRED"], ["codex"]),
  "option.accept": rule(["OWNER_DECISION_REQUIRED"], ["ARCHITECTURE_OPTION_ACCEPTED"], ["user"]),
  "consensus.propose": rule(["ARCHITECTURE_OPTION_ACCEPTED"], ["CONSENSUS_PROPOSED"], ["review-codex-coordinator", "codex"]),
  "consensus.respond": rule(["CONSENSUS_PROPOSED"], ["CONSENSUS_PROPOSED", "CONSENSUS_REACHED", "OPTION_COMPARISON"], ["codex", "chatgpt"]),
  "task-package.freeze": rule(["CONSENSUS_REACHED"], ["TASK_PACKAGE_FROZEN"], ["review-codex-coordinator", "codex"]),
  "implementation.start": rule(["TASK_PACKAGE_FROZEN"], ["CODEX_IMPLEMENTING"], ["review-codex-coordinator", "codex"]),
  "candidate.submit": rule(["CODEX_IMPLEMENTING"], ["CANDIDATE_UNDER_REVIEW"], ["codex"]),
  "candidate.supersede": rule(["CANDIDATE_UNDER_REVIEW"], ["CODEX_IMPLEMENTING", "OWNER_DECISION_REQUIRED"], ["codex"]),
  "candidate.verdict": rule(["CANDIDATE_UNDER_REVIEW"], ["CANDIDATE_UNDER_REVIEW", "DUAL_APPROVED", "CODEX_IMPLEMENTING", "OWNER_DECISION_REQUIRED"], ["codex", "chatgpt", "machine"]),
  "pilot.migrate": rule(["DUAL_APPROVED"], ["PILOT_MIGRATION"], ["system"]),
  "pilot.observe": rule(["PILOT_MIGRATION"], ["PILOT_OBSERVATION"], ["system"]),
  "architecture.adopt": rule(["PILOT_OBSERVATION"], ["ARCHITECTURE_ADOPTED"], ["user"]),
  "protocol.v2.anchor": rule(ARCHITECTURE_V2_STATES, ARCHITECTURE_V2_STATES, ["system"]),
  operational: rule(ARCHITECTURE_V2_STATES, ARCHITECTURE_V2_STATES, ["filmos-review-bus", "review-codex-coordinator", "codex", "chatgpt", "system", "user"]),
});

export const ARCHITECTURE_TRANSITION_CONTRACT = Object.freeze({
  schema_version: ARCHITECTURE_PROTOCOL_VERSION,
  state_mapping_version: ARCHITECTURE_STATE_MAPPING_VERSION,
  states: ARCHITECTURE_V2_STATES,
  actions: Object.fromEntries(Object.entries(actionTable).map(([action, value]) => [action, {
    from: value.from,
    to: value.to,
    actors: value.actors,
  }])),
});

export const ARCHITECTURE_TRANSITION_CONTRACT_HASH = sha256(ARCHITECTURE_TRANSITION_CONTRACT);

export function assertArchitectureTransition({ current, action, actor, nextState }) {
  if (current && current.lane !== "architecture") throw problem("ARCHITECTURE_LANE_REQUIRED");
  const ruleValue = actionTable[action];
  if (!ruleValue) throw problem("ARCHITECTURE_ACTION_NOT_REGISTERED");
  if (!ruleValue.from.includes(current?.state ?? null)) throw problem("ARCHITECTURE_TRANSITION_STATE_DENIED");
  if (!ruleValue.to.includes(nextState)) throw problem("ARCHITECTURE_TRANSITION_TARGET_DENIED");
  if (!ruleValue.actors.includes(actor)) throw problem("ARCHITECTURE_TRANSITION_ACTOR_DENIED");
  return true;
}

export function normalizeLegacyArchitectureState(state) {
  const mapping = {
    CODEX_ARCHITECTURE_ASSESSMENT: "ARCHITECTURE_ASSESSMENTS_PENDING",
    CHATGPT_ARCHITECTURE_ASSESSMENT: "ARCHITECTURE_ASSESSMENTS_PENDING",
    ARCHITECTURE_CHANGE_APPROVED: "ARCHITECTURE_OPTION_ACCEPTED",
    LOCAL_ACCEPTED: "CANDIDATE_UNDER_REVIEW",
    EXTERNAL_APPROVED: "CANDIDATE_UNDER_REVIEW",
    MACHINE_PASS: "CANDIDATE_UNDER_REVIEW",
  };
  const normalized = mapping[state] ?? state;
  if (!ARCHITECTURE_V2_STATES.includes(normalized)) throw problem("ARCHITECTURE_LEGACY_STATE_UNMAPPABLE");
  return normalized;
}

export function architectureSemanticProjection(value) {
  if (value === null) return null;
  const normalized = structuredClone(value);
  delete normalized.content_hash;
  delete normalized.updated_at;
  delete normalized.entity_version;
  delete normalized.codex_coordination;
  delete normalized.runtime_recovery;
  normalized.state = normalizeLegacyArchitectureState(normalized.state);
  normalized.architecture_protocol_version = ARCHITECTURE_PROTOCOL_VERSION;
  return normalized;
}

export function architectureTransitionPayload({ current, next, action, actor }) {
  assertArchitectureTransition({ current, action, actor, nextState: next.state });
  return {
    pre_projection_hash: current ? sha256(architectureSemanticProjection(current)) : null,
    action,
    from_state: current?.state ?? null,
    to_state: next.state,
    post_projection_hash: sha256(architectureSemanticProjection(next)),
    transition_contract_version: ARCHITECTURE_PROTOCOL_VERSION,
    transition_contract_hash: ARCHITECTURE_TRANSITION_CONTRACT_HASH,
  };
}

function rule(from, to, actors) {
  return Object.freeze({ from: Object.freeze([...from]), to: Object.freeze([...to]), actors: Object.freeze([...actors]) });
}

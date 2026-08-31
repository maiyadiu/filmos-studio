export const CONSTITUTION_VERSION = "1.1.0";
export const CONSTITUTION_HASH = "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41";
export const TASK_PACKAGE_HASH = "99ebaf3b0415c3704c488dbfc23828ecccc3b5b03486a3bf759c586681782893";
export const MAX_AUTOMATIC_ROUNDS = 2;

export const MAIN_STATES = [
  "OBSERVED_IN_USE", "EVIDENCE_FROZEN", "CODEX_ASSESSING", "CHATGPT_ASSESSING",
  "CONSENSUS_REVIEW", "CONSENSUS_REACHED", "CODEX_IMPLEMENTING", "CODEX_LOCAL_ACCEPTED",
  "CHATGPT_EXTERNAL_REVIEW", "MACHINE_PASS", "DUAL_APPROVED", "PILOT_DEPLOYED", "OBSERVING_IN_USE",
  "EVIDENCE_REQUIRED", "OWNER_DECISION_REQUIRED",
];

export const ARCHITECTURE_STATES = [
  "REQUIREMENT_OBSERVED", "REQUIREMENT_DELTA_FROZEN", "ARCHITECTURE_EVIDENCE_FROZEN",
  "CODEX_ARCHITECTURE_ASSESSMENT", "CHATGPT_ARCHITECTURE_ASSESSMENT", "OPTION_COMPARISON",
  "CONSENSUS_REACHED", "OWNER_DECISION_REQUIRED", "ARCHITECTURE_CHANGE_APPROVED", "CODEX_IMPLEMENTING",
  "LOCAL_ACCEPTED", "EXTERNAL_APPROVED", "MACHINE_PASS", "PILOT_MIGRATION", "PILOT_OBSERVATION",
  "ARCHITECTURE_ADOPTED",
];

export const LATE_FINDING_TAXONOMY = [
  "PREVIOUS_REVIEW_MISS", "REGRESSION_INTRODUCED_BY_FIX", "NEWLY_OBSERVABLE", "SCOPE_EXPANSION",
];

export const SENSITIVE_FAST_SCOPES = [
  /film-core/i, /provider/i, /budget/i, /secret|auth/i, /candidate|qc|approved/i,
  /migration/i, /agent.+permission/i, /authority/i, /generation.+submit/i,
];

export function classifyLane(report) {
  if (report.architecture_gap || report.requires_schema_change || report.requires_authority_change) return "architecture";
  if (report.data_loss || report.security || report.cost || report.provider_submit || report.migration || report.core_state) return "core";
  return "fast";
}

export function assertFastScope(changedFiles, patchSummary = "") {
  const material = `${changedFiles.join("\n")}\n${patchSummary}`;
  if (SENSITIVE_FAST_SCOPES.some((pattern) => pattern.test(material))) throw Object.assign(new Error("FAST_LANE_SCOPE_DENIED"), { code: "FAST_LANE_SCOPE_DENIED" });
}

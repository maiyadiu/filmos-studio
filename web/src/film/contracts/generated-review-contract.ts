// Generated from packages/filmos-review-contract/contract.v1.json. Do not edit.
export const REVIEW_CONTRACT_HASH = "4af5a8b136b8b84e430cbd4ea4681d3fb32ef4f2eaef4dc6c30ed7c9095f3615";
export const REVIEW_LANES = Object.freeze(["fast","core","architecture"]);
export const REVIEW_RETRY_CLASSES = Object.freeze(["retryable","non_retryable"]);
export const REVIEW_MAIN_STATES = Object.freeze(["OBSERVED_IN_USE","EVIDENCE_FROZEN","CODEX_ASSESSING","CHATGPT_ASSESSING","CONSENSUS_REVIEW","CONSENSUS_PROPOSED","CONSENSUS_REACHED","TASK_PACKAGE_FROZEN","CODEX_IMPLEMENTING","CODEX_FIXING","CODEX_LOCAL_ACCEPTED","WAITING_FOR_CHATGPT_REVIEW","CHANGES_REQUIRED","CANDIDATE_SUPERSEDED","EXTERNAL_APPROVED","CHATGPT_EXTERNAL_REVIEW","MACHINE_PASS","DUAL_APPROVED","PILOT_DEPLOYED","OBSERVING_IN_USE","EVIDENCE_REQUIRED","OWNER_DECISION_REQUIRED"]);
export const REVIEW_ARCHITECTURE_STATES = Object.freeze(["REQUIREMENT_OBSERVED","REQUIREMENT_DELTA_FROZEN","ARCHITECTURE_EVIDENCE_FROZEN","ARCHITECTURE_ASSESSMENTS_PENDING","OPTION_COMPARISON","OWNER_DECISION_REQUIRED","ARCHITECTURE_OPTION_ACCEPTED","CONSENSUS_PROPOSED","CONSENSUS_REACHED","TASK_PACKAGE_FROZEN","CODEX_IMPLEMENTING","CANDIDATE_UNDER_REVIEW","DUAL_APPROVED","PILOT_MIGRATION","PILOT_OBSERVATION","ARCHITECTURE_ADOPTED"]);
export const REVIEW_SUBMISSION_KEYS = Object.freeze(["submission_id","project_id","what_happened","expected_result","location","blocks_work","captured_at","risk","suggested_lane","allowed_change_scope","app_build_id","app_tree","route","context_snapshot","attachment_manifest"]);
export const REVIEW_SUBMISSION_RISK_KEYS = Object.freeze(["architecture_gap","requires_schema_change","requires_authority_change","data_loss","security","cost","provider_submit","migration","core_state"]);
export const REVIEW_RECEIPT_KEYS = Object.freeze(["schema_version","submission_id","formal_issue_id","project_id","lane","state","capture_schema","capture_hash","projection_content_hash","evidence_manifest_hash","entity_version","accepted_at","receipt_hash"]);
export const REVIEW_RECEIPT_SOURCE_BINDING_KEYS = Object.freeze(["source_identity_hash","bootstrap_receipt_hash"]);
export const REVIEW_SUBMISSION_PREFIX = "FILMOS-SUBMISSION";
export const REVIEW_ISSUE_PREFIX = "FILMOS-ISSUE";
export const REVIEW_ARCHITECTURE_ISSUE_PREFIX = "FILMOS-ARCH";
export const REVIEW_SUBMISSION_ID_PATTERN = new RegExp("^FILMOS-SUBMISSION-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
export const REVIEW_ISSUE_ID_PATTERN = new RegExp("^FILMOS-(?:ISSUE|ARCH)-[A-Za-z0-9-]{1,120}$");
export const REVIEW_PROJECT_ID_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
export const REVIEW_ERROR_CODE_PATTERN = new RegExp("^[A-Z0-9_]{1,96}$");
export const REVIEW_RETRYABLE_SIGNAL_PATTERN = new RegExp("(?:TIMEOUT|UNAVAILABLE|NOT_READY|CONNECTION|NETWORK|TEMPORARY|RETRY)");
export const REVIEW_DESKTOP_REQUEST_ID_PATTERN = new RegExp("^[A-Fa-f0-9-]{36}$");
export const REVIEW_DESKTOP_ACTIONS = Object.freeze({"chatgptHostRequest":{"required_keys":["action","requestId","operation","payload"],"operations":["publish_context","publish_handoff"],"maximum_payload_bytes":262144,"timeout_ms":15000},"reviewIssueRequest":{"required_keys":["action","requestId","payload"],"operations":[],"maximum_payload_bytes":524288,"timeout_ms":20000},"reviewIssueAttachmentRequest":{"required_keys":["action","requestId","submissionId","payload"],"operations":[],"maximum_payload_bytes":37748736,"timeout_ms":60000},"reviewIssueFinalizeRequest":{"required_keys":["action","requestId","submissionId","payload"],"operations":[],"maximum_payload_bytes":524288,"timeout_ms":20000},"reviewCenterRequest":{"required_keys":["action","requestId","operation","payload"],"operations":[],"maximum_payload_bytes":524288,"timeout_ms":15000}});

export type ReviewLane = "fast" | "core" | "architecture";
export type ReviewRetryClass = "retryable" | "non_retryable";
export type ReviewDesktopAction = keyof typeof REVIEW_DESKTOP_ACTIONS;

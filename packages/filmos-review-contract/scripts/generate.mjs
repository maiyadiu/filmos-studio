import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const contract = JSON.parse(readFileSync(resolve(packageRoot, "contract.v1.json"), "utf8"));
const canonical = JSON.stringify(sortValue(contract));
const contractHash = createHash("sha256").update(canonical).digest("hex");
validate(contract);

const js = [
  "// Generated from packages/filmos-review-contract/contract.v1.json. Do not edit.",
  `export const REVIEW_CONTRACT_HASH = ${JSON.stringify(contractHash)};`,
  `export const REVIEW_LANES = Object.freeze(${JSON.stringify(contract.lanes)});`,
  `export const REVIEW_RETRY_CLASSES = Object.freeze(${JSON.stringify(contract.retry_classes)});`,
  `export const REVIEW_MAIN_STATES = Object.freeze(${JSON.stringify(contract.states.main)});`,
  `export const REVIEW_ARCHITECTURE_STATES = Object.freeze(${JSON.stringify(contract.states.architecture)});`,
  `export const REVIEW_SUBMISSION_KEYS = Object.freeze(${JSON.stringify(contract.submission.required_keys)});`,
  `export const REVIEW_SUBMISSION_RISK_KEYS = Object.freeze(${JSON.stringify(contract.submission.risk_keys)});`,
  `export const REVIEW_RECEIPT_KEYS = Object.freeze(${JSON.stringify(contract.formal_issue_receipt.required_keys)});`,
  `export const REVIEW_RECEIPT_SOURCE_BINDING_KEYS = Object.freeze(${JSON.stringify(contract.formal_issue_receipt.source_binding_keys)});`,
  `export const REVIEW_SUBMISSION_PREFIX = ${JSON.stringify(contract.ids.submission_prefix)};`,
  `export const REVIEW_ISSUE_PREFIX = ${JSON.stringify(contract.ids.issue_prefix)};`,
  `export const REVIEW_ARCHITECTURE_ISSUE_PREFIX = ${JSON.stringify(contract.ids.architecture_issue_prefix)};`,
  `export const REVIEW_SUBMISSION_ID_PATTERN = new RegExp(${JSON.stringify(contract.ids.submission_pattern)});`,
  `export const REVIEW_ISSUE_ID_PATTERN = new RegExp(${JSON.stringify(contract.ids.any_issue_pattern)});`,
  `export const REVIEW_PROJECT_ID_PATTERN = new RegExp(${JSON.stringify(contract.project_scope.pattern)});`,
  `export const REVIEW_ERROR_CODE_PATTERN = new RegExp(${JSON.stringify(contract.error_envelope.code_pattern)});`,
  `export const REVIEW_RETRYABLE_SIGNAL_PATTERN = new RegExp(${JSON.stringify(contract.error_envelope.retryable_signal_pattern)});`,
  `export const REVIEW_DESKTOP_REQUEST_ID_PATTERN = new RegExp(${JSON.stringify(contract.desktop_rpc.request_id_pattern)});`,
  `export const REVIEW_DESKTOP_ACTIONS = Object.freeze(${JSON.stringify(contract.desktop_rpc.actions)});`,
  "",
].join("\n");
const ts = `${js}\nexport type ReviewLane = ${typescriptUnion(contract.lanes)};\nexport type ReviewRetryClass = ${typescriptUnion(contract.retry_classes)};\nexport type ReviewDesktopAction = keyof typeof REVIEW_DESKTOP_ACTIONS;\n`;
const swift = `// Generated from packages/filmos-review-contract/contract.v1.json. Do not edit.\nimport Foundation\n\npublic enum ReviewProtocolContract {\n    public static let contractHash = ${swiftString(contractHash)}\n    public static let lanes = Set(${swiftArray(contract.lanes)})\n    public static let submissionKeys = Set(${swiftArray(contract.submission.required_keys)})\n    public static let submissionRiskKeys = Set(${swiftArray(contract.submission.risk_keys)})\n    public static let submissionPrefix = ${swiftString(contract.ids.submission_prefix)}\n    public static let submissionIDPattern = ${swiftString(contract.ids.submission_pattern)}\n    public static let issueIDPattern = ${swiftString(contract.ids.any_issue_pattern)}\n    public static let projectIDPattern = ${swiftString(contract.project_scope.pattern)}\n    public static let errorCodePattern = ${swiftString(contract.error_envelope.code_pattern)}\n    public static let desktopRequestIDPattern = ${swiftString(contract.desktop_rpc.request_id_pattern)}\n    public static let desktopActions = ${swiftDesktopActions(contract.desktop_rpc.actions)}\n}\n\npublic struct ReviewDesktopActionContract: Sendable {\n    public let requiredKeys: Set<String>\n    public let operations: Set<String>\n    public let maximumPayloadBytes: Int\n    public let timeoutMilliseconds: Int\n}\n`;

const outputs = new Map([
  [resolve(repositoryRoot, "services/filmos-review-bus/src/generated-review-contract.mjs"), js],
  [resolve(repositoryRoot, "extensions/filmos-review-bridge/src/generated-review-contract.mjs"), js],
  [resolve(repositoryRoot, "services/filmos-chatgpt-app/src/generated-review-contract.ts"), ts],
  [resolve(repositoryRoot, "web/src/film/contracts/generated-review-contract.ts"), ts],
  [resolve(repositoryRoot, "desktop/macos/Sources/FilmOSDesktopCore/ReviewProtocolContract.generated.swift"), swift],
]);

const check = process.argv.includes("--check");
for (const [path, content] of outputs) {
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) throw new Error(`STALE_REVIEW_CONTRACT_BINDING:${path}`);
  } else {
    writeFileSync(path, content);
  }
}

function validate(value) {
  if (value.schema_version !== "filmos.canonical-review-contract.v1") throw new Error("INVALID_REVIEW_CONTRACT_SCHEMA");
  if (!Array.isArray(value.lanes) || value.lanes.join(",") !== "fast,core,architecture") throw new Error("INVALID_REVIEW_LANES");
  for (const pattern of [value.ids.submission_pattern, value.ids.any_issue_pattern, value.project_scope.pattern, value.error_envelope.code_pattern, value.desktop_rpc.request_id_pattern]) new RegExp(pattern);
  if (!value.submission.required_keys.includes("submission_id") || !value.formal_issue_receipt.required_keys.includes("receipt_hash")) throw new Error("INCOMPLETE_REVIEW_CONTRACT");
  if (Object.keys(value.desktop_rpc.actions).length !== 5) throw new Error("INCOMPLETE_DESKTOP_RPC_CONTRACT");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

function swiftString(value) { return JSON.stringify(value); }
function swiftArray(values) { return `[${values.map(swiftString).join(", ")}]`; }
function typescriptUnion(values) { return values.map(JSON.stringify).join(" | "); }
function swiftDesktopActions(actions) {
  const entries = Object.entries(actions).map(([name, value]) => `${swiftString(name)}: ReviewDesktopActionContract(requiredKeys: Set(${swiftArray(value.required_keys)}), operations: Set(${swiftArray(value.operations)}), maximumPayloadBytes: ${value.maximum_payload_bytes}, timeoutMilliseconds: ${value.timeout_ms})`);
  return `[${entries.join(",\n        ")}]`;
}

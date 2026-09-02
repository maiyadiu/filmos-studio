import { createHash } from "node:crypto";

import { exactObject, problem, sha256 } from "./canonical.mjs";
import {
  REVIEW_LANES,
  REVIEW_PROJECT_ID_PATTERN,
  REVIEW_SUBMISSION_ID_PATTERN,
  REVIEW_SUBMISSION_KEYS,
  REVIEW_SUBMISSION_PREFIX,
  REVIEW_SUBMISSION_RISK_KEYS,
} from "./generated-review-contract.mjs";

export const SUBMISSION_SCHEMA = "filmos.review-submission.capture.v1";
export const RECEIPT_SCHEMA = "filmos.review-submission.receipt.v1";
export const ATTACHMENT_RECEIPT_SCHEMA = "filmos.review-submission.attachment-receipt.v1";
export const INSTALLED_SUBMISSION_SOURCE_SCHEMA = "filmos.installed-source-identity.v1";

export const STAGE_A_BOOTSTRAP = Object.freeze({
  submission_id: `${REVIEW_SUBMISSION_PREFIX}-b3274782-30a0-44a1-a05e-01730678da8b`,
  base_commit: "8951d975a9803e5750eb6399948587f651ce4ce4",
  base_tree: "52f2a6853ff89a9aa231b6d5b00f6f0712a20b97",
  build_id: "candidate-8951d975-52f2a685",
  migration_version: "filmos.review-intake-stage-a.v1",
});

const attachmentManifestKeys = ["attachment_id", "media_type", "original_name", "size_bytes", "sha256", "captured_at"];
const riskKeys = new Set(REVIEW_SUBMISSION_RISK_KEYS);

export function normalizeStageASubmission(input, bootstrap = STAGE_A_BOOTSTRAP) {
  requireSubmissionId(input.submission_id);
  if (input.submission_id !== bootstrap.submission_id) throw problem("INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", 503);
  return normalizeSubmission(input, {
    schema_version: "filmos.source-identity.bootstrap.v1",
    build_id: bootstrap.build_id,
    commit: bootstrap.base_commit,
    tree: bootstrap.base_tree,
  });
}

export function normalizeInstalledSubmission(input, installedSourceIdentity) {
  requireSubmissionId(input?.submission_id);
  if (!installedSourceIdentity || installedSourceIdentity.schema_version !== INSTALLED_SUBMISSION_SOURCE_SCHEMA
    || !/^[a-f0-9]{64}$/.test(String(installedSourceIdentity.content_hash ?? ""))) {
    throw problem("INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", 503);
  }
  if (input.app_build_id !== installedSourceIdentity.build_id || input.app_tree !== installedSourceIdentity.tree) {
    throw problem("APP_RUNTIME_IDENTITY_MISMATCH", "APP_RUNTIME_IDENTITY_MISMATCH", 503);
  }
  return normalizeSubmission(input, installedSourceIdentity);
}

function normalizeSubmission(input, sourceIdentity) {
  exactObject(input, REVIEW_SUBMISSION_KEYS);
  requireBoundedString(input.project_id, "INVALID_PROJECT_ID", 128, REVIEW_PROJECT_ID_PATTERN);
  requireBoundedString(input.what_happened, "INVALID_WHAT_HAPPENED", 4_000);
  requireBoundedString(input.expected_result, "INVALID_EXPECTED_RESULT", 4_000);
  requireBoundedString(input.location, "INVALID_LOCATION", 2_048);
  if (typeof input.blocks_work !== "boolean") throw problem("INVALID_BLOCKS_WORK");
  requireTimestamp(input.captured_at, "INVALID_CAPTURED_AT");
  if (!input.risk || typeof input.risk !== "object" || Array.isArray(input.risk)
    || Object.keys(input.risk).some((key) => !riskKeys.has(key))
    || Object.values(input.risk).some((value) => typeof value !== "boolean")) throw problem("INVALID_RISK");
  if (input.suggested_lane !== null && !REVIEW_LANES.includes(input.suggested_lane)) throw problem("INVALID_SUGGESTED_LANE");
  if (!Array.isArray(input.allowed_change_scope) || input.allowed_change_scope.some((value) => typeof value !== "string" || !value.trim() || value.length > 512)) throw problem("INVALID_ALLOWED_CHANGE_SCOPE");
  if (input.app_build_id !== null) requireBoundedString(input.app_build_id, "INVALID_APP_BUILD_ID", 160, /^[A-Za-z0-9._-]{1,160}$/);
  if (input.app_tree !== null && !/^[a-f0-9]{40,64}$/.test(input.app_tree)) throw problem("INVALID_APP_TREE");
  if (input.route !== null) requireBoundedString(input.route, "INVALID_ROUTE", 2_048);
  if (input.context_snapshot !== null && (!input.context_snapshot || typeof input.context_snapshot !== "object" || Array.isArray(input.context_snapshot))) throw problem("INVALID_CONTEXT_SNAPSHOT");
  if (!Array.isArray(input.attachment_manifest) || input.attachment_manifest.length > 5) throw problem("INVALID_ATTACHMENT_MANIFEST");

  const attachmentIds = new Set();
  const manifest = input.attachment_manifest.map((item) => {
    exactObject(item, attachmentManifestKeys);
    requireAttachmentId(item.attachment_id);
    if (attachmentIds.has(item.attachment_id)) throw problem("DUPLICATE_ATTACHMENT_ID");
    attachmentIds.add(item.attachment_id);
    requireMediaType(item.media_type);
    requireBoundedString(item.original_name, "INVALID_ATTACHMENT_NAME", 255);
    const maximum = item.media_type === "text/plain" ? 1024 * 1024 : 25 * 1024 * 1024;
    if (!Number.isInteger(item.size_bytes) || item.size_bytes < 1 || item.size_bytes > maximum) throw problem("INVALID_ATTACHMENT_SIZE");
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw problem("INVALID_ATTACHMENT_HASH");
    requireTimestamp(item.captured_at, "INVALID_ATTACHMENT_CAPTURE_TIME");
    return { ...item, original_name: item.original_name.trim() };
  }).sort((left, right) => left.attachment_id.localeCompare(right.attachment_id));

  const payload = {
    schema_version: SUBMISSION_SCHEMA,
    submission_id: input.submission_id,
    project_id: input.project_id,
    what_happened: input.what_happened.trim(),
    expected_result: input.expected_result.trim(),
    location: input.location.trim(),
    blocks_work: input.blocks_work,
    captured_at: input.captured_at,
    risk: input.risk,
    suggested_lane: input.suggested_lane,
    allowed_change_scope: input.allowed_change_scope.map((value) => value.trim()),
    app_build_id: input.app_build_id,
    app_tree: input.app_tree,
    route: input.route,
    context_snapshot: input.context_snapshot,
    source_identity: sourceIdentity,
    attachment_manifest: manifest,
  };
  return { payload, captureHash: sha256(payload) };
}

export function normalizeStagedAttachment(input) {
  exactObject(input, ["attachment_id", "media_type", "original_name", "size_bytes", "sha256", "base64", "captured_at"]);
  requireAttachmentId(input.attachment_id);
  requireMediaType(input.media_type);
  requireBoundedString(input.original_name, "INVALID_ATTACHMENT_NAME", 255);
  if (!Number.isInteger(input.size_bytes) || input.size_bytes < 1) throw problem("INVALID_ATTACHMENT_SIZE");
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw problem("INVALID_ATTACHMENT_HASH");
  if (typeof input.base64 !== "string" || input.base64.length === 0 || input.base64.length > 35_000_000) throw problem("INVALID_ATTACHMENT_BYTES");
  requireTimestamp(input.captured_at, "INVALID_ATTACHMENT_CAPTURE_TIME");
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.length !== input.size_bytes || bytes.toString("base64").replace(/=+$/, "") !== input.base64.replace(/=+$/, "")) throw problem("ATTACHMENT_INTEGRITY_FAILURE", "ATTACHMENT_INTEGRITY_FAILURE", 422);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== input.sha256) throw problem("ATTACHMENT_INTEGRITY_FAILURE", "ATTACHMENT_INTEGRITY_FAILURE", 422);
  if (input.media_type === "text/plain") {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw problem("INVALID_ATTACHMENT_BYTES"); }
  }
  return { ...input, original_name: input.original_name.trim(), bytes };
}

export function submissionSuffix(submissionId) {
  requireSubmissionId(submissionId);
  return submissionId.slice(REVIEW_SUBMISSION_PREFIX.length + 1);
}

export function requireSubmissionId(value) {
  if (!REVIEW_SUBMISSION_ID_PATTERN.test(String(value ?? ""))) throw problem("INVALID_SUBMISSION_ID");
}

export function requireAttachmentId(value) {
  if (!/^attachment-[A-Za-z0-9-]{1,120}$/.test(String(value ?? ""))) throw problem("INVALID_ATTACHMENT_ID");
}

function requireMediaType(value) {
  if (typeof value !== "string" || !(/^(image|video)\/[A-Za-z0-9.+-]{1,80}$/.test(value)
    || ["text/plain", "application/json"].includes(value))) throw problem("INVALID_ATTACHMENT_MEDIA_TYPE");
}

function requireTimestamp(value, code) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw problem(code);
}

function requireBoundedString(value, code, maximum, pattern = null) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || (pattern && !pattern.test(value))) throw problem(code);
}

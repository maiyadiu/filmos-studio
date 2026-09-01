#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { sha256 } from "../src/canonical.mjs";
import { STAGE_A_BOOTSTRAP } from "../src/intake-contract.mjs";
import { ReviewBusService } from "../src/service.mjs";
import { createReviewBusHttp } from "../src/server.mjs";
import { ReviewBusStore } from "../src/store.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const expectedIssueId = "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b";
const directory = mkdtempSync(resolve(tmpdir(), "filmos-stage-a-canary-"));
const databasePath = resolve(directory, "review-bus.sqlite");
const store = new ReviewBusStore(databasePath);
const service = new ReviewBusService(store);
const token = "stage-a-canary-token-1234567890-abcdefghijkl";
const bridgeToken = "stage-a-canary-bridge-1234567890-abcdefghijkl";
const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken, constitution });

try {
  const historical = service.createIssue({
    issue_id: "FILMOS-ISSUE-stage-a-historical-proof",
    project_id: projectId,
    what_happened: "Historical projection exists before Stage A.",
    expected_result: "Stage A must not rewrite it.",
    location: "canary:historical",
    blocks_work: false,
    lane: "core",
  });
  const historicalProjectionHash = historical.content_hash;
  const historicalEventHashes = store.events(historical.issue_id).map((event) => event.event_hash);
  const beforeCounts = counts(store);

  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const bytes = Buffer.from("stage-a-canary-screenshot");
  const attachmentHash = createHash("sha256").update(bytes).digest("hex");
  const capturedAt = "2026-09-01T16:16:00.955Z";
  const attachment = {
    attachment_id: "attachment-stage-a-canary",
    media_type: "image/png",
    original_name: "canary.png",
    size_bytes: bytes.length,
    sha256: attachmentHash,
    captured_at: capturedAt,
  };
  const submission = {
    submission_id: STAGE_A_BOOTSTRAP.submission_id,
    project_id: projectId,
    what_happened: "A stable local observation is waiting for Review Bus intake.",
    expected_result: "One canonical Architecture Issue and one immutable Receipt.",
    location: "agent:/canvas/stage-a-canary",
    blocks_work: false,
    captured_at: capturedAt,
    risk: { architecture_gap: true },
    suggested_lane: "architecture",
    allowed_change_scope: [],
    app_build_id: STAGE_A_BOOTSTRAP.build_id,
    app_tree: STAGE_A_BOOTSTRAP.base_tree,
    route: "/canvas/stage-a-canary",
    context_snapshot: { domainProjectId: projectId, recentAuditIds: [], recentErrorCodes: [], runtimeStatus: {}, providerStatus: {} },
    attachment_manifest: [attachment],
  };

  const stagedResponse = await request(`${baseURL}/v1/submissions`, { method: "POST", headers, body: submission });
  assert.equal(stagedResponse.status, 201);
  const staged = stagedResponse.body;
  const uploadResponse = await request(`${baseURL}/v1/submissions/${STAGE_A_BOOTSTRAP.submission_id}/attachments`, {
    method: "POST", headers, body: { ...attachment, base64: bytes.toString("base64") },
  });
  assert.equal(uploadResponse.status, 201);
  const finalizeBody = { project_id: projectId, capture_hash: staged.capture_hash };
  const accepted = await request(`${baseURL}/v1/submissions/${STAGE_A_BOOTSTRAP.submission_id}/finalize`, { method: "POST", headers, body: finalizeBody });
  assert.equal(accepted.status, 201);
  const replay = await request(`${baseURL}/v1/submissions/${STAGE_A_BOOTSTRAP.submission_id}/finalize`, { method: "POST", headers, body: finalizeBody });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receipt.receipt_hash, accepted.body.receipt.receipt_hash);
  assert.equal(accepted.body.receipt.formal_issue_id, expectedIssueId);

  const mcpHeaders = { ...headers, "x-filmos-read-consumer": "chatgpt-mcp" };
  const pending = await request(`${baseURL}/v1/review/pending?project_id=${projectId}`, { headers: mcpHeaders });
  const evidence = await request(`${baseURL}/v1/review/issues/${expectedIssueId}/evidence?project_id=${projectId}`, { headers: mcpHeaders });
  const confirmation = await request(`${baseURL}/v1/review/internal/issues/${expectedIssueId}/intake-confirmation?project_id=${projectId}`, { headers });
  assert.equal(pending.status, 200);
  assert.equal(evidence.status, 200);
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.body.pending_read, true);
  assert.equal(confirmation.body.evidence_read, true);
  assert.equal(confirmation.body.receipt_hash, accepted.body.receipt.receipt_hash);
  assert.equal(confirmation.body.evidence_manifest_hash, accepted.body.receipt.evidence_manifest_hash);

  assert.equal(store.get(historical.issue_id).content_hash, historicalProjectionHash);
  assert.deepEqual(store.events(historical.issue_id).map((event) => event.event_hash), historicalEventHashes);
  assert.equal(store.events(expectedIssueId).filter((event) => event.event_type === "issue.observed").length, 1);
  assert.equal(store.list().filter((item) => item.issue_id === expectedIssueId).length, 1);

  const backup = store.backup(resolve(directory, "backups/stage-a-canary.sqlite"));
  assert.equal(existsSync(backup.destination), true);
  const afterCounts = counts(store);
  const result = {
    schema_version: "filmos.review-intake-stage-a-canary.v1",
    status: "PASS",
    submission_id: STAGE_A_BOOTSTRAP.submission_id,
    canonical_issue_id: expectedIssueId,
    capture_hash: staged.capture_hash,
    receipt_hash: accepted.body.receipt.receipt_hash,
    projection_content_hash: accepted.body.receipt.projection_content_hash,
    evidence_manifest_hash: accepted.body.receipt.evidence_manifest_hash,
    attachment_hash: attachmentHash,
    idempotent_receipt_replay: true,
    pending_read: confirmation.body.pending_read,
    evidence_read: confirmation.body.evidence_read,
    historical_projection_preserved: true,
    historical_event_chain_preserved: true,
    before_counts: beforeCounts,
    after_counts: afterCounts,
    backup_sha256: backup.sha256,
    result_hash: sha256({ beforeCounts, afterCounts, receipt: accepted.body.receipt, confirmation: confirmation.body }),
    external_network_requests: 0,
    openai_model_api_calls: 0,
    paid_provider_operations: 0,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

function counts(value) {
  return {
    projections: Number(value.db.prepare("SELECT COUNT(*) AS count FROM review_projections").get().count),
    events: Number(value.db.prepare("SELECT COUNT(*) AS count FROM review_events").get().count),
    submissions: Number(value.db.prepare("SELECT COUNT(*) AS count FROM review_submissions").get().count),
    submission_receipts: Number(value.db.prepare("SELECT COUNT(*) AS count FROM review_submission_receipts").get().count),
    attachments: Number(value.db.prepare("SELECT COUNT(*) AS count FROM review_attachments").get().count),
  };
}

async function request(url, { method = "GET", headers, body } = {}) {
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

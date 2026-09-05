import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { constants as sqliteConstants, DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256, problem } from "./canonical.mjs";
import {
  ARCHITECTURE_PROTOCOL_VERSION,
  ARCHITECTURE_STATE_MAPPING_VERSION,
  ARCHITECTURE_TRANSITION_CONTRACT_HASH,
  architectureSemanticProjection,
  architectureTransitionPayload,
} from "./architecture-protocol.mjs";
import { ATTACHMENT_RECEIPT_SCHEMA, INSTALLED_SUBMISSION_SOURCE_SCHEMA, RECEIPT_SCHEMA } from "./intake-contract.mjs";

export const REVIEW_BUS_RUNTIME_MODE_NORMAL = "normal";
export const REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL = "assessment-seal";
export const REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ = "external-read";

export function assertExternalReadRuntimeCapability() {
  if (typeof DatabaseSync.prototype.setAuthorizer !== "function"
    || ["SQLITE_OK", "SQLITE_DENY", "SQLITE_INSERT", "SQLITE_UPDATE", "SQLITE_PRAGMA", "SQLITE_FUNCTION", "SQLITE_READ", "SQLITE_RECURSIVE", "SQLITE_SELECT", "SQLITE_TRANSACTION"]
      .some((key) => typeof sqliteConstants[key] !== "number")) {
    throw problem("EXTERNAL_READ_RUNTIME_NODE_CAPABILITY_REQUIRED", "Node.js >= 24.10.0 with SQLite authorizer support is required", 503);
  }
}

const REQUIRED_SEAL_SCHEMA = Object.freeze([
  ["table", "review_events"],
  ["index", "review_events_issue_sequence"],
  ["table", "review_projections"],
  ["table", "review_submissions"],
  ["index", "review_submissions_project_created"],
  ["table", "review_staged_attachments"],
  ["index", "review_staged_attachments_submission"],
  ["table", "review_submission_receipts"],
  ["table", "review_bootstrap_receipts"],
  ["table", "review_read_receipts"],
  ["table", "review_codex_coordination_results"],
  ["table", "bridge_challenges"],
  ["table", "local_configuration"],
  ["table", "review_attachments"],
  ["index", "review_attachments_issue"],
  ["table", "bridge_pairing_codes"],
  ["table", "bridge_clients"],
  ["trigger", "review_events_no_update"],
  ["trigger", "review_events_no_delete"],
  ["trigger", "review_submission_receipts_no_update"],
  ["trigger", "review_submission_receipts_no_delete"],
  ["trigger", "review_bootstrap_receipts_no_update"],
  ["trigger", "review_bootstrap_receipts_no_delete"],
  ["trigger", "review_codex_coordination_results_no_update"],
  ["trigger", "review_codex_coordination_results_no_delete"],
]);

export class ReviewBusStore {
  constructor(path = ":memory:", options = {}) {
    const runtimeMode = options.runtimeMode ?? REVIEW_BUS_RUNTIME_MODE_NORMAL;
    if (![REVIEW_BUS_RUNTIME_MODE_NORMAL, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ].includes(runtimeMode)) {
      throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
    }
    // Reject unsupported runtimes before even inspecting the bound database.
    if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) assertExternalReadRuntimeCapability();
    this.runtimeMode = runtimeMode;
    this.sealTarget = null;
    this.sealSnapshot = null;
    this.sealDatabaseIdentity = null;
    this.sealDatabaseBinding = null;
    this.externalReadPolicy = null;
    this.externalReadOperations = [];

    if ([REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ].includes(runtimeMode)) {
      const target = normalizeSealTarget(options.sealTarget);
      const binding = normalizeSealBinding(options.sealBinding);
      const externalReadPolicy = runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ
        ? normalizeExternalReadPolicy(options.externalReadPolicy, target, binding)
        : null;
      const preflightIdentity = readCanonicalSealDatabaseFiles(path, { allowMissingWal: true });
      assertStableSealMainIdentity(preflightIdentity, binding);
      if (externalReadPolicy) assertExternalReadDatabaseIdentity(preflightIdentity, externalReadPolicy.databaseIdentity);
      const readOnlyDb = new DatabaseSync(preflightIdentity.path, { readOnly: true });
      let preflightSnapshot;
      try {
        preflightSnapshot = inspectOpenSealDatabase(readOnlyDb, preflightIdentity, target, { allowCodexSealed: true });
        if (externalReadPolicy) assertExternalReadTarget(preflightSnapshot, externalReadPolicy);
      } finally {
        readOnlyDb.close();
      }
      assertSealSnapshotCompatibility(preflightSnapshot, binding);
      assertSealImmutableBindings(preflightSnapshot, binding);
      if (preflightSnapshot.sealState === "PRISTINE_EMPTY") {
        assertPristineSealPhysicalBinding(preflightIdentity, binding);
        assertPristineSealSnapshots(preflightSnapshot, binding);
      }

      const beforeWritableIdentity = readCanonicalSealDatabaseFiles(path, { allowMissingWal: true });
      if (externalReadPolicy) assertExternalReadDatabaseIdentity(beforeWritableIdentity, externalReadPolicy.databaseIdentity);
      if (preflightSnapshot.sealState === "PRISTINE_EMPTY") assertSameSealPreopenIdentity(preflightIdentity, beforeWritableIdentity);
      else assertSameSealMainBytes(preflightIdentity, beforeWritableIdentity);
      this.path = beforeWritableIdentity.path;
      this.evidenceRoot = beforeWritableIdentity.evidenceRoot;
      this.db = new DatabaseSync(this.path);
      try {
        if (externalReadPolicy) installExternalReadAuthorizer(this.db);
        const databaseIdentity = readCanonicalSealDatabaseFiles(path, { allowMissingWal: true });
        assertStableSealMainIdentity(databaseIdentity, binding);
        if (preflightSnapshot.sealState === "PRISTINE_EMPTY") assertPristineSealPhysicalBinding(databaseIdentity, binding);
        const snapshot = inspectOpenSealDatabase(this.db, databaseIdentity, target, { allowCodexSealed: true });
        if (externalReadPolicy) assertExternalReadTarget(snapshot, externalReadPolicy);
        assertSealSnapshotCompatibility(snapshot, binding);
        assertSealImmutableBindings(snapshot, binding);
        if (snapshot.sealState !== preflightSnapshot.sealState) throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
        if (snapshot.sealState === "PRISTINE_EMPTY") assertPristineSealSnapshots(snapshot, binding);
        this.sealTarget = Object.freeze({ ...target });
        this.sealSnapshot = Object.freeze(snapshot);
        this.sealDatabaseIdentity = Object.freeze(databaseIdentity);
        this.sealDatabaseBinding = Object.freeze({ ...binding });
        this.externalReadPolicy = externalReadPolicy ? Object.freeze(externalReadPolicy) : null;
        return;
      } catch (error) {
        this.db.close();
        throw error;
      }
    }

    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
    this.evidenceRoot = path === ":memory:"
      ? mkdtempSync(resolve(tmpdir(), "filmos-review-evidence-"))
      : resolve(dirname(path), "evidence");
    mkdirSync(this.evidenceRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.evidenceRoot, 0o700);
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        issue_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_events_issue_sequence ON review_events(issue_id, sequence);
      CREATE TABLE IF NOT EXISTS review_projections (
        issue_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        lane TEXT NOT NULL,
        entity_version INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_submissions (
        submission_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        capture_schema TEXT NOT NULL,
        capture_hash TEXT NOT NULL,
        capture_json TEXT NOT NULL,
        state TEXT NOT NULL,
        formal_issue_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_submissions_project_created ON review_submissions(project_id, created_at);
      CREATE TABLE IF NOT EXISTS review_staged_attachments (
        attachment_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        original_name TEXT NOT NULL,
        local_path TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        staged_at TEXT NOT NULL,
        bound_issue_id TEXT,
        bound_at TEXT
      );
      CREATE INDEX IF NOT EXISTS review_staged_attachments_submission ON review_staged_attachments(submission_id, attachment_id);
      CREATE TABLE IF NOT EXISTS review_submission_receipts (
        submission_id TEXT PRIMARY KEY,
        formal_issue_id TEXT NOT NULL UNIQUE,
        receipt_json TEXT NOT NULL,
        receipt_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_bootstrap_receipts (
        bootstrap_key TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL UNIQUE,
        migration_version TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        receipt_hash TEXT NOT NULL UNIQUE,
        consumed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_read_receipts (
        issue_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        consumer TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        projection_content_hash TEXT NOT NULL,
        evidence_manifest_hash TEXT,
        read_at TEXT NOT NULL,
        PRIMARY KEY(issue_id, consumer, tool_name)
      );
      CREATE TABLE IF NOT EXISTS review_codex_coordination_results (
        issue_id TEXT NOT NULL,
        coordination_key TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        action TEXT NOT NULL,
        result_json TEXT NOT NULL,
        result_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(issue_id, coordination_key),
        UNIQUE(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS bridge_challenges (
        challenge_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        candidate_id TEXT,
        candidate_commit TEXT,
        nonce_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS local_configuration (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_attachments (
        attachment_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        original_name TEXT NOT NULL,
        redacted_alias TEXT NOT NULL,
        local_path TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE(issue_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS review_attachments_issue ON review_attachments(issue_id, captured_at);
      CREATE TABLE IF NOT EXISTS bridge_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TRIGGER IF NOT EXISTS review_events_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT, 'REVIEW_EVENT_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS review_events_no_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT, 'REVIEW_EVENT_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS review_submission_receipts_no_update BEFORE UPDATE ON review_submission_receipts BEGIN SELECT RAISE(ABORT, 'SUBMISSION_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS review_submission_receipts_no_delete BEFORE DELETE ON review_submission_receipts BEGIN SELECT RAISE(ABORT, 'SUBMISSION_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS review_bootstrap_receipts_no_update BEFORE UPDATE ON review_bootstrap_receipts BEGIN SELECT RAISE(ABORT, 'BOOTSTRAP_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS review_bootstrap_receipts_no_delete BEFORE DELETE ON review_bootstrap_receipts BEGIN SELECT RAISE(ABORT, 'BOOTSTRAP_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS review_codex_coordination_results_no_update BEFORE UPDATE ON review_codex_coordination_results BEGIN SELECT RAISE(ABORT, 'CODEX_COORDINATION_RESULT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS review_codex_coordination_results_no_delete BEFORE DELETE ON review_codex_coordination_results BEGIN SELECT RAISE(ABORT, 'CODEX_COORDINATION_RESULT_IMMUTABLE'); END;
    `);
  }

  close() { this.db.close(); }

  refreshSealSnapshot() {
    if (![REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ].includes(this.runtimeMode)
      || !this.sealTarget || !this.sealDatabaseBinding) {
      throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
    }
    const databaseIdentity = readCanonicalSealDatabaseFiles(this.path, { allowMissingWal: true });
    assertStableSealMainIdentity(databaseIdentity, this.sealDatabaseBinding);
    const snapshot = inspectOpenSealDatabase(this.db, databaseIdentity, this.sealTarget, { allowCodexSealed: true });
    if (this.runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) assertExternalReadTarget(snapshot, this.externalReadPolicy);
    assertSealSnapshotCompatibility(snapshot, this.sealDatabaseBinding);
    assertSealImmutableBindings(snapshot, this.sealDatabaseBinding);
    if (snapshot.sealState === "PRISTINE_EMPTY") {
      assertPristineSealPhysicalBinding(databaseIdentity, this.sealDatabaseBinding);
      assertPristineSealSnapshots(snapshot, this.sealDatabaseBinding);
    }
    this.sealSnapshot = Object.freeze(snapshot);
    this.sealDatabaseIdentity = Object.freeze(databaseIdentity);
    return this.sealSnapshot;
  }

  withSealTargetTransaction(apply) {
    if (this.runtimeMode !== REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL || !this.sealTarget || typeof apply !== "function") {
      throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const databaseIdentity = readCanonicalSealDatabaseFiles(this.path, { allowMissingWal: true });
      assertStableSealMainIdentity(databaseIdentity, this.sealDatabaseBinding);
      const before = inspectOpenSealDatabase(this.db, databaseIdentity, this.sealTarget, { allowCodexSealed: true });
      assertSealSnapshotCompatibility(before, this.sealDatabaseBinding);
      assertSealImmutableBindings(before, this.sealDatabaseBinding);
      if (before.sealState === "PRISTINE_EMPTY") {
        assertPristineSealPhysicalBinding(databaseIdentity, this.sealDatabaseBinding);
        assertPristineSealSnapshots(before, this.sealDatabaseBinding);
      }
      const value = apply();
      const after = inspectOpenSealDatabase(this.db, databaseIdentity, this.sealTarget, { allowCodexSealed: true });
      assertSealSnapshotCompatibility(after, this.sealDatabaseBinding);
      assertSealImmutableBindings(after, this.sealDatabaseBinding);
      if (after.sealState !== "CODEX_SEALED_SUCCESSOR") throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
      this.db.exec("COMMIT");
      const committed = this.refreshSealSnapshot();
      if (committed.sealState !== "CODEX_SEALED_SUCCESSOR") throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(issueId) {
    const row = this.db.prepare("SELECT document_json FROM review_projections WHERE issue_id = ?").get(issueId);
    return row ? JSON.parse(row.document_json) : null;
  }

  list({ projectId, states } = {}) {
    const rows = projectId
      ? this.db.prepare("SELECT document_json FROM review_projections WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
      : this.db.prepare("SELECT document_json FROM review_projections ORDER BY updated_at DESC").all();
    return rows.map((row) => JSON.parse(row.document_json)).filter((item) => !states || states.includes(item.state));
  }

  stageABootstrapAvailableFor(submissionId) {
    if (this.db.prepare("SELECT 1 AS present FROM review_submissions WHERE submission_id = ?").get(submissionId)) return true;
    return !this.db.prepare("SELECT 1 AS present FROM review_bootstrap_receipts LIMIT 1").get();
  }

  stageSubmission({ submissionId, projectId, captureSchema, captureHash, capturePayload, now = new Date() }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM review_submissions WHERE submission_id = ?").get(submissionId);
      if (existing) {
        if (existing.project_id !== projectId || existing.capture_hash !== captureHash) throw problem("SUBMISSION_IDEMPOTENCY_CONFLICT");
        const result = this.submissionStatus(submissionId);
        this.db.exec("COMMIT");
        return { ...result, idempotent_replay: true };
      }
      const timestamp = now.toISOString();
      this.db.prepare(`INSERT INTO review_submissions(submission_id,project_id,capture_schema,capture_hash,capture_json,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(submissionId, projectId, captureSchema, captureHash, canonicalJson(capturePayload), "STAGED", timestamp, timestamp);
      const result = this.submissionStatus(submissionId);
      this.db.exec("COMMIT");
      return { ...result, idempotent_replay: false };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submissionStatus(submissionId) {
    const row = this.db.prepare("SELECT * FROM review_submissions WHERE submission_id = ?").get(submissionId);
    if (!row) throw problem("SUBMISSION_NOT_FOUND", "SUBMISSION_NOT_FOUND", 404);
    const receiptRow = this.db.prepare("SELECT receipt_json FROM review_submission_receipts WHERE submission_id = ?").get(submissionId);
    return {
      submission_id: row.submission_id,
      project_id: row.project_id,
      capture_schema: row.capture_schema,
      capture_hash: row.capture_hash,
      state: row.state,
      formal_issue_id: row.formal_issue_id ?? null,
      attachment_count: this.db.prepare("SELECT COUNT(*) AS count FROM review_staged_attachments WHERE submission_id = ?").get(submissionId).count,
      receipt: receiptRow ? JSON.parse(receiptRow.receipt_json) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  stageAttachment({ submissionId, attachmentId, mediaType, originalName, sizeBytes, digest, bytes, capturedAt, now = new Date() }) {
    const submission = this.db.prepare("SELECT capture_json,state FROM review_submissions WHERE submission_id = ?").get(submissionId);
    if (!submission) throw problem("SUBMISSION_NOT_FOUND", "SUBMISSION_NOT_FOUND", 404);
    if (submission.state !== "STAGED") throw problem("SUBMISSION_ALREADY_FINALIZED");
    const existing = this.db.prepare("SELECT * FROM review_staged_attachments WHERE attachment_id = ?").get(attachmentId);
    if (existing) {
      if (existing.submission_id !== submissionId || existing.sha256 !== digest || Number(existing.size_bytes) !== sizeBytes) throw problem("ATTACHMENT_ID_CONFLICT");
      return { receipt: attachmentReceipt(existing), idempotent_replay: true };
    }
    const manifest = JSON.parse(submission.capture_json).attachment_manifest ?? [];
    const declared = manifest.find((item) => item.attachment_id === attachmentId);
    if (!declared) throw problem("SUBMISSION_ATTACHMENT_UNDECLARED", "SUBMISSION_ATTACHMENT_UNDECLARED", 422);
    if (declared.media_type !== mediaType || declared.original_name !== originalName || declared.size_bytes !== sizeBytes
      || declared.sha256 !== digest || declared.captured_at !== capturedAt) throw problem("ATTACHMENT_MANIFEST_MISMATCH", "ATTACHMENT_MANIFEST_MISMATCH", 422);
    const objectDirectory = resolve(this.evidenceRoot, "submission-objects", digest.slice(0, 2));
    mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
    chmodSync(objectDirectory, 0o700);
    const localPath = resolve(objectDirectory, `${digest}.bin`);
    if (existsSync(localPath)) {
      const current = readFileSync(localPath);
      if (current.length !== sizeBytes || createHash("sha256").update(current).digest("hex") !== digest) throw problem("ATTACHMENT_INTEGRITY_FAILURE", "ATTACHMENT_INTEGRITY_FAILURE", 422);
    } else {
      const temporaryPath = resolve(objectDirectory, `.${digest}.${randomUUID()}.tmp`);
      writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600, flush: true });
      try {
        if (createHash("sha256").update(readFileSync(temporaryPath)).digest("hex") !== digest) throw problem("ATTACHMENT_INTEGRITY_FAILURE", "ATTACHMENT_INTEGRITY_FAILURE", 422);
        renameSync(temporaryPath, localPath);
        chmodSync(localPath, 0o600);
      } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      }
    }

    const stagedAt = now.toISOString();
    this.db.prepare(`INSERT INTO review_staged_attachments(attachment_id,submission_id,media_type,size_bytes,sha256,original_name,local_path,captured_at,staged_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(attachmentId, submissionId, mediaType, sizeBytes, digest, originalName, localPath, capturedAt, stagedAt);
    const row = this.db.prepare("SELECT * FROM review_staged_attachments WHERE attachment_id = ?").get(attachmentId);
    return { receipt: attachmentReceipt(row), idempotent_replay: false };
  }

  finalizeSubmission({ submissionId, projectId, captureHash, bootstrap = null, now = new Date() }, apply) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const submission = this.db.prepare("SELECT * FROM review_submissions WHERE submission_id = ?").get(submissionId);
      if (!submission) throw problem("SUBMISSION_NOT_FOUND", "SUBMISSION_NOT_FOUND", 404);
      if (submission.project_id !== projectId) throw problem("SUBMISSION_PROJECT_SCOPE_CONFLICT");
      if (submission.capture_hash !== captureHash) throw problem("SUBMISSION_IDEMPOTENCY_CONFLICT");
      const existingReceipt = this.db.prepare("SELECT receipt_json FROM review_submission_receipts WHERE submission_id = ?").get(submissionId);
      if (existingReceipt) {
        const receipt = JSON.parse(existingReceipt.receipt_json);
        this.db.exec("COMMIT");
        return { receipt, idempotent_replay: true };
      }
      if (submission.state !== "STAGED") throw problem("FINALIZE_ALREADY_BOUND_CONFLICT");
      const capture = JSON.parse(submission.capture_json);
      const sourceIdentity = capture.source_identity;
      const bootstrapMode = sourceIdentity?.schema_version === "filmos.source-identity.bootstrap.v1";
      if (bootstrapMode) {
        if (!bootstrap || bootstrap.submission_id !== submissionId
          || sourceIdentity.build_id !== bootstrap.build_id
          || sourceIdentity.commit !== bootstrap.base_commit
          || sourceIdentity.tree !== bootstrap.base_tree) {
          throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
        }
      } else {
        const { content_hash: sourceIdentityHash, ...sourceIdentityBase } = sourceIdentity ?? {};
        if (sourceIdentity?.schema_version !== INSTALLED_SUBMISSION_SOURCE_SCHEMA
          || !/^[a-f0-9]{64}$/.test(String(sourceIdentityHash ?? ""))
          || sha256(sourceIdentityBase) !== sourceIdentityHash) {
          throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
        }
      }
      const manifest = capture.attachment_manifest ?? [];
      const attachments = this.db.prepare("SELECT * FROM review_staged_attachments WHERE submission_id = ? ORDER BY attachment_id").all(submissionId);
      if (attachments.length !== manifest.length) throw problem("SUBMISSION_ATTACHMENT_MISSING", "SUBMISSION_ATTACHMENT_MISSING", 422);
      for (const declared of manifest) {
        const staged = attachments.find((item) => item.attachment_id === declared.attachment_id);
        if (!staged) throw problem("SUBMISSION_ATTACHMENT_MISSING", "SUBMISSION_ATTACHMENT_MISSING", 422);
        const bytes = existsSync(staged.local_path) ? readFileSync(staged.local_path) : null;
        if (!bytes || bytes.length !== declared.size_bytes || createHash("sha256").update(bytes).digest("hex") !== declared.sha256) throw problem("ATTACHMENT_INTEGRITY_FAILURE", "ATTACHMENT_INTEGRITY_FAILURE", 422);
      }

      const consumedAt = now.toISOString();
      let bootstrapReceipt = null;
      if (bootstrapMode) {
        const bootstrapBase = {
          schema_version: "filmos.source-identity.bootstrap-receipt.v1",
          submission_id: submissionId,
          base_commit: bootstrap.base_commit,
          base_tree: bootstrap.base_tree,
          build_id: bootstrap.build_id,
          migration_version: bootstrap.migration_version,
          consumed: true,
          consumed_at: consumedAt,
        };
        bootstrapReceipt = { ...bootstrapBase, receipt_hash: sha256(bootstrapBase) };
        const priorBootstrap = this.db.prepare("SELECT submission_id FROM review_bootstrap_receipts LIMIT 1").get();
        if (priorBootstrap) throw problem("BOOTSTRAP_ALREADY_CONSUMED");
        this.db.prepare(`INSERT INTO review_bootstrap_receipts(bootstrap_key,submission_id,migration_version,receipt_json,receipt_hash,consumed_at)
          VALUES(?,?,?,?,?,?)`).run("stage-a-fixed-source-identity", submissionId, bootstrap.migration_version, canonicalJson(bootstrapReceipt), bootstrapReceipt.receipt_hash, consumedAt);
      }

      const bindAttachments = (issueId) => {
        for (const staged of attachments) {
          const redactedAlias = `evidence://${issueId}/${staged.attachment_id}`;
          this.db.prepare(`INSERT INTO review_attachments(attachment_id,issue_id,media_type,size_bytes,sha256,original_name,redacted_alias,local_path,captured_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(staged.attachment_id, issueId, staged.media_type, staged.size_bytes, staged.sha256, staged.original_name, redactedAlias, staged.local_path, staged.captured_at);
          this.db.prepare("UPDATE review_staged_attachments SET bound_issue_id = ?, bound_at = ? WHERE attachment_id = ?")
            .run(issueId, consumedAt, staged.attachment_id);
        }
        return this.listAttachments(issueId);
      };
      const issue = apply({ capture, attachments: attachments.map(stagedAttachmentRow), bindAttachments, bootstrapReceipt, sourceIdentity });
      if (!issue || issue.project_id !== projectId || !issue.issue_id) throw problem("INVALID_SUBMISSION_PROJECTION");
      const receiptBase = {
        schema_version: RECEIPT_SCHEMA,
        submission_id: submissionId,
        formal_issue_id: issue.issue_id,
        project_id: projectId,
        lane: issue.lane,
        state: issue.state,
        capture_schema: submission.capture_schema,
        capture_hash: captureHash,
        projection_content_hash: issue.content_hash,
        evidence_manifest_hash: issue.evidence?.manifest?.contentHash ?? issue.evidence?.manifest?.content_hash ?? null,
        entity_version: issue.entity_version,
        ...(bootstrapReceipt
          ? { bootstrap_receipt_hash: bootstrapReceipt.receipt_hash }
          : { source_identity_hash: sourceIdentity.content_hash }),
        accepted_at: consumedAt,
      };
      const receipt = { ...receiptBase, receipt_hash: sha256(receiptBase) };
      this.db.prepare("INSERT INTO review_submission_receipts(submission_id,formal_issue_id,receipt_json,receipt_hash,created_at) VALUES(?,?,?,?,?)")
        .run(submissionId, issue.issue_id, canonicalJson(receipt), receipt.receipt_hash, consumedAt);
      this.db.prepare("UPDATE review_submissions SET state = ?, formal_issue_id = ?, updated_at = ? WHERE submission_id = ?")
        .run("ACCEPTED_AWAITING_READBACK", issue.issue_id, consumedAt, submissionId);
      this.db.exec("COMMIT");
      return { receipt, idempotent_replay: false };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordReadReceipt({ issueId, projectId, consumer, toolName, projectionContentHash, evidenceManifestHash = null, now = new Date() }) {
    this.recordReadReceipts([{ issueId, projectId, consumer, toolName, projectionContentHash, evidenceManifestHash, now }]);
  }

  recordReadReceipts(operations) {
    if (!Array.isArray(operations) || operations.length < 1) throw problem("READ_RECEIPT_OPERATION_REQUIRED");
    const externalOperations = [];
    const completed = [...this.externalReadOperations];
    for (const operation of operations) {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw problem("READ_RECEIPT_OPERATION_REQUIRED");
      if (this.runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) {
        const externalOperation = validateExternalReadReceiptOperation(this.externalReadPolicy, completed, operation);
        externalOperations.push(externalOperation);
        completed.push(externalOperation);
      }
    }
    if (this.runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) this.externalReadReceiptState();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare(`INSERT INTO review_read_receipts(issue_id,project_id,consumer,tool_name,projection_content_hash,evidence_manifest_hash,read_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(issue_id,consumer,tool_name) DO UPDATE SET
        project_id=excluded.project_id,projection_content_hash=excluded.projection_content_hash,
        evidence_manifest_hash=excluded.evidence_manifest_hash,read_at=excluded.read_at`);
      for (const operation of operations) {
        const now = operation.now ?? new Date();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw problem("READ_RECEIPT_TIME_INVALID");
        statement.run(
          operation.issueId,
          operation.projectId,
          operation.consumer,
          operation.toolName,
          operation.projectionContentHash,
          operation.evidenceManifestHash ?? null,
          now.toISOString(),
        );
      }
      if (this.runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) this.externalReadReceiptState();
      this.db.exec("COMMIT");
      this.externalReadOperations.push(...externalOperations);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertExternalPendingIssues(issues) {
    if (this.runtimeMode !== REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ || !this.externalReadPolicy) {
      throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
    }
    const actual = issues.map((issue) => ({
      issueId: issue.issue_id,
      state: issue.state,
      entityVersion: this.get(issue.issue_id)?.entity_version,
      contentHash: issue.content_hash,
      projectId: issue.project_id,
    })).sort((left, right) => left.issueId.localeCompare(right.issueId));
    const expected = this.externalReadPolicy.pendingIssues;
    const lines = actual.map((issue) => `${issue.issueId}|${issue.state}|${issue.entityVersion}|${issue.contentHash}`).join("\n") + "\n";
    if (actual.length !== expected.length
      || actual.some((issue, index) => issue.projectId !== this.externalReadPolicy.projectId
        || issue.issueId !== expected[index].issueId
        || issue.state !== expected[index].state
        || issue.entityVersion !== expected[index].entityVersion
        || issue.contentHash !== expected[index].contentHash)
      || createHash("sha256").update(lines).digest("hex") !== this.externalReadPolicy.pendingSummarySha256) {
      throw problem("EXTERNAL_READ_RUNTIME_PENDING_MISMATCH");
    }
    return actual;
  }

  externalReadOperationCount() {
    if (this.runtimeMode !== REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
    return this.externalReadOperations.length;
  }

  externalReadReceiptState() {
    if (this.runtimeMode !== REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ || !this.externalReadPolicy) {
      throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
    }
    const rows = this.db.prepare("SELECT issue_id,consumer,tool_name FROM review_read_receipts ORDER BY issue_id,consumer,tool_name").all();
    const keyLines = rows.map((row) => `${row.issue_id}|${row.consumer}|${row.tool_name}`).join("\n") + (rows.length ? "\n" : "");
    const state = {
      rowCount: rows.length,
      keysSha256: createHash("sha256").update(keyLines).digest("hex"),
    };
    if (state.rowCount !== this.externalReadPolicy.readReceiptRowCount
      || state.keysSha256 !== this.externalReadPolicy.readReceiptKeysSha256) {
      throw problem("EXTERNAL_READ_RUNTIME_RECEIPT_SET_MISMATCH");
    }
    return state;
  }

  readReceipts(issueId, consumer) {
    return this.db.prepare("SELECT issue_id,project_id,consumer,tool_name,projection_content_hash,evidence_manifest_hash,read_at FROM review_read_receipts WHERE issue_id = ? AND consumer = ? ORDER BY tool_name")
      .all(issueId, consumer).map((row) => ({ ...row }));
  }

  persistCodexCoordinationResult({ issueId, coordinationKey, attemptId, action, result, now = new Date() }, apply) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const resultJson = canonicalJson(result);
      const resultHash = sha256(result);
      const existing = this.db.prepare("SELECT * FROM review_codex_coordination_results WHERE issue_id = ? AND coordination_key = ?").get(issueId, coordinationKey);
      if (existing) {
        if (existing.attempt_id !== attemptId || existing.action !== action || existing.result_hash !== resultHash || existing.result_json !== resultJson) {
          throw problem("CODEX_COORDINATION_RESULT_CONFLICT", "CODEX_COORDINATION_RESULT_CONFLICT", 409);
        }
        const value = apply({ resultHash, idempotentReplay: true });
        this.db.exec("COMMIT");
        return { value, result_hash: resultHash, idempotent_replay: true };
      }
      this.db.prepare(`INSERT INTO review_codex_coordination_results(issue_id,coordination_key,attempt_id,action,result_json,result_hash,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(issueId, coordinationKey, attemptId, action, resultJson, resultHash, now.toISOString());
      const value = apply({ resultHash, idempotentReplay: false });
      this.db.exec("COMMIT");
      return { value, result_hash: resultHash, idempotent_replay: false };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readCodexCoordinationResult(issueId, coordinationKey) {
    const row = this.db.prepare("SELECT issue_id,coordination_key,attempt_id,action,result_json,result_hash,created_at FROM review_codex_coordination_results WHERE issue_id = ? AND coordination_key = ?")
      .get(issueId, coordinationKey);
    return row ? { ...row, result: JSON.parse(row.result_json), result_json: undefined } : null;
  }

  append({ issueId, eventType, actor, payload, projectId, lane, mutate, resolveCurrent = null, revokeCandidate = null, transitionAction = null, now = new Date() }) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(issueId);
      const resolved = resolveCurrent?.(structuredClone(current));
      if (resolved !== undefined && resolved !== null) {
        if (ownsTransaction) this.db.exec("COMMIT");
        return resolved;
      }
      const previous = this.db.prepare("SELECT event_hash FROM review_events WHERE issue_id = ? ORDER BY sequence DESC LIMIT 1").get(issueId);
      const createdAt = now.toISOString();
      const eventId = `review-event-${randomUUID()}`;
      const next = mutate(structuredClone(current), { eventId, eventHash: null, createdAt });
      if (!next || next.issue_id !== issueId) throw problem("INVALID_PROJECTION");
      next.entity_version = (current?.entity_version ?? 0) + 1;
      next.updated_at = createdAt;
      const isV2Architecture = next.lane === "architecture"
        && (next.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION
          || current?.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION);
      let eventPayload = typeof payload === "function"
        ? payload({ current: structuredClone(current), next: structuredClone(next), eventId, createdAt })
        : payload;
      if (isV2Architecture) {
        const action = transitionAction ?? (current && current.state === next.state ? "operational" : null);
        if (!action) throw problem("ARCHITECTURE_TRANSITION_ACTION_REQUIRED");
        eventPayload = {
          ...eventPayload,
          transition: architectureTransitionPayload({ current, next, action, actor }),
        };
      }
      const documentForHash = structuredClone(next);
      delete documentForHash.content_hash;
      next.content_hash = sha256(documentForHash);
      const eventBase = { event_id: eventId, issue_id: issueId, event_type: eventType, actor, payload: eventPayload, previous_hash: previous?.event_hash ?? null, created_at: createdAt };
      const eventHash = sha256(eventBase);
      this.db.prepare("INSERT INTO review_events(event_id,issue_id,event_type,actor,payload_json,previous_hash,event_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(eventId, issueId, eventType, actor, canonicalJson(eventPayload), previous?.event_hash ?? null, eventHash, createdAt);
      this.db.prepare(`INSERT INTO review_projections(issue_id,project_id,state,lane,entity_version,document_json,content_hash,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET project_id=excluded.project_id,state=excluded.state,lane=excluded.lane,entity_version=excluded.entity_version,document_json=excluded.document_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
        .run(issueId, projectId ?? next.project_id, next.state, lane ?? next.lane, next.entity_version, canonicalJson(next), next.content_hash, createdAt);
      if (revokeCandidate) {
        this.db.prepare(`UPDATE bridge_challenges SET revoked_at = ?
          WHERE issue_id = ? AND candidate_id = ? AND candidate_commit = ?
            AND used_at IS NULL AND revoked_at IS NULL`)
          .run(createdAt, issueId, revokeCandidate.candidate_id, revokeCandidate.candidate_commit);
      }
      if (ownsTransaction) this.db.exec("COMMIT");
      return next;
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  events(issueId) {
    return this.db.prepare("SELECT sequence,event_id,issue_id,event_type,actor,payload_json,previous_hash,event_hash,created_at FROM review_events WHERE issue_id = ? ORDER BY sequence").all(issueId).map((row) => ({ ...row, payload: JSON.parse(row.payload_json), payload_json: undefined }));
  }

  verifyEventChain(issueId) {
    let previousHash = null;
    for (const row of this.events(issueId)) {
      if (row.previous_hash !== previousHash) return false;
      const eventBase = { event_id: row.event_id, issue_id: row.issue_id, event_type: row.event_type, actor: row.actor, payload: row.payload, previous_hash: row.previous_hash, created_at: row.created_at };
      if (sha256(eventBase) !== row.event_hash) return false;
      previousHash = row.event_hash;
    }
    return true;
  }

  storeAttachment({ issueId, attachmentId, mediaType, originalName, redactedAlias, bytes, capturedAt = new Date() }) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const digest = createHash("sha256").update(buffer).digest("hex");
    const existing = this.db.prepare("SELECT * FROM review_attachments WHERE attachment_id = ?").get(attachmentId);
    if (existing) {
      if (existing.issue_id !== issueId || existing.sha256 !== digest || existing.size_bytes !== buffer.length) throw problem("ATTACHMENT_ID_CONFLICT");
      return attachmentRow(existing);
    }
    const issueDirectory = resolve(this.evidenceRoot, issueId);
    mkdirSync(issueDirectory, { recursive: true, mode: 0o700 });
    chmodSync(issueDirectory, 0o700);
    const localPath = resolve(issueDirectory, `${attachmentId}.bin`);
    const temporaryPath = resolve(issueDirectory, `.${attachmentId}.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, buffer, { flag: "wx", mode: 0o600 });
    try {
      renameSync(temporaryPath, localPath);
      chmodSync(localPath, 0o600);
      this.db.prepare(`INSERT INTO review_attachments(attachment_id,issue_id,media_type,size_bytes,sha256,original_name,redacted_alias,local_path,captured_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(attachmentId, issueId, mediaType, buffer.length, digest, originalName, redactedAlias, localPath, capturedAt.toISOString());
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      if (existsSync(localPath) && !this.db.prepare("SELECT 1 FROM review_attachments WHERE attachment_id = ?").get(attachmentId)) unlinkSync(localPath);
      throw error;
    }
    return this.getAttachmentMetadata(issueId, attachmentId);
  }

  getAttachmentMetadata(issueId, attachmentId) {
    const row = this.db.prepare("SELECT * FROM review_attachments WHERE issue_id = ? AND attachment_id = ?").get(issueId, attachmentId);
    return row ? attachmentRow(row) : null;
  }

  listAttachments(issueId) {
    return this.db.prepare("SELECT * FROM review_attachments WHERE issue_id = ? ORDER BY captured_at, attachment_id").all(issueId).map(attachmentRow);
  }

  readAttachment(issueId, attachmentId) {
    const metadata = this.getAttachmentMetadata(issueId, attachmentId);
    if (!metadata || !existsSync(metadata.local_path)) return null;
    const bytes = readFileSync(metadata.local_path);
    if (bytes.length !== metadata.size_bytes || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw problem("ATTACHMENT_INTEGRITY_FAILURE");
    return { metadata, bytes };
  }

  createPairingCode({ ttlMs = 300_000, now = new Date() } = {}) {
    const expiresAt = new Date(now.getTime() + Math.min(300_000, Math.max(30_000, ttlMs))).toISOString();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        this.db.prepare("INSERT INTO bridge_pairing_codes(code_hash,expires_at,created_at) VALUES(?,?,?)").run(sha256(code), expiresAt, now.toISOString());
        return { pairing_code: code, expires_at: expiresAt };
      } catch (error) {
        if (!String(error.message).includes("UNIQUE")) throw error;
      }
    }
    throw problem("PAIRING_CODE_EXHAUSTED");
  }

  consumePairingCode({ pairingCode, clientName, now = new Date() }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const hash = sha256(pairingCode);
      const row = this.db.prepare("SELECT * FROM bridge_pairing_codes WHERE code_hash = ?").get(hash);
      if (!row || row.used_at || Date.parse(row.expires_at) <= now.getTime()) throw problem("PAIRING_CODE_INVALID_OR_EXPIRED", "PAIRING_CODE_INVALID_OR_EXPIRED", 401);
      const clientId = `bridge-client-${randomUUID()}`;
      const token = `bridge-session-${randomBytes(36).toString("base64url")}`;
      this.db.prepare("UPDATE bridge_pairing_codes SET used_at = ? WHERE code_hash = ?").run(now.toISOString(), hash);
      this.db.prepare("INSERT INTO bridge_clients(client_id,client_name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?)")
        .run(clientId, clientName, sha256(token), now.toISOString(), now.toISOString());
      this.db.exec("COMMIT");
      return { client_id: clientId, bridge_session_token: token, paired_at: now.toISOString() };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  authenticateBridgeClient(token, now = new Date()) {
    const row = this.db.prepare("SELECT * FROM bridge_clients WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token));
    if (!row) return null;
    this.db.prepare("UPDATE bridge_clients SET last_seen_at = ? WHERE client_id = ?").run(now.toISOString(), row.client_id);
    return bridgeClientRow({ ...row, last_seen_at: now.toISOString() });
  }

  listBridgeClients() {
    return this.db.prepare("SELECT * FROM bridge_clients ORDER BY created_at DESC").all().map(bridgeClientRow);
  }

  revokeBridgeClient(clientId, now = new Date()) {
    const changed = this.db.prepare("UPDATE bridge_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").run(now.toISOString(), clientId).changes;
    if (changed !== 1) throw problem("BRIDGE_CLIENT_NOT_FOUND", "BRIDGE_CLIENT_NOT_FOUND", 404);
    return this.listBridgeClients().find((client) => client.client_id === clientId);
  }

  issueChallenge({ purpose, issueId, candidateId, candidateCommit, ttlMs = 120_000, now = new Date() }) {
    const challengeId = `review_challenge_${randomUUID()}`;
    const nonce = `review_nonce_${randomUUID()}_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + Math.min(300_000, Math.max(5_000, ttlMs))).toISOString();
    this.db.prepare("INSERT INTO bridge_challenges(challenge_id,purpose,issue_id,candidate_id,candidate_commit,nonce_hash,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(challengeId, purpose, issueId, candidateId ?? null, candidateCommit ?? null, sha256(nonce), expiresAt);
    return { challenge_id: challengeId, nonce, expires_at: expiresAt, issue_id: issueId, candidate_id: candidateId ?? null, candidate_commit: candidateCommit ?? null };
  }

  consumeChallenge({ challengeId, nonce, purpose, issueId, candidateId, candidateCommit, now = new Date() }) {
    return this.consumeChallengeAndApply({ challengeId, nonce, purpose, issueId, candidateId, candidateCommit, now }, () => true);
  }

  consumeChallengeAndApply({ challengeId, nonce, purpose, issueId, candidateId, candidateCommit, now = new Date() }, apply) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM bridge_challenges WHERE challenge_id = ?").get(challengeId);
      if (!row || row.used_at || row.revoked_at) throw problem("REVIEW_REPLAY_BLOCKED");
      if (Date.parse(row.expires_at) <= now.getTime()) throw problem("REVIEW_CHALLENGE_EXPIRED");
      if (row.nonce_hash !== sha256(nonce)) throw problem("REVIEW_CHALLENGE_INVALID");
      if (row.purpose !== purpose || row.issue_id !== issueId || (row.candidate_id ?? null) !== (candidateId ?? null) || (row.candidate_commit ?? null) !== (candidateCommit ?? null)) throw problem("REVIEW_CHALLENGE_BINDING_MISMATCH");
      this.db.prepare("UPDATE bridge_challenges SET used_at = ? WHERE challenge_id = ?").run(now.toISOString(), challengeId);
      const result = apply();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeChallenges(now = new Date()) {
    return this.db.prepare("UPDATE bridge_challenges SET revoked_at = ? WHERE used_at IS NULL AND revoked_at IS NULL").run(now.toISOString()).changes;
  }

  candidateChallenges({ issueId, candidateId, candidateCommit }) {
    return this.db.prepare(`SELECT challenge_id,purpose,used_at,revoked_at,expires_at
      FROM bridge_challenges WHERE issue_id = ? AND candidate_id = ? AND candidate_commit = ? ORDER BY challenge_id`)
      .all(issueId, candidateId, candidateCommit);
  }

  setConfiguration(key, value, now = new Date()) {
    this.db.prepare("INSERT INTO local_configuration(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, value, now.toISOString());
  }

  getConfiguration(key) { return this.db.prepare("SELECT value FROM local_configuration WHERE key = ?").get(key)?.value ?? null; }

  backup(destination) {
    if (this.path === ":memory:") throw problem("MEMORY_DATABASE_CANNOT_BACKUP");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (existsSync(destination)) throw problem("BACKUP_DESTINATION_EXISTS");
    const quoted = String(destination).replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${quoted}'`);
    chmodSync(destination, 0o600);
    return { destination, sha256: createHash("sha256").update(readFileSync(destination)).digest("hex") };
  }
}

export function prepareReviewBusSealBinding(path, sealTarget) {
  const target = normalizeSealTarget(sealTarget);
  const identity = readCanonicalSealDatabaseFiles(path, { allowMissingWal: true });
  const db = new DatabaseSync(identity.path, { readOnly: true });
  try {
    const snapshot = inspectOpenSealDatabase(db, identity, target, { allowCodexSealed: true });
    if (snapshot.sealState === "PRISTINE_EMPTY" && !identity.wal) throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
    const afterRead = readCanonicalSealDatabaseFiles(path, { allowMissingWal: true });
    if (snapshot.sealState === "PRISTINE_EMPTY") assertSameSealPreopenIdentity(identity, afterRead);
    else assertSameSealMainBytes(identity, afterRead);
    return Object.freeze({
      canonicalPath: identity.path,
      device: identity.device,
      inode: identity.inode,
      size: identity.size,
      sha256: identity.sha256,
      walPresent: Boolean(identity.wal),
      walDevice: identity.wal?.device ?? null,
      walInode: identity.wal?.inode ?? null,
      walSize: identity.wal?.size ?? null,
      walSha256: identity.wal?.sha256 ?? null,
      shmPresent: Boolean(identity.shm),
      shmDevice: identity.shm?.device ?? null,
      shmInode: identity.shm?.inode ?? null,
      shmSize: identity.shm?.size ?? null,
      shmSha256: identity.shm?.sha256 ?? null,
      journalMode: snapshot.journalMode,
      pageCount: snapshot.pageCount,
      schemaVersion: snapshot.schemaVersion,
      logicalSnapshotSha256: snapshot.logicalSnapshotSha256,
      stateSnapshotSha256: snapshot.stateSnapshotSha256,
      schemaSqlSha256: snapshot.schemaSqlSha256,
      submissionCaptureHash: snapshot.submissionCaptureHash,
      immutableSubmissionIntakeSha256: snapshot.immutableSubmissionIntakeSha256,
      sealState: snapshot.sealState,
    });
  } finally {
    db.close();
  }
}

function normalizeSealTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("SEAL_RUNTIME_TARGET_REQUIRED");
  const stringFields = ["projectId", "issueId", "submissionId", "actor", "projectionHash", "intakeReceiptHash", "lastEventHash"];
  const integerFields = ["assessmentRound", "entityVersion", "issueEventCount"];
  if (stringFields.some((field) => typeof value[field] !== "string" || !value[field])
    || integerFields.some((field) => !Number.isInteger(value[field]) || value[field] < 1)
    || !/^FILMOS-ARCH-[A-Za-z0-9-]+$/.test(value.issueId)
    || !/^FILMOS-SUBMISSION-[A-Za-z0-9-]+$/.test(value.submissionId)
    || !/^[a-f0-9]{64}$/.test(value.projectionHash)
    || !/^[a-f0-9]{64}$/.test(value.intakeReceiptHash)
    || !/^[a-f0-9]{64}$/.test(value.lastEventHash)) {
    throw problem("SEAL_RUNTIME_TARGET_REQUIRED");
  }
  if (value.actor !== "codex") throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  return {
    projectId: value.projectId,
    issueId: value.issueId,
    submissionId: value.submissionId,
    actor: "codex",
    assessmentRound: value.assessmentRound,
    entityVersion: value.entityVersion,
    issueEventCount: value.issueEventCount,
    projectionHash: value.projectionHash,
    intakeReceiptHash: value.intakeReceiptHash,
    lastEventHash: value.lastEventHash,
  };
}

function normalizeExternalReadPolicy(value, target, binding) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.projectId !== target.projectId
    || value.targetIssueId !== target.issueId
    || !Number.isInteger(value.targetEntityVersion) || value.targetEntityVersion !== target.entityVersion + 1
    || !Number.isInteger(value.targetIssueEventCount) || value.targetIssueEventCount !== target.issueEventCount + 1
    || !Number.isInteger(value.targetLastEventSequence) || value.targetLastEventSequence < 1
    || !/^[a-f0-9]{64}$/.test(String(value.targetProjectionHash ?? ""))
    || value.targetProjectionHash === target.projectionHash
    || !/^[a-f0-9]{64}$/.test(String(value.targetLastEventHash ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.pendingSummarySha256 ?? ""))
    || !Number.isInteger(value.readReceiptRowCount) || value.readReceiptRowCount < 1
    || !/^[a-f0-9]{64}$/.test(String(value.readReceiptKeysSha256 ?? ""))
    || !Array.isArray(value.pendingIssues) || value.pendingIssues.length < 1
    || !value.databaseIdentity || typeof value.databaseIdentity !== "object" || Array.isArray(value.databaseIdentity)) {
    throw problem("EXTERNAL_READ_RUNTIME_TARGET_REQUIRED");
  }
  const pendingIssues = value.pendingIssues.map((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)
      || !/^FILMOS-(?:ARCH|ISSUE)-[A-Za-z0-9-]+$/.test(String(issue.issueId ?? ""))
      || typeof issue.state !== "string" || !issue.state
      || !Number.isInteger(issue.entityVersion) || issue.entityVersion < 1
      || !/^[a-f0-9]{64}$/.test(String(issue.contentHash ?? ""))) {
      throw problem("EXTERNAL_READ_RUNTIME_PENDING_MISMATCH");
    }
    return Object.freeze({
      issueId: issue.issueId,
      state: issue.state,
      entityVersion: issue.entityVersion,
      contentHash: issue.contentHash,
    });
  }).sort((left, right) => left.issueId.localeCompare(right.issueId));
  if (new Set(pendingIssues.map((issue) => issue.issueId)).size !== pendingIssues.length
    || !pendingIssues.some((issue) => issue.issueId === target.issueId
      && issue.entityVersion === value.targetEntityVersion
      && issue.contentHash === value.targetProjectionHash)) {
    throw problem("EXTERNAL_READ_RUNTIME_PENDING_MISMATCH");
  }
  const databaseIdentity = normalizeExternalReadDatabaseIdentity(value.databaseIdentity, binding);
  return {
    projectId: value.projectId,
    targetIssueId: value.targetIssueId,
    targetEntityVersion: value.targetEntityVersion,
    targetProjectionHash: value.targetProjectionHash,
    targetIssueEventCount: value.targetIssueEventCount,
    targetLastEventSequence: value.targetLastEventSequence,
    targetLastEventHash: value.targetLastEventHash,
    pendingSummarySha256: value.pendingSummarySha256,
    readReceiptRowCount: value.readReceiptRowCount,
    readReceiptKeysSha256: value.readReceiptKeysSha256,
    pendingIssues: Object.freeze(pendingIssues),
    databaseIdentity: Object.freeze(databaseIdentity),
  };
}

function normalizeExternalReadDatabaseIdentity(value, binding) {
  const fileFields = ["device", "inode", "size"];
  const validFile = (file, { allowZero = false } = {}) => file && typeof file === "object" && !Array.isArray(file)
    && fileFields.every((field) => Number.isInteger(file[field]) && file[field] >= (field === "size" && allowZero ? 0 : 1))
    && /^[a-f0-9]{64}$/.test(String(file.sha256 ?? ""));
  if (!validFile(value)
    || value.device !== binding.device
    || value.inode !== binding.inode
    || !validFile(value.wal, { allowZero: true })
    || !validFile(value.shm, { allowZero: true })) {
    throw problem("EXTERNAL_READ_RUNTIME_DATABASE_REQUIRED");
  }
  return {
    device: value.device,
    inode: value.inode,
    size: value.size,
    sha256: value.sha256,
    wal: Object.freeze({ ...value.wal }),
    shm: Object.freeze({ ...value.shm }),
  };
}

function assertExternalReadDatabaseIdentity(identity, expected) {
  const matches = (actual, value) => Boolean(actual)
    && actual.device === value.device
    && actual.inode === value.inode
    && actual.size === value.size
    && actual.sha256 === value.sha256;
  if (!matches(identity, expected) || !matches(identity.wal, expected.wal) || !matches(identity.shm, expected.shm)) {
    throw problem("EXTERNAL_READ_RUNTIME_DATABASE_REQUIRED");
  }
}

function assertExternalReadTarget(snapshot, policy) {
  if (!policy
    || snapshot.sealState !== "CODEX_SEALED_SUCCESSOR"
    || snapshot.entityVersion !== policy.targetEntityVersion
    || snapshot.projectionContentHash !== policy.targetProjectionHash
    || snapshot.issueEventCount !== policy.targetIssueEventCount
    || snapshot.lastEventSequence !== policy.targetLastEventSequence
    || snapshot.lastEventHash !== policy.targetLastEventHash
    || snapshot.assessmentEventCount !== 1
    || snapshot.codexSlot !== "SEALED"
    || snapshot.chatgptSlot !== "EMPTY") {
    throw problem("EXTERNAL_READ_RUNTIME_TARGET_MISMATCH");
  }
}

function installExternalReadAuthorizer(db) {
  const readActions = new Set([
    sqliteConstants.SQLITE_FUNCTION,
    sqliteConstants.SQLITE_READ,
    sqliteConstants.SQLITE_RECURSIVE,
    sqliteConstants.SQLITE_SELECT,
    sqliteConstants.SQLITE_TRANSACTION,
  ]);
  const readPragmas = new Set(["journal_mode", "page_count", "schema_version"]);
  db.setAuthorizer((action, first, second) => {
    if (readActions.has(action)) return sqliteConstants.SQLITE_OK;
    if (action === sqliteConstants.SQLITE_PRAGMA && readPragmas.has(String(first)) && (second === null || second === undefined)) {
      return sqliteConstants.SQLITE_OK;
    }
    if ([sqliteConstants.SQLITE_INSERT, sqliteConstants.SQLITE_UPDATE].includes(action)
      && first === "review_read_receipts") {
      return sqliteConstants.SQLITE_OK;
    }
    return sqliteConstants.SQLITE_DENY;
  });
}

function validateExternalReadReceiptOperation(policy, completed, operation) {
  if (!policy
    || operation.projectId !== policy.projectId
    || operation.consumer !== "chatgpt-mcp"
    || !["issue_list_pending", "issue_get_evidence"].includes(operation.toolName)) {
    throw problem("EXTERNAL_READ_RUNTIME_WRITE_DENIED");
  }
  const expected = policy.pendingIssues.find((issue) => issue.issueId === operation.issueId);
  if (!expected
    || expected.contentHash !== operation.projectionContentHash
    || (operation.toolName === "issue_get_evidence" && operation.issueId !== policy.targetIssueId)
    || (operation.toolName === "issue_get_evidence" && !/^[a-f0-9]{64}$/.test(String(operation.evidenceManifestHash ?? "")))) {
    throw problem("EXTERNAL_READ_RUNTIME_WRITE_DENIED");
  }
  const key = `${operation.issueId}:${operation.toolName}`;
  if (completed.includes(key) || completed.length >= policy.pendingIssues.length + 1) {
    throw problem("EXTERNAL_READ_RUNTIME_WRITE_BUDGET_EXCEEDED");
  }
  return key;
}

function normalizeSealBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.canonicalPath !== "string" || !value.canonicalPath
    || !Number.isInteger(value.device) || value.device < 0
    || !Number.isInteger(value.inode) || value.inode < 1
    || !Number.isInteger(value.size) || value.size < 1
    || !/^[a-f0-9]{64}$/.test(String(value.sha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.walSha256 ?? ""))
    || value.journalMode !== "wal"
    || !Number.isInteger(value.pageCount) || value.pageCount < 1
    || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1
    || !/^[a-f0-9]{64}$/.test(String(value.logicalSnapshotSha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.stateSnapshotSha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.schemaSqlSha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.submissionCaptureHash ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.immutableSubmissionIntakeSha256 ?? ""))) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  for (const optional of ["walDevice", "walInode", "walSize"]) {
    if (value[optional] !== undefined && (!Number.isInteger(value[optional]) || value[optional] < 0)) {
      throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
    }
  }
  return { ...value, canonicalPath: resolve(value.canonicalPath) };
}

function assertStableSealMainIdentity(identity, binding) {
  if (identity.path !== binding.canonicalPath
    || identity.device !== binding.device
    || identity.inode !== binding.inode) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
}

function assertPristineSealPhysicalBinding(identity, binding) {
  assertStableSealMainIdentity(identity, binding);
  if (identity.size !== binding.size
    || identity.sha256 !== binding.sha256
    || !identity.wal
    || identity.wal.sha256 !== binding.walSha256
    || (binding.walDevice !== undefined && identity.wal.device !== binding.walDevice)
    || (binding.walInode !== undefined && identity.wal.inode !== binding.walInode)
    || (binding.walSize !== undefined && identity.wal.size !== binding.walSize)) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
}

function assertSealSnapshotCompatibility(snapshot, binding) {
  const pageCountMatches = snapshot.sealState === "PRISTINE_EMPTY"
    ? snapshot.pageCount === binding.pageCount
    : snapshot.pageCount >= binding.pageCount;
  if (snapshot.journalMode !== binding.journalMode || !pageCountMatches) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  if (snapshot.schemaVersion !== binding.schemaVersion || snapshot.schemaSqlSha256 !== binding.schemaSqlSha256) {
    throw problem("SEAL_RUNTIME_SCHEMA_MISMATCH");
  }
}

function assertSealImmutableBindings(snapshot, binding) {
  if (snapshot.submissionCaptureHash !== binding.submissionCaptureHash
    || snapshot.immutableSubmissionIntakeSha256 !== binding.immutableSubmissionIntakeSha256) {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }
}

function assertPristineSealSnapshots(snapshot, binding) {
  if (snapshot.logicalSnapshotSha256 !== binding.logicalSnapshotSha256
    || snapshot.stateSnapshotSha256 !== binding.stateSnapshotSha256) {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }
}

function assertSameSealPreopenIdentity(before, after) {
  assertSameSealMainBytes(before, after);
  if (Boolean(before.wal) !== Boolean(after.wal)
    || (before.wal && (before.wal.device !== after.wal.device
      || before.wal.inode !== after.wal.inode
      || before.wal.size !== after.wal.size
      || before.wal.sha256 !== after.wal.sha256))) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
}

function assertSameSealMainBytes(before, after) {
  if (before.path !== after.path
    || before.device !== after.device
    || before.inode !== after.inode
    || before.size !== after.size
    || before.sha256 !== after.sha256) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
}

function readCanonicalSealDatabaseFiles(path, { allowMissingWal = false } = {}) {
  if (path === ":memory:" || typeof path !== "string" || resolve(path) !== path) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  const parent = dirname(path);
  let parentMetadata;
  try {
    parentMetadata = lstatSync(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error("parent drift");
  } catch {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  const main = readBoundRegularFile(path, "SEAL_RUNTIME_DATABASE_REQUIRED");
  if (main.realpath !== path) throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  const evidenceRoot = resolve(parent, "evidence");
  try {
    const evidence = lstatSync(evidenceRoot);
    if (!evidence.isDirectory() || evidence.isSymbolicLink() || realpathSync(evidenceRoot) !== evidenceRoot) throw new Error("evidence drift");
  } catch {
    throw problem("SEAL_RUNTIME_EVIDENCE_ROOT_REQUIRED");
  }
  const walPath = `${path}-wal`;
  const wal = existsSync(walPath) ? readBoundRegularFile(walPath, "SEAL_RUNTIME_DATABASE_REQUIRED") : null;
  if (!wal && !allowMissingWal) throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  if (wal && wal.realpath !== walPath) throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  const shm = existsSync(`${path}-shm`) ? readBoundRegularFile(`${path}-shm`, "SEAL_RUNTIME_DATABASE_REQUIRED") : null;
  if (shm && shm.realpath !== `${path}-shm`) throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  return {
    path,
    realpath: main.realpath,
    device: main.device,
    inode: main.inode,
    size: main.size,
    sha256: main.sha256,
    evidenceRoot,
    wal,
    shm,
  };
}

function readBoundRegularFile(path, code) {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
    const realpath = realpathSync(path);
    const digest = sha256File(path);
    const after = statSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("file changed during inspection");
    }
    return {
      path,
      realpath,
      device: Number(after.dev),
      inode: Number(after.ino),
      size: Number(after.size),
      sha256: digest,
    };
  } catch (error) {
    if (error?.code === code) throw error;
    throw problem(code);
  }
}

function sha256File(path) {
  const digest = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function inspectOpenSealDatabase(db, databaseIdentity, target, { allowCodexSealed }) {
  const journalMode = String(db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "");
  const pageCount = Number(db.prepare("PRAGMA page_count").get()?.page_count ?? 0);
  const schemaVersion = Number(db.prepare("PRAGMA schema_version").get()?.schema_version ?? 0);
  const frozenLogicalSchemaRows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name").all();
  const schemaRows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name`).all();
  const available = new Set(schemaRows.map((row) => `${row.type}:${row.name}`));
  if (REQUIRED_SEAL_SCHEMA.some(([type, name]) => !available.has(`${type}:${name}`))) {
    throw problem("SEAL_RUNTIME_SCHEMA_MISMATCH");
  }
  const schemaSummary = schemaRows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql_sha256: sha256(row.sql),
  }));
  const schemaSqlSha256 = sha256(schemaSummary);

  const projectionRow = db.prepare("SELECT issue_id,project_id,state,lane,entity_version,document_json,content_hash FROM review_projections WHERE issue_id = ?").get(target.issueId);
  if (!projectionRow) throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  let projection;
  try { projection = JSON.parse(projectionRow.document_json); }
  catch { throw problem("SEAL_RUNTIME_TARGET_MISMATCH"); }
  const projectionForHash = structuredClone(projection);
  delete projectionForHash.content_hash;
  if (sha256(projectionForHash) !== projectionRow.content_hash || projection.content_hash !== projectionRow.content_hash) {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }

  const eventRows = db.prepare(`SELECT sequence,event_id,issue_id,event_type,actor,payload_json,previous_hash,event_hash,created_at
    FROM review_events WHERE issue_id = ? ORDER BY sequence`).all(target.issueId);
  if (!verifyStoredEventRows(eventRows)) throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  const assessmentEventCount = eventRows.filter((row) => ["assessment.codex.submitted", "assessment.chatgpt.submitted"].includes(row.event_type)).length;
  const lastEvent = eventRows.at(-1) ?? null;
  const frozenLastEvent = eventRows[target.issueEventCount - 1] ?? null;
  const previousEvent = eventRows[target.issueEventCount - 1] ?? null;
  let lastEventPayload = null;
  let previousEventPayload = null;
  try {
    lastEventPayload = lastEvent ? JSON.parse(lastEvent.payload_json) : null;
    previousEventPayload = previousEvent ? JSON.parse(previousEvent.payload_json) : null;
  } catch {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }
  const codexSlot = projection.assessment_slots?.codex ?? null;
  const chatgptSlot = projection.assessment_slots?.chatgpt ?? null;
  const baseMatches = projectionRow.issue_id === target.issueId
    && projectionRow.project_id === target.projectId
    && projectionRow.state === "ARCHITECTURE_ASSESSMENTS_PENDING"
    && projectionRow.lane === "architecture"
    && projection.issue_id === target.issueId
    && projection.project_id === target.projectId
    && projection.submission_id === target.submissionId
    && projection.state === projectionRow.state
    && projection.lane === projectionRow.lane
    && projection.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION
    && projection.architecture_state_mapping_version === ARCHITECTURE_STATE_MAPPING_VERSION
    && projection.architecture_transition_contract_hash === ARCHITECTURE_TRANSITION_CONTRACT_HASH
    && projection.assessment_round === target.assessmentRound
    && projection.current_round === target.assessmentRound
    && chatgptSlot?.status === "EMPTY";
  const pristine = baseMatches
    && Number(projectionRow.entity_version) === target.entityVersion
    && projection.entity_version === target.entityVersion
    && projectionRow.content_hash === target.projectionHash
    && codexSlot?.status === "EMPTY"
    && !projection.assessments?.codex
    && !projection.assessment_receipts?.codex
    && eventRows.length === target.issueEventCount
    && assessmentEventCount === 0
    && lastEvent?.event_hash === target.lastEventHash;
  const sealedReplay = allowCodexSealed
    && baseMatches
    && Number(projectionRow.entity_version) === target.entityVersion + 1
    && projection.entity_version === target.entityVersion + 1
    && projectionRow.content_hash !== target.projectionHash
    && codexSlot?.status === "SEALED"
    && Boolean(projection.assessments?.codex)
    && Boolean(projection.assessment_receipts?.codex)
    && eventRows.length === target.issueEventCount + 1
    && assessmentEventCount === 1
    && frozenLastEvent?.event_hash === target.lastEventHash
    && lastEvent?.event_type === "assessment.codex.submitted"
    && lastEvent?.actor === "codex"
    && lastEvent?.previous_hash === target.lastEventHash
    && validateSealSuccessorProjection({
      projection,
      codexSlot,
      chatgptSlot,
      lastEvent,
      lastEventPayload,
      previousEventPayload,
      target,
    });
  if (!pristine && !sealedReplay) throw problem("SEAL_RUNTIME_TARGET_MISMATCH");

  const submission = db.prepare(`SELECT submission_id,project_id,capture_hash,state,formal_issue_id
    FROM review_submissions WHERE submission_id = ?`).get(target.submissionId);
  const receiptRow = db.prepare(`SELECT submission_id,formal_issue_id,receipt_json,receipt_hash
    FROM review_submission_receipts WHERE submission_id = ?`).get(target.submissionId);
  let receipt;
  try { receipt = receiptRow ? JSON.parse(receiptRow.receipt_json) : null; }
  catch { throw problem("SEAL_RUNTIME_TARGET_MISMATCH"); }
  if (!submission || !receiptRow || !receipt) throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  const { receipt_hash: receiptHash, ...receiptBase } = receipt;
  if (submission.submission_id !== target.submissionId
    || submission.project_id !== target.projectId
    || submission.state !== "ACCEPTED_AWAITING_READBACK"
    || submission.formal_issue_id !== target.issueId
    || receiptRow.submission_id !== target.submissionId
    || receiptRow.formal_issue_id !== target.issueId
    || receiptRow.receipt_hash !== target.intakeReceiptHash
    || receiptHash !== target.intakeReceiptHash
    || receipt.submission_id !== target.submissionId
    || receipt.formal_issue_id !== target.issueId
    || receipt.project_id !== target.projectId
    || sha256(receiptBase) !== receiptHash) {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }

  const immutableSubmissionIntake = {
    submission: {
      submission_id: submission.submission_id,
      project_id: submission.project_id,
      capture_hash: submission.capture_hash,
      state: submission.state,
      formal_issue_id: submission.formal_issue_id,
    },
    intake_receipt: {
      submission_id: receiptRow.submission_id,
      formal_issue_id: receiptRow.formal_issue_id,
      receipt_hash: receiptRow.receipt_hash,
    },
  };

  const stateSnapshot = {
    schema: schemaSummary,
    database: {
      realpath: databaseIdentity.realpath,
      device: databaseIdentity.device,
      inode: databaseIdentity.inode,
      size: databaseIdentity.size,
      sha256: databaseIdentity.sha256,
      wal: databaseIdentity.wal ? {
        present: true,
        path: databaseIdentity.wal.realpath,
        device: databaseIdentity.wal.device,
        inode: databaseIdentity.wal.inode,
        size: databaseIdentity.wal.size,
        sha256: databaseIdentity.wal.sha256,
      } : { present: false, path: `${databaseIdentity.path}-wal` },
      journal_mode: journalMode,
      page_count: pageCount,
      schema_version: schemaVersion,
    },
    target: {
      project_id: projectionRow.project_id,
      issue_id: projectionRow.issue_id,
      submission_id: projection.submission_id,
      actor: target.actor,
      assessment_round: projection.assessment_round,
      current_round: projection.current_round,
      state: projectionRow.state,
      entity_version: Number(projectionRow.entity_version),
      codex_slot: codexSlot?.status ?? null,
      chatgpt_slot: chatgptSlot?.status ?? null,
      projection_content_hash: projectionRow.content_hash,
    },
    events: {
      count: eventRows.length,
      last_event_hash: lastEvent?.event_hash ?? null,
      assessment_event_count: assessmentEventCount,
      chain_verified: true,
    },
    submission: {
      submission_id: submission.submission_id,
      project_id: submission.project_id,
      state: submission.state,
      formal_issue_id: submission.formal_issue_id,
      capture_hash: submission.capture_hash,
    },
    intake_receipt: {
      submission_id: receiptRow.submission_id,
      formal_issue_id: receiptRow.formal_issue_id,
      receipt_hash: receiptRow.receipt_hash,
    },
  };
  return {
    journalMode,
    pageCount,
    schemaVersion,
    schemaSqlSha256,
    logicalSnapshotSha256: frozenLogicalSnapshotSha256({
      journalMode,
      pageCount,
      schemaVersion,
      schemaRows: frozenLogicalSchemaRows,
      projectionRow,
      projection,
      eventRows,
      assessmentEventCount,
      submission,
      receiptRow,
    }),
    stateSnapshotSha256: sha256(stateSnapshot),
    submissionCaptureHash: submission.capture_hash,
    immutableSubmissionIntakeSha256: sha256(immutableSubmissionIntake),
    issueEventCount: eventRows.length,
    assessmentEventCount,
    lastEventSequence: Number(lastEvent?.sequence ?? 0),
    lastEventHash: lastEvent?.event_hash ?? null,
    projectionContentHash: projectionRow.content_hash,
    entityVersion: Number(projectionRow.entity_version),
    codexSlot: codexSlot?.status ?? null,
    chatgptSlot: chatgptSlot?.status ?? null,
    sealState: pristine ? "PRISTINE_EMPTY" : "CODEX_SEALED_SUCCESSOR",
  };
}

function frozenLogicalSnapshotSha256({ journalMode, pageCount, schemaVersion, schemaRows, projectionRow, projection, eventRows, assessmentEventCount, submission, receiptRow }) {
  const lines = [
    journalMode,
    String(pageCount),
    String(schemaVersion),
    ...schemaRows.map((row) => [row.type, row.name, row.tbl_name, row.sql ?? ""].join("|")),
    [
      projectionRow.issue_id,
      projectionRow.project_id,
      projectionRow.state,
      projectionRow.entity_version,
      projectionRow.content_hash,
      projection.submission_id,
      projection.assessment_round,
      projection.current_round,
      projection.assessment_slots?.codex?.status,
      projection.assessment_slots?.chatgpt?.status,
    ].join("|"),
    `${eventRows.length}|${eventRows.at(-1)?.event_hash ?? ""}`,
    String(assessmentEventCount),
    [submission.submission_id, submission.project_id, submission.state, submission.formal_issue_id, submission.capture_hash].join("|"),
    [receiptRow.submission_id, receiptRow.formal_issue_id, receiptRow.receipt_hash].join("|"),
  ];
  return sha256(`${lines.join("\n")}\n`);
}

function validateSealSuccessorProjection({ projection, codexSlot, chatgptSlot, lastEvent, lastEventPayload, previousEventPayload, target }) {
  const assessment = projection.assessments?.codex ?? null;
  const receipt = projection.assessment_receipts?.codex ?? null;
  if (!assessment || !receipt) return false;
  const binding = {
    project_id: projection.project_id,
    evidence_manifest_hash: projection.evidence?.manifest?.contentHash ?? projection.evidence?.manifest?.content_hash ?? null,
    constitution_content_hash: projection.constitution_content_hash,
  };
  const bindingHash = sha256(binding);
  const assessmentContentHash = sha256({
    schema_version: "filmos.architecture-assessment.v2",
    project_id: target.projectId,
    issue_id: target.issueId,
    submission_id: target.submissionId,
    actor: "codex",
    assessment_round: target.assessmentRound,
    binding_hash: bindingHash,
    assessment: assessment.assessment,
  });
  const { receipt_hash: receiptHash, ...receiptBase } = receipt;
  const transition = lastEventPayload?.transition ?? null;
  const priorTransition = previousEventPayload?.transition ?? null;
  const noLaterStage = !projection.option_comparison
    && !projection.architecture_options
    && !projection.accepted_architecture_option
    && !projection.consensus_proposal
    && (!Array.isArray(projection.consensus_responses) || projection.consensus_responses.length === 0)
    && !projection.consensus_record
    && !projection.issue_task_package
    && !projection.task_package_receipt
    && !projection.active_candidate
    && projection.task_package_content_hash === null
    && projection.next_pilot_allowed === false;
  return noLaterStage
    && !projection.assessments?.chatgpt
    && !projection.assessment_receipts?.chatgpt
    && chatgptSlot?.status === "EMPTY"
    && chatgptSlot?.binding_hash === bindingHash
    && codexSlot?.status === "SEALED"
    && codexSlot.binding_hash === bindingHash
    && assessment.schema_version === "filmos.architecture-assessment.v2"
    && typeof assessment.assessment_id === "string"
    && assessment.assessment_id.startsWith("architecture-assessment-")
    && assessment.project_id === target.projectId
    && assessment.issue_id === target.issueId
    && assessment.submission_id === target.submissionId
    && assessment.actor === "codex"
    && assessment.assessor === "codex"
    && assessment.assessment_round === target.assessmentRound
    && canonicalJson(assessment.binding) === canonicalJson(binding)
    && assessment.binding_hash === bindingHash
    && assessment.content_hash === assessmentContentHash
    && assessment.event_id === lastEvent.event_id
    && assessment.submitted_at === lastEvent.created_at
    && assessment.sealed_until_pair_complete === true
    && receipt.schema_version === "filmos.architecture-assessment-receipt.v2"
    && receipt.assessment_id === assessment.assessment_id
    && receipt.project_id === target.projectId
    && receipt.issue_id === target.issueId
    && receipt.submission_id === target.submissionId
    && receipt.actor === "codex"
    && receipt.assessor === "codex"
    && receipt.assessment_round === target.assessmentRound
    && receipt.binding_hash === bindingHash
    && receipt.assessment_content_hash === assessmentContentHash
    && receipt.event_id === lastEvent.event_id
    && receipt.accepted_at === lastEvent.created_at
    && receiptHash === sha256(receiptBase)
    && codexSlot.assessment_id === assessment.assessment_id
    && codexSlot.assessment_content_hash === assessmentContentHash
    && codexSlot.receipt_hash === receiptHash
    && codexSlot.event_id === lastEvent.event_id
    && canonicalJson(lastEventPayload?.receipt) === canonicalJson(receipt)
    && transition?.action === "assessment.submit"
    && transition.from_state === "ARCHITECTURE_ASSESSMENTS_PENDING"
    && transition.to_state === "ARCHITECTURE_ASSESSMENTS_PENDING"
    && transition.transition_contract_version === ARCHITECTURE_PROTOCOL_VERSION
    && transition.transition_contract_hash === ARCHITECTURE_TRANSITION_CONTRACT_HASH
    && typeof priorTransition?.post_projection_hash === "string"
    && transition.pre_projection_hash === priorTransition.post_projection_hash
    && transition.post_projection_hash === sha256(architectureSemanticProjection(projection));
}

function verifyStoredEventRows(rows) {
  let previousHash = null;
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload_json); }
    catch { return false; }
    const eventBase = {
      event_id: row.event_id,
      issue_id: row.issue_id,
      event_type: row.event_type,
      actor: row.actor,
      payload,
      previous_hash: row.previous_hash,
      created_at: row.created_at,
    };
    if (row.previous_hash !== previousHash || sha256(eventBase) !== row.event_hash) return false;
    previousHash = row.event_hash;
  }
  return true;
}

function stagedAttachmentRow(row) {
  return {
    attachment_id: row.attachment_id,
    submission_id: row.submission_id,
    media_type: row.media_type,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    original_name: row.original_name,
    local_path: row.local_path,
    captured_at: row.captured_at,
    staged_at: row.staged_at,
  };
}

function attachmentReceipt(row) {
  const base = {
    schema_version: ATTACHMENT_RECEIPT_SCHEMA,
    submission_id: row.submission_id,
    attachment_id: row.attachment_id,
    media_type: row.media_type,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    captured_at: row.captured_at,
    staged_at: row.staged_at,
  };
  return { ...base, receipt_hash: sha256(base) };
}

function attachmentRow(row) {
  return {
    attachment_id: row.attachment_id,
    issue_id: row.issue_id,
    media_type: row.media_type,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    original_name: row.original_name,
    redacted_alias: row.redacted_alias,
    local_path: row.local_path,
    captured_at: row.captured_at,
  };
}

function bridgeClientRow(row) {
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at ?? null,
  };
}

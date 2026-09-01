import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256, problem } from "./canonical.mjs";
import { ARCHITECTURE_PROTOCOL_VERSION, architectureTransitionPayload } from "./architecture-protocol.mjs";
import { ATTACHMENT_RECEIPT_SCHEMA, INSTALLED_SUBMISSION_SOURCE_SCHEMA, RECEIPT_SCHEMA } from "./intake-contract.mjs";

export class ReviewBusStore {
  constructor(path = ":memory:") {
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
    this.db.prepare(`INSERT INTO review_read_receipts(issue_id,project_id,consumer,tool_name,projection_content_hash,evidence_manifest_hash,read_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(issue_id,consumer,tool_name) DO UPDATE SET
      project_id=excluded.project_id,projection_content_hash=excluded.projection_content_hash,
      evidence_manifest_hash=excluded.evidence_manifest_hash,read_at=excluded.read_at`)
      .run(issueId, projectId, consumer, toolName, projectionContentHash, evidenceManifestHash, now.toISOString());
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

  append({ issueId, eventType, actor, payload, projectId, lane, mutate, revokeCandidate = null, transitionAction = null, now = new Date() }) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(issueId);
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
      let eventPayload = payload;
      if (isV2Architecture) {
        const action = transitionAction ?? (current && current.state === next.state ? "operational" : null);
        if (!action) throw problem("ARCHITECTURE_TRANSITION_ACTION_REQUIRED");
        eventPayload = {
          ...payload,
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

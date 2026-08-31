import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256, problem } from "./canonical.mjs";

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

  append({ issueId, eventType, actor, payload, projectId, lane, mutate, revokeCandidate = null, now = new Date() }) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(issueId);
      const previous = this.db.prepare("SELECT event_hash FROM review_events WHERE issue_id = ? ORDER BY sequence DESC LIMIT 1").get(issueId);
      const createdAt = now.toISOString();
      const eventId = `review-event-${randomUUID()}`;
      const eventBase = { event_id: eventId, issue_id: issueId, event_type: eventType, actor, payload, previous_hash: previous?.event_hash ?? null, created_at: createdAt };
      const eventHash = sha256(eventBase);
      const next = mutate(structuredClone(current), { eventId, eventHash, createdAt });
      if (!next || next.issue_id !== issueId) throw problem("INVALID_PROJECTION");
      next.entity_version = (current?.entity_version ?? 0) + 1;
      next.updated_at = createdAt;
      const documentForHash = structuredClone(next);
      delete documentForHash.content_hash;
      next.content_hash = sha256(documentForHash);
      this.db.prepare("INSERT INTO review_events(event_id,issue_id,event_type,actor,payload_json,previous_hash,event_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(eventId, issueId, eventType, actor, canonicalJson(payload), previous?.event_hash ?? null, eventHash, createdAt);
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
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    copyFileSync(this.path, destination);
    return { destination, sha256: createHash("sha256").update(readFileSync(destination)).digest("hex") };
  }
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

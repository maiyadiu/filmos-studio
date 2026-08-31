import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256, problem } from "./canonical.mjs";

export class ReviewBusStore {
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
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
      CREATE TABLE IF NOT EXISTS local_evidence (
        issue_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        evidence_uri TEXT NOT NULL UNIQUE,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(issue_id, evidence_id)
      );
      CREATE TABLE IF NOT EXISTS local_configuration (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS review_events_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT, 'REVIEW_EVENT_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS review_events_no_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT, 'REVIEW_EVENT_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS local_evidence_no_update BEFORE UPDATE ON local_evidence BEGIN SELECT RAISE(ABORT, 'LOCAL_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS local_evidence_no_delete BEFORE DELETE ON local_evidence BEGIN SELECT RAISE(ABORT, 'LOCAL_EVIDENCE_IMMUTABLE'); END;
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

  append({ issueId, eventType, actor, payload, projectId, lane, mutate, challenge = null, revokeCandidateChallenges = null, now = new Date() }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const challengeRow = challenge ? this.#validatedChallenge(challenge, now) : null;
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
      if (challengeRow) this.db.prepare("UPDATE bridge_challenges SET used_at = ? WHERE challenge_id = ?").run(createdAt, challengeRow.challenge_id);
      if (revokeCandidateChallenges) {
        this.db.prepare(`UPDATE bridge_challenges SET revoked_at = ?
          WHERE issue_id = ? AND candidate_id = ? AND candidate_commit = ? AND used_at IS NULL AND revoked_at IS NULL`)
          .run(createdAt, revokeCandidateChallenges.issueId, revokeCandidateChallenges.candidateId, revokeCandidateChallenges.candidateCommit);
      }
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
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

  issueChallenge({ purpose, issueId, candidateId, candidateCommit, ttlMs = 120_000, now = new Date() }) {
    const challengeId = `review_challenge_${randomUUID()}`;
    const nonce = `review_nonce_${randomUUID()}_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + Math.min(300_000, Math.max(5_000, ttlMs))).toISOString();
    this.db.prepare("INSERT INTO bridge_challenges(challenge_id,purpose,issue_id,candidate_id,candidate_commit,nonce_hash,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(challengeId, purpose, issueId, candidateId ?? null, candidateCommit ?? null, sha256(nonce), expiresAt);
    return { challenge_id: challengeId, nonce, expires_at: expiresAt, issue_id: issueId, candidate_id: candidateId ?? null, candidate_commit: candidateCommit ?? null };
  }

  consumeChallenge({ challengeId, nonce, purpose, issueId, candidateId, candidateCommit, now = new Date() }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#validatedChallenge({ challengeId, nonce, purpose, issueId, candidateId, candidateCommit }, now);
      this.db.prepare("UPDATE bridge_challenges SET used_at = ? WHERE challenge_id = ?").run(now.toISOString(), challengeId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeChallenges(now = new Date()) {
    return this.db.prepare("UPDATE bridge_challenges SET revoked_at = ? WHERE used_at IS NULL AND revoked_at IS NULL").run(now.toISOString()).changes;
  }

  persistLocalEvidence(issueId, items, now = new Date()) {
    if (!Array.isArray(items) || items.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      for (const item of items) {
        const bytes = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== item.sha256 || bytes.length !== item.size) throw problem("LOCAL_EVIDENCE_HASH_MISMATCH");
        this.db.prepare(`INSERT INTO local_evidence(issue_id,evidence_id,media_type,byte_size,sha256,evidence_uri,content,created_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(issue_id,evidence_id) DO NOTHING`)
          .run(issueId, item.evidenceId, item.mediaType, item.size, digest, item.evidenceUri, bytes, now.toISOString());
        const stored = this.db.prepare("SELECT media_type,byte_size,sha256,evidence_uri,content FROM local_evidence WHERE issue_id = ? AND evidence_id = ?").get(issueId, item.evidenceId);
        if (!stored || stored.media_type !== item.mediaType || stored.byte_size !== item.size || stored.sha256 !== digest || stored.evidence_uri !== item.evidenceUri || !Buffer.from(stored.content).equals(bytes)) {
          throw problem("LOCAL_EVIDENCE_IDEMPOTENCY_CONFLICT");
        }
        result.push({ evidence_id: item.evidenceId, media_type: item.mediaType, size: item.size, sha256: digest, evidence_uri: item.evidenceUri });
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  localEvidenceMetadata(issueId) {
    return this.db.prepare("SELECT evidence_id,media_type,byte_size AS size,sha256,evidence_uri FROM local_evidence WHERE issue_id = ? ORDER BY evidence_id").all(issueId);
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

  #validatedChallenge({ challengeId, nonce, purpose, issueId, candidateId, candidateCommit }, now) {
    const row = this.db.prepare("SELECT * FROM bridge_challenges WHERE challenge_id = ?").get(challengeId);
    if (!row || row.used_at || row.revoked_at) throw problem("REVIEW_REPLAY_BLOCKED");
    if (Date.parse(row.expires_at) <= now.getTime()) throw problem("REVIEW_CHALLENGE_EXPIRED");
    if (row.nonce_hash !== sha256(nonce)) throw problem("REVIEW_CHALLENGE_INVALID");
    if (row.purpose !== purpose || row.issue_id !== issueId || (row.candidate_id ?? null) !== (candidateId ?? null) || (row.candidate_commit ?? null) !== (candidateCommit ?? null)) throw problem("REVIEW_CHALLENGE_BINDING_MISMATCH");
    return row;
  }
}

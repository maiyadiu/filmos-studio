import { randomUUID } from "node:crypto";

import type { ProjectGrant } from "./grants.js";
import { sanitizeForMcp, SecurityBoundaryError } from "./security.js";

export type LiveWorkbenchContext = {
  project_id: string;
  content_unit_id: string | null;
  scene_id: string | null;
  director_unit_id: string | null;
  shot_id: string | null;
  canvas_id: string;
  selected_node_ids: string[];
  visible_node_summaries: Array<{ id: string; type: string; title?: string; status?: string }>;
  asset_version_ids: string[];
  canvas_revision: number;
  canvas_state_hash: string;
  film_expected_version: number | null;
  film_content_hash: string | null;
  context_receipt_id: string;
  source_identity: InstalledSourceIdentity | null;
  captured_at: string;
  expires_at: string;
};

export type InstalledSourceIdentity = {
  schema_version: string;
  build_id: string;
  repository: string;
  git_commit_sha: string;
  git_tree_sha: string;
  source_fingerprint_sha256: string;
  release_channel: string;
  source_clean: boolean;
};

export type PendingAgentHandoff = {
  handoff_id: string;
  session_id: string;
  turn_id: string;
  task: string;
  context_receipt_id: string;
  created_at: string;
  expires_at: string;
  status: "PENDING_CHATGPT";
};

type Scoped<T> = { grant_id: string; project_id: string; challenge_id: string; expires_at: string; value: T };

export class ChatGPTHostContextStore {
  private readonly contexts = new Map<string, Scoped<LiveWorkbenchContext>>();
  private readonly handoffs = new Map<string, Scoped<PendingAgentHandoff>>();

  publishContext(grant: ProjectGrant, challengeId: string, raw: unknown, now = new Date()) {
    const challenge = requireChallenge(challengeId);
    const value = normalizeContext(raw, grant, expiry(grant, now), now);
    this.contexts.set(scopeKey(grant.grant_id, challenge), {
      grant_id: grant.grant_id,
      project_id: grant.project_id,
      challenge_id: challenge,
      expires_at: value.expires_at,
      value,
    });
    return structuredClone(value);
  }

  publishHandoff(grant: ProjectGrant, challengeId: string, raw: unknown, now = new Date()) {
    const challenge = requireChallenge(challengeId);
    const context = this.requireContext(grant, challenge, now);
    const input = requireRecord(raw, "handoff");
    const contextReceiptId = requiredText(input.context_receipt_id, "context_receipt_id", 256);
    if (contextReceiptId !== context.context_receipt_id) throw new SecurityBoundaryError("context_receipt_mismatch", "Handoff does not match the current workbench receipt");
    const value: PendingAgentHandoff = {
      handoff_id: randomUUID(),
      session_id: requiredText(input.session_id, "session_id", 256),
      turn_id: requiredText(input.turn_id, "turn_id", 256),
      task: requiredText(input.task, "task", 20_000),
      context_receipt_id: contextReceiptId,
      created_at: now.toISOString(),
      expires_at: expiry(grant, now).toISOString(),
      status: "PENDING_CHATGPT",
    };
    this.handoffs.set(scopeKey(grant.grant_id, challenge), {
      grant_id: grant.grant_id,
      project_id: grant.project_id,
      challenge_id: challenge,
      expires_at: value.expires_at,
      value,
    });
    return structuredClone(value);
  }

  requireContext(grant: ProjectGrant, challengeId: string, now = new Date()) {
    return this.read(this.contexts, grant, challengeId, now, "live_workbench_context_unavailable");
  }

  requireHandoff(grant: ProjectGrant, challengeId: string, now = new Date()) {
    return this.read(this.handoffs, grant, challengeId, now, "pending_agent_handoff_unavailable");
  }

  revokeGrant(grantId: string) {
    for (const [key, value] of this.contexts) if (value.grant_id === grantId) this.contexts.delete(key);
    for (const [key, value] of this.handoffs) if (value.grant_id === grantId) this.handoffs.delete(key);
  }

  revokeChallenge(grantId: string, challengeId: string | null) {
    if (!challengeId) return;
    const key = scopeKey(grantId, challengeId);
    this.contexts.delete(key);
    this.handoffs.delete(key);
  }

  private read<T>(store: Map<string, Scoped<T>>, grant: ProjectGrant, challengeId: string, now: Date, code: string): T {
    const challenge = requireChallenge(challengeId);
    const scoped = store.get(scopeKey(grant.grant_id, challenge));
    if (!scoped || scoped.project_id !== grant.project_id || scoped.grant_id !== grant.grant_id) throw new SecurityBoundaryError(code, "No current value is bound to this Project Grant and Tunnel challenge");
    if (Date.parse(scoped.expires_at) <= now.getTime() || Date.parse(grant.expires_at) <= now.getTime()) {
      store.delete(scopeKey(grant.grant_id, challenge));
      throw new SecurityBoundaryError(code, "The scoped value expired");
    }
    return structuredClone(scoped.value);
  }
}

function normalizeContext(raw: unknown, grant: ProjectGrant, expiresAt: Date, now: Date): LiveWorkbenchContext {
  const input = sanitizeForMcp(requireRecord(raw, "context")) as Record<string, unknown>;
  const projectId = requiredText(input.project_id, "project_id", 256);
  if (projectId !== grant.project_id) throw new SecurityBoundaryError("project_scope_denied", "Workbench context is outside the Project Grant");
  const canvasRevision = input.canvas_revision;
  if (!Number.isSafeInteger(canvasRevision) || Number(canvasRevision) < 0) throw new SecurityBoundaryError("invalid_live_context", "canvas_revision must be a non-negative integer");
  return {
    project_id: projectId,
    content_unit_id: optionalText(input.content_unit_id, 256),
    scene_id: optionalText(input.scene_id, 256),
    director_unit_id: optionalText(input.director_unit_id, 256),
    shot_id: optionalText(input.shot_id, 256),
    canvas_id: requiredText(input.canvas_id, "canvas_id", 256),
    selected_node_ids: stringArray(input.selected_node_ids, "selected_node_ids", 200),
    visible_node_summaries: nodeSummaries(input.visible_node_summaries),
    asset_version_ids: stringArray(input.asset_version_ids, "asset_version_ids", 200),
    canvas_revision: Number(canvasRevision),
    canvas_state_hash: requiredHash(input.canvas_state_hash, "canvas_state_hash"),
    film_expected_version: input.film_expected_version === null || input.film_expected_version === undefined ? null : positiveInteger(input.film_expected_version, "film_expected_version"),
    film_content_hash: input.film_content_hash === null || input.film_content_hash === undefined ? null : requiredHash(input.film_content_hash, "film_content_hash"),
    context_receipt_id: requiredText(input.context_receipt_id, "context_receipt_id", 256),
    source_identity: installedSourceIdentity(input.source_identity),
    captured_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

function installedSourceIdentity(value: unknown): InstalledSourceIdentity | null {
  if (value === null || value === undefined) return null;
  const input = requireRecord(value, "source_identity");
  const sourceClean = input.source_clean;
  if (typeof sourceClean !== "boolean") throw new SecurityBoundaryError("invalid_live_context", "source_identity.source_clean must be boolean");
  return {
    schema_version: requiredText(input.schema_version, "source_identity.schema_version", 32),
    build_id: requiredText(input.build_id, "source_identity.build_id", 128),
    repository: requiredText(input.repository, "source_identity.repository", 256),
    git_commit_sha: requiredGitObject(input.git_commit_sha, "source_identity.git_commit_sha"),
    git_tree_sha: requiredGitObject(input.git_tree_sha, "source_identity.git_tree_sha"),
    source_fingerprint_sha256: requiredHash(input.source_fingerprint_sha256, "source_identity.source_fingerprint_sha256"),
    release_channel: requiredText(input.release_channel, "source_identity.release_channel", 64),
    source_clean: sourceClean,
  };
}

function expiry(grant: ProjectGrant, now: Date) {
  return new Date(Math.min(Date.parse(grant.expires_at), now.getTime() + 5 * 60_000));
}

function scopeKey(grantId: string, challengeId: string) { return `${grantId}:${challengeId}`; }
function requireChallenge(value: string) {
  if (!/^live_[A-Za-z0-9_-]{8,96}$/.test(value)) throw new SecurityBoundaryError("tunnel_challenge_required", "A valid Secure Tunnel challenge is required");
  return value;
}
function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecurityBoundaryError("invalid_live_context", `${name} must be an object`);
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new SecurityBoundaryError("invalid_live_context", `${name} is invalid`);
  return value.trim();
}
function optionalText(value: unknown, max: number) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, "optional value", max);
}
function requiredHash(value: unknown, name: string) {
  const text = requiredText(value, name, 64);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new SecurityBoundaryError("invalid_live_context", `${name} must be SHA-256`);
  return text;
}
function requiredGitObject(value: unknown, name: string) {
  const text = requiredText(value, name, 64);
  if (!/^[0-9a-f]{40,64}$/.test(text)) throw new SecurityBoundaryError("invalid_live_context", `${name} must be a Git object id`);
  return text;
}
function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new SecurityBoundaryError("invalid_live_context", `${name} must be a positive integer`);
  return Number(value);
}
function stringArray(value: unknown, name: string, max: number) {
  if (!Array.isArray(value) || value.length > max) throw new SecurityBoundaryError("invalid_live_context", `${name} is invalid`);
  return [...new Set(value.map((item) => requiredText(item, name, 256)))].sort();
}
function nodeSummaries(value: unknown): LiveWorkbenchContext["visible_node_summaries"] {
  if (!Array.isArray(value) || value.length > 200) throw new SecurityBoundaryError("invalid_live_context", "visible_node_summaries is invalid");
  return value.map((item) => {
    const input = requireRecord(item, "visible node summary");
    const title = optionalText(input.title, 500);
    const status = optionalText(input.status, 128);
    return {
      id: requiredText(input.id, "node.id", 256),
      type: requiredText(input.type, "node.type", 64),
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
    };
  });
}

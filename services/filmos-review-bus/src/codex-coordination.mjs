import { exactObject, problem } from "./canonical.mjs";

const COORDINATION_STATUSES = new Set([
  "IDLE",
  "RUNNING",
  "RESULT_READY",
  "WAITING_EXTERNAL",
  "STOPPED_OWNER_GATE",
  "COMPLETED",
  "FAILED",
  "STOPPED_ERROR",
]);

const STRING_FIELDS = [
  "session_id",
  "last_action",
  "last_error_code",
  "coordination_key",
  "attempt_id",
  "next_retry_at",
  "stop_reason",
];

export function recordCodexCoordination({ store, current, input, actor, now = new Date() }) {
  exactObject(input, ["status", ...STRING_FIELDS, "retry_count"]);
  if (!COORDINATION_STATUSES.has(input.status)) throw problem("INVALID_CODEX_COORDINATION_STATUS");
  for (const field of STRING_FIELDS) {
    if (input[field] !== null && typeof input[field] !== "string") throw problem("INVALID_CODEX_COORDINATION_RECORD");
  }
  if (!Number.isInteger(input.retry_count) || input.retry_count < 0 || input.retry_count > 3) throw problem("INVALID_CODEX_COORDINATION_RECORD");
  if (input.coordination_key !== null && !/^[0-9a-f]{64}$/.test(input.coordination_key)) throw problem("INVALID_CODEX_COORDINATION_KEY");
  if (input.attempt_id !== null && !/^review-attempt-[0-9a-f-]{36}$/.test(input.attempt_id)) throw problem("INVALID_CODEX_COORDINATION_ATTEMPT");
  if (input.next_retry_at !== null && !Number.isFinite(Date.parse(input.next_retry_at))) throw problem("INVALID_CODEX_COORDINATION_RETRY_AT");

  const value = { ...input, updated_at: now.toISOString() };
  return store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "codex.coordination",
    actor,
    payload: value,
    now,
    mutate: (next) => {
      next.codex_coordination = value;
      return next;
    },
  });
}

export function recordCodexCoordinationResult({ store, current, input, actor, now = new Date() }) {
  exactObject(input, ["coordination_key", "attempt_id", "action", "result"]);
  if (!/^[0-9a-f]{64}$/.test(String(input.coordination_key ?? ""))) throw problem("INVALID_CODEX_COORDINATION_KEY");
  if (!/^review-attempt-[0-9a-f-]{36}$/.test(String(input.attempt_id ?? ""))) throw problem("INVALID_CODEX_COORDINATION_ATTEMPT");
  if (typeof input.action !== "string" || !input.action.trim() || !input.result || typeof input.result !== "object" || Array.isArray(input.result)) {
    throw problem("INVALID_CODEX_COORDINATION_RESULT");
  }
  if (current.codex_coordination?.coordination_key !== input.coordination_key || current.codex_coordination?.attempt_id !== input.attempt_id) {
    throw problem("CODEX_COORDINATION_ATTEMPT_MISMATCH");
  }

  return store.persistCodexCoordinationResult({
    issueId: current.issue_id,
    coordinationKey: input.coordination_key,
    attemptId: input.attempt_id,
    action: input.action,
    result: input.result,
    now,
  }, ({ resultHash, idempotentReplay }) => {
    if (idempotentReplay) return store.get(current.issue_id);
    const value = {
      ...current.codex_coordination,
      status: "RESULT_READY",
      last_action: input.action,
      last_error_code: null,
      next_retry_at: null,
      stop_reason: null,
      result_hash: resultHash,
      updated_at: now.toISOString(),
    };
    return store.append({
      issueId: current.issue_id,
      projectId: current.project_id,
      lane: current.lane,
      eventType: "codex.coordination.result-ready",
      actor,
      payload: {
        coordination_key: input.coordination_key,
        attempt_id: input.attempt_id,
        action: input.action,
        result_hash: resultHash,
      },
      now,
      mutate: (next) => {
        next.codex_coordination = value;
        return next;
      },
    });
  });
}

export function readCodexCoordinationResult({ store, current, projectId, coordinationKey }) {
  if (current.project_id !== projectId) throw problem("PROJECT_SCOPE_DENIED", "PROJECT_SCOPE_DENIED", 403);
  const value = store.readCodexCoordinationResult(current.issue_id, coordinationKey);
  if (!value) throw problem("CODEX_COORDINATION_RESULT_NOT_FOUND", "CODEX_COORDINATION_RESULT_NOT_FOUND", 404);
  return value;
}

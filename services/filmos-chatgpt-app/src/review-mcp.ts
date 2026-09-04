import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sha256 } from "./canonical.js";
import { auditRecord, type AuditSink } from "./audit.js";
import { chatGPTNoauthMeta } from "./chatgpt-auth.js";
import type { ProjectGrant } from "./grants.js";
import type { ReviewReadSource } from "./review-source.js";
import { REVIEW_ISSUE_ID_PATTERN } from "./generated-review-contract.js";
import { SecurityBoundaryError } from "./security.js";

export type ReviewReadAuditBinding = {
  liveGate?: { challengeId: string; tunneled: boolean };
  onRead?: (snapshot: {
    read_at: string;
    uri: string | null;
    version: number | null;
    state_hash: string | null;
    tool_name: string;
    request_id: string;
  }) => void;
};

export const REVIEW_READ_TOOLS = [
  ["issue_list_pending", "List pending FilmOS issues", "List pending Developer Governance issues inside the current Project Grant."],
  ["issue_get_evidence", "Read redacted issue evidence", "Read the frozen redacted Usage Evidence Pack and manifest."],
  ["issue_get_codex_assessment_blind", "Read Codex assessment with blind gate", "Before ChatGPT submits its own assessment, the Codex assessment body remains sealed."],
  ["issue_get_constitution", "Read FilmOS Constitution", "Read the versioned machine FilmOS Constitution contract."],
  ["review_get_consensus_proposal", "Read consensus proposal", "Read the current immutable dual-expert Consensus Proposal, positions, and accepted record."],
  ["review_get_architecture_options", "Read architecture options", "Read the current Requirement Delta and A/B/C architecture options."],
  ["review_get_issue_task_package", "Read issue task package", "Read the immutable per-issue Task Package that bounds candidate scope."],
  ["review_get_candidate", "Read review candidate", "Read the immutable Candidate binding for one issue."],
  ["review_get_candidate_history", "Read candidate history", "Read immutable Candidate rounds, supersede links, and stale bindings."],
  ["review_get_diff", "Read candidate diff summary", "Read candidate changed files and bounded diff summary."],
  ["review_get_ci", "Read candidate CI binding", "Read the bound GitHub Run and machine verdict."],
  ["review_get_artifact", "Read candidate artifact binding", "Read the bound artifact identifier and digest."],
  ["review_get_findings", "Read external findings", "Read findings and mandatory late-finding classifications."],
  ["review_get_codex_responses", "Read Codex finding responses", "Read Codex responses without closing external findings."],
  ["review_get_decision_template", "Read writeback decision template", "Read the exact candidate-bound template for a user-gesture Chrome writeback."],
  ["review_verify_candidate_binding", "Verify candidate binding", "Verify Base, Commit, Tree, Run, Artifact, Evidence, task package, Constitution, and nonce bindings."],
] as const;

export function reviewReadManifest(allowedNames?: readonly string[]) {
  const entries = new Map<string, (typeof REVIEW_READ_TOOLS)[number]>(REVIEW_READ_TOOLS.map((entry) => [entry[0], entry]));
  const selected = allowedNames ? allowedNames.map((name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error("UNKNOWN_REVIEW_READ_TOOL");
    return entry;
  }) : REVIEW_READ_TOOLS;
  return selected.map(([name]) => ({ name, risk: "read" as const, feature_flag: "film.review_bus_readonly" }));
}

export function registerReviewReadTools(
  server: McpServer,
  source: ReviewReadSource,
  grant: ProjectGrant,
  audit: AuditSink,
  allowedNames?: readonly string[],
  binding?: ReviewReadAuditBinding,
) {
  const entries = new Map<string, (typeof REVIEW_READ_TOOLS)[number]>(REVIEW_READ_TOOLS.map((entry) => [entry[0], entry]));
  const selected = allowedNames ? allowedNames.map((name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error("UNKNOWN_REVIEW_READ_TOOL");
    return entry;
  }) : REVIEW_READ_TOOLS;
  for (const [name, title, description] of selected) {
    const takesIssue = name !== "issue_list_pending" && name !== "issue_get_constitution";
    server.registerTool(name, {
      title,
      description,
      inputSchema: takesIssue ? z.object({
        issue_id: z.string().regex(REVIEW_ISSUE_ID_PATTERN),
        expected_project_id: z.string().min(1).max(256).optional(),
      }) : z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: chatGPTNoauthMeta(),
    }, async (input, extra) => {
      const correlationId = randomUUID();
      try {
        const argumentsObject = input as { issue_id?: string; expected_project_id?: string };
        if (takesIssue && typeof argumentsObject.expected_project_id === "string") {
          const normalizedExpectedProjectId = argumentsObject.expected_project_id.trim();
          if (!normalizedExpectedProjectId) {
            throw Object.assign(new Error("expected_project_id must not be blank"), { code: "INVALID_ARGUMENT" });
          }
          argumentsObject.expected_project_id = normalizedExpectedProjectId;
          if (normalizedExpectedProjectId !== grant.project_id) {
            throw new SecurityBoundaryError("PROJECT_SCOPE_DENIED", "Expected project does not match the current Project Grant");
          }
        }
        const value = await source.read(name, argumentsObject as Record<string, unknown>, grant.project_id, extra.signal);
        const outputHash = sha256(value);
        const readAt = new Date().toISOString();
        const version = reviewEntityVersion(value);
        binding?.onRead?.({
          read_at: readAt,
          uri: reviewReadUri(grant.project_id, name, argumentsObject.issue_id),
          version,
          state_hash: outputHash,
          tool_name: name,
          request_id: correlationId,
        });
        await audit.write(auditRecord({
          correlation_id: correlationId,
          action: name,
          grant_id: grant.grant_id,
          project_id: grant.project_id,
          outcome: "ALLOW",
          output_hash: outputHash,
          result_size: Buffer.byteLength(JSON.stringify(value)),
          ...liveAuditFields(binding, correlationId, name, readAt, outputHash),
        }));
        return { structuredContent: value, content: [{ type: "text" as const, text: `Read-only FilmOS Review Bus result ${outputHash}` }] };
      } catch (error) {
        const code = (error as { code?: string }).code ?? "REVIEW_BUS_READ_FAILED";
        const recordedAt = new Date().toISOString();
        await audit.write(auditRecord({
          correlation_id: correlationId,
          action: name,
          grant_id: grant.grant_id,
          project_id: grant.project_id,
          outcome: error instanceof SecurityBoundaryError ? "DENY" : "ERROR",
          result_size: 0,
          code,
          ...liveAuditFields(binding, correlationId, name, recordedAt),
        }));
        return {
          isError: true,
          structuredContent: { error_code: code },
          content: [{ type: "text" as const, text: JSON.stringify({ code, message: error instanceof Error ? error.message : "Review Bus read failed" }) }],
        };
      }
    });
  }
}

function liveAuditFields(
  binding: ReviewReadAuditBinding | undefined,
  requestId: string,
  toolName: string,
  timestamp: string,
  resultHash?: string,
) {
  if (!binding?.liveGate?.tunneled) return {};
  return {
    challenge_id: binding.liveGate.challengeId,
    request_id: requestId,
    tool_name: toolName,
    timestamp,
    ...(resultHash ? { result_hash: resultHash } : {}),
  };
}

function reviewReadUri(projectId: string, toolName: string, issueId?: string) {
  return `filmos://project/${projectId}/review/${toolName}/${issueId || projectId}`;
}

function reviewEntityVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).entity_version;
  return Number.isSafeInteger(version) ? Number(version) : null;
}

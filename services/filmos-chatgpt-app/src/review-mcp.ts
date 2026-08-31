import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sha256 } from "./canonical.js";
import { auditRecord, type AuditSink } from "./audit.js";
import type { ProjectGrant } from "./grants.js";
import type { ReviewReadSource } from "./review-source.js";

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

export function reviewReadManifest() {
  return REVIEW_READ_TOOLS.map(([name]) => ({ name, risk: "read" as const, feature_flag: "film.review_bus_readonly" }));
}

export function registerReviewReadTools(server: McpServer, source: ReviewReadSource, grant: ProjectGrant, audit: AuditSink) {
  for (const [name, title, description] of REVIEW_READ_TOOLS) {
    const takesIssue = name !== "issue_list_pending" && name !== "issue_get_constitution";
    server.registerTool(name, {
      title,
      description,
      inputSchema: takesIssue ? z.object({ issue_id: z.string().min(1).max(160) }) : z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input, extra) => {
      try {
        const value = await source.read(name, input as Record<string, unknown>, grant.project_id, extra.signal);
        const outputHash = sha256(value);
        await audit.write(auditRecord({ correlation_id: randomUUID(), action: name, grant_id: grant.grant_id, project_id: grant.project_id, outcome: "ALLOW", output_hash: outputHash, result_size: Buffer.byteLength(JSON.stringify(value)) }));
        return { structuredContent: value, content: [{ type: "text" as const, text: `Read-only FilmOS Review Bus result ${outputHash}` }] };
      } catch (error) {
        await audit.write(auditRecord({ correlation_id: randomUUID(), action: name, grant_id: grant.grant_id, project_id: grant.project_id, outcome: "ERROR", result_size: 0, code: (error as { code?: string }).code ?? "REVIEW_BUS_READ_FAILED" }));
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: (error as { code?: string }).code ?? "REVIEW_BUS_READ_FAILED", message: error instanceof Error ? error.message : "Review Bus read failed" }) }] };
      }
    });
  }
}

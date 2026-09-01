export interface ReviewReadSource {
  read(toolName: string, input: Record<string, unknown>, projectId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

const paths: Record<string, (input: Record<string, unknown>) => string> = {
  issue_list_pending: () => "/v1/review/pending",
  issue_get_evidence: (input) => issuePath(input, "evidence"),
  issue_get_codex_assessment_blind: (input) => issuePath(input, "codex-assessment-blind"),
  issue_get_constitution: () => "/v1/review/constitution",
  review_get_consensus_proposal: (input) => issuePath(input, "consensus"),
  review_get_architecture_options: (input) => issuePath(input, "architecture-options"),
  review_get_issue_task_package: (input) => issuePath(input, "task-package"),
  review_get_candidate: (input) => issuePath(input, "candidate"),
  review_get_candidate_history: (input) => issuePath(input, "candidate-history"),
  review_get_diff: (input) => issuePath(input, "diff"),
  review_get_ci: (input) => issuePath(input, "ci"),
  review_get_artifact: (input) => issuePath(input, "artifact"),
  review_get_findings: (input) => issuePath(input, "findings"),
  review_get_codex_responses: (input) => issuePath(input, "codex-responses"),
  review_get_decision_template: (input) => issuePath(input, "decision-template"),
  review_verify_candidate_binding: (input) => issuePath(input, "verify-candidate"),
};

export class HttpReviewReadSource implements ReviewReadSource {
  constructor(private readonly baseUrl: string, private readonly token: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("Review Bus read source must use loopback HTTP");
    if (token.length < 24) throw new Error("Review Bus read token must contain at least 24 characters");
  }

  async read(toolName: string, input: Record<string, unknown>, projectId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const path = paths[toolName];
    if (!path) throw new Error("UNKNOWN_REVIEW_READ_TOOL");
    const url = new URL(path(input), this.baseUrl);
    url.searchParams.set("project_id", projectId);
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw Object.assign(new Error(String(payload.code ?? "REVIEW_BUS_READ_FAILED")), { code: payload.code });
    assertReviewProjectScope(payload, toolName, projectId);
    return payload;
  }
}

function assertReviewProjectScope(payload: Record<string, unknown>, toolName: string, projectId: string): void {
  if (toolName === "issue_get_constitution") return;
  if (toolName === "issue_list_pending") {
    const issues = payload.issues;
    if (!Array.isArray(issues) || issues.some((issue) => !issue || typeof issue !== "object" || Array.isArray(issue) || (issue as Record<string, unknown>).project_id !== projectId)) {
      throw Object.assign(new Error("PROJECT_SCOPE_DENIED"), { code: "PROJECT_SCOPE_DENIED" });
    }
    return;
  }
  if (payload.project_id !== projectId) throw Object.assign(new Error("PROJECT_SCOPE_DENIED"), { code: "PROJECT_SCOPE_DENIED" });
}

function issuePath(input: Record<string, unknown>, view: string): string {
  const issueId = String(input.issue_id ?? "");
  if (!/^FILMOS-(?:ISSUE|ARCH)-[A-Za-z0-9-]{1,120}$/.test(issueId)) throw new Error("INVALID_ISSUE_ID");
  return `/v1/review/issues/${encodeURIComponent(issueId)}/${view}`;
}

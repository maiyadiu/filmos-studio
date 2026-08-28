import { randomUUID } from "node:crypto";
import type { FilmOSProposalItem } from "@filmos/tool-contracts";

import { canonicalJson, hmacSha256, sha256 } from "./canonical.js";
import { sanitizeForMcp } from "./security.js";

export type ProposalType = "Proposal" | "Candidate" | "Review Draft";

export type FilmOSProposalPackage = {
  schema_version: "1.0.0";
  proposal_id: string;
  source_brain: "chatgpt";
  host_project_id: string;
  base_state_hash: string;
  base_versions: Record<string, number>;
  proposal_type: ProposalType;
  summary: string;
  items: FilmOSProposalItem[];
  created_at: string;
  expires_at: string;
  content_hash: string;
  signature: string;
};

export function prepareProposalPackage(input: {
  hostProjectId: string;
  baseStateHash: string;
  baseVersions?: Record<string, number>;
  proposalType: ProposalType;
  summary: string;
  items: FilmOSProposalItem[];
  signingSecret: string;
  now?: Date;
  ttlMs?: number;
  proposalId?: string;
}): FilmOSProposalPackage {
  if (!/^[0-9a-f]{64}$/.test(input.baseStateHash)) throw new Error("base_state_hash must be SHA-256");
  if (!input.signingSecret || input.signingSecret.length < 32) throw new Error("proposal signing secret must have at least 32 characters");
  if (!input.summary.trim()) throw new Error("proposal summary is required");
  if (!input.items.length || !input.items.every((item) => isProposalItem(item, input.hostProjectId))) throw new Error("proposal items do not match the project-scoped v1 contract");
  const now = input.now ?? new Date();
  const unsigned = {
    schema_version: "1.0.0" as const,
    proposal_id: input.proposalId ?? randomUUID(),
    source_brain: "chatgpt" as const,
    host_project_id: input.hostProjectId,
    base_state_hash: input.baseStateHash,
    base_versions: input.baseVersions ?? {},
    proposal_type: input.proposalType,
    summary: String(sanitizeForMcp(input.summary)),
    items: sanitizeForMcp(input.items) as FilmOSProposalItem[],
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000)).toISOString(),
  };
  const contentHash = sha256(canonicalJson(unsigned));
  return {
    ...unsigned,
    content_hash: contentHash,
    signature: `hmac-sha256:${hmacSha256(input.signingSecret, contentHash)}`,
  };
}

function isProposalItem(value: unknown, projectId: string): value is FilmOSProposalItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",") === "item_id,kind,payload,summary,target_uri" &&
    typeof item.item_id === "string" && item.item_id.length > 0 &&
    ["Proposal", "Candidate", "Review Draft"].includes(String(item.kind)) &&
    typeof item.target_uri === "string" && item.target_uri.startsWith(`filmos://project/${projectId}/`) &&
    typeof item.summary === "string" && item.summary.length > 0 &&
    Boolean(item.payload) && typeof item.payload === "object" && !Array.isArray(item.payload);
}

import { sha256 } from "./canonical.mjs";

const secretKey = /(?:api[-_ ]?key|secret|token|cookie|authorization|password|runtime[-_ ]?key|credential)/i;
const secretValue = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{8,}|(?:session|token|cookie)=[^\s;]+)/gi;
// Evidence is safer when an ambiguous log tail is over-redacted. This deliberately
// consumes spaces through the quote/newline boundary so `Application Support`
// and other macOS/Windows paths cannot leak a suffix.
const localPath = /(?:\/(?:Users|home|var\/folders)\/[^\r\n"'<>]+|[A-Za-z]:\\Users\\[^\r\n"'<>]+)/g;

export function redactEvidence(value, aliases = new Map()) {
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, aliases));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED_SECRET]" : redactEvidence(item, aliases)]));
  if (typeof value !== "string") return value;
  return value
    .replace(secretValue, "[REDACTED_SECRET]")
    .replace(localPath, (match) => {
      const alias = aliases.get(match) ?? `[LOCAL_PATH:${sha256(match).slice(0, 12)}]`;
      aliases.set(match, alias);
      return alias;
    });
}

export function evidenceManifest({ issueId, sourceCommit, items, frozenAt }) {
  const evidenceItems = items.map((item, index) => ({
    evidenceId: item.evidence_id ?? `evidence-${String(index + 1).padStart(3, "0")}`,
    kind: item.kind,
    contentHash: sha256(item.content),
    localOnly: item.local_only !== false,
    ...(item.redacted_alias ? { redactedAlias: item.redacted_alias } : {}),
    capturedAt: item.captured_at,
  }));
  const completeness = Object.fromEntries(["reproduction", "runtime", "logs", "database", "sourceMap", "screenshot"].map((kind) => [kind, items.some((item) => item.completeness_kind === kind)]));
  const base = { issueId, sourceCommit, constitutionHash: "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41", evidenceItems, completeness, frozenAt };
  return { ...base, contentHash: sha256(base) };
}

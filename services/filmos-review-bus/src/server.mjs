#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exactObject, problem, safeEqual, sha256 } from "./canonical.mjs";
import { CONSTITUTION_HASH, CONSTITUTION_VERSION } from "./contracts.mjs";
import { ReviewBusService } from "./service.mjs";
import { ReviewBusStore } from "./store.mjs";

const DEFAULT_PORT = 17920;
const DEFAULT_DIR = resolve(homedir(), "Library/Application Support/FilmOS Studio/review-bus");
const challengeRate = new Map();

export function createReviewBusHttp({ service, store, busToken, bridgeToken, constitution, listenPort = DEFAULT_PORT, now = () => new Date() }) {
  if (String(busToken).length < 24 || String(bridgeToken).length < 24) throw new Error("Review Bus local tokens must contain at least 24 characters");
  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 400, { code: "LOOPBACK_HOST_REQUIRED" });
      applyCors(req, res);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") return preflight(req, res);
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, service: "filmos-review-bus", schema_version: "filmos.review-bus.v1", storage: "sqlite-wal", port: listenPort, constitution_version: CONSTITUTION_VERSION, constitution_content_hash: CONSTITUTION_HASH, external_network_requests: 0, openai_model_api_calls: 0 });

      const bridgeRoute = url.pathname.startsWith("/v1/bridge/");
      authenticate(req, bridgeRoute ? bridgeToken : busToken, bridgeRoute ? store.getConfiguration("revoked_bridge_token_hash") : null);
      const body = ["POST", "PUT"].includes(req.method ?? "") ? await readJson(req) : null;

      if (req.method === "POST" && url.pathname === "/v1/issues") {
        const allowed = ["project_id", "what_happened", "expected_result", "location", "blocks_work", "screenshot_refs", "risk", "lane", "issue_id", "evidence_items", "app_build_id", "app_tree", "route"];
        assertAllowedKeys(body, allowed);
        const { evidence_items: evidenceItems = [], app_build_id: appBuildId = null, app_tree: appTree = null, route = null, ...report } = body;
        const issue = service.createIssue(report, "user", now());
        const frozen = service.freezeEvidence(issue.issue_id, {
          source_commit: issue.base_commit,
          items: autoEvidenceItems({ report, evidenceItems, appBuildId, appTree, route, now: now() }),
        }, "system", now());
        return send(res, 201, issueReceipt(frozen));
      }
      let match = /^\/v1\/issues\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (match) {
        const issueId = decodeURIComponent(match[1]);
        const action = match[2] ?? "";
        if (req.method === "GET" && !action) return send(res, 200, service.readRedacted(issueId, requireProject(url)));
        if (req.method === "POST" && action === "evidence/freeze") return send(res, 200, issueReceipt(service.freezeEvidence(issueId, body, "codex", now())));
        if (req.method === "POST" && action === "assessments/codex") return send(res, 200, issueReceipt(service.submitAssessment(issueId, "codex", body, now())));
        if (req.method === "POST" && action === "assessments/chatgpt") return send(res, 200, issueReceipt(service.submitAssessment(issueId, "chatgpt", body, now())));
        if (req.method === "GET" && action === "assessments/blind") return send(res, 200, service.assessmentBlind(issueId, String(url.searchParams.get("viewer") ?? "")));
        if (req.method === "POST" && action === "consensus") return send(res, 200, issueReceipt(service.setConsensus(issueId, body, "system", now())));
        if (req.method === "POST" && action === "architecture/requirement-delta") return send(res, 200, issueReceipt(service.freezeRequirementDelta(issueId, body, "user", now())));
        if (req.method === "POST" && action === "architecture/options") return send(res, 200, issueReceipt(service.setArchitectureOptions(issueId, body.options, "codex", now())));
        if (req.method === "POST" && action === "candidates") return send(res, 200, issueReceipt(service.submitCandidate(issueId, body, "codex", now())));
        if (req.method === "POST" && action === "findings") return send(res, 200, issueReceipt(service.addFinding(issueId, body, "chatgpt", now())));
        if (req.method === "POST" && action === "finding-responses") return send(res, 200, issueReceipt(service.respondFinding(issueId, body, "codex", now())));
        if (req.method === "POST" && action === "verdicts/codex") return send(res, 200, issueReceipt(service.recordVerdict(issueId, "codex", body, now())));
        if (req.method === "POST" && action === "verdicts/chatgpt") return send(res, 200, issueReceipt(service.recordVerdict(issueId, "chatgpt", body, now())));
        if (req.method === "POST" && action === "verdicts/machine") return send(res, 200, issueReceipt(service.recordVerdict(issueId, "machine", body, now())));
        if (req.method === "POST" && action === "pilot") return send(res, 200, issueReceipt(service.deployPilot(issueId, body, "system", now())));
      }
      if (req.method === "GET" && url.pathname === "/v1/review/pending") return send(res, 200, { issues: service.pending(requireProject(url)) });
      if (req.method === "GET" && url.pathname === "/v1/review/constitution") return send(res, 200, constitution);
      if (req.method === "GET" && url.pathname.startsWith("/v1/review/issues/")) return readReviewProjection(service, url, res);

      if (req.method === "POST" && url.pathname === "/v1/bridge/challenge") {
        exactObject(body, ["purpose", "issue_id", "candidate_id", "candidate_commit"]);
        rateLimitChallenge(req, now());
        const issue = service.requireIssue(body.issue_id);
        if (body.candidate_id && issue.active_candidate?.candidate_id !== body.candidate_id) throw problem("CANDIDATE_BINDING_MISMATCH");
        if (body.candidate_commit && issue.active_candidate?.candidate_commit !== body.candidate_commit) throw problem("CANDIDATE_COMMIT_MISMATCH");
        return send(res, 201, store.issueChallenge({ purpose: body.purpose, issueId: body.issue_id, candidateId: body.candidate_id, candidateCommit: body.candidate_commit, now: now() }));
      }
      if (req.method === "POST" && url.pathname === "/v1/bridge/decision") {
        exactObject(body, ["challenge_id", "nonce", "purpose", "issue_id", "candidate_id", "candidate_commit", "decision"]);
        store.consumeChallenge({ challengeId: body.challenge_id, nonce: body.nonce, purpose: body.purpose, issueId: body.issue_id, candidateId: body.candidate_id, candidateCommit: body.candidate_commit, now: now() });
        const issue = applyBridgeDecision(service, body, now());
        return send(res, 200, { ack: true, issue_id: issue.issue_id, state: issue.state, content_hash: issue.content_hash });
      }
      if (req.method === "POST" && url.pathname === "/v1/bridge/revoke") {
        exactObject(body, []);
        if (req.headers["x-filmos-user-gesture"] !== "1") throw problem("CHROME_USER_GESTURE_REQUIRED", "CHROME_USER_GESTURE_REQUIRED", 403);
        store.setConfiguration("revoked_bridge_token_hash", sha256(bridgeToken), now());
        const revoked = store.revokeChallenges(now());
        return send(res, 200, { revoked: true, outstanding_challenges_revoked: revoked });
      }
      return send(res, 404, { code: "NOT_FOUND" });
    } catch (error) {
      return send(res, Number(error.status ?? 400), { code: error.code ?? "REVIEW_BUS_ERROR", message: error.message });
    }
  });
  return server;
}

function readReviewProjection(service, url, res) {
  const match = /^\/v1\/review\/issues\/([^/]+)\/(evidence|codex-assessment-blind|candidate|diff|ci|artifact|findings|codex-responses|decision-template|verify-candidate)$/.exec(url.pathname);
  if (!match) return send(res, 404, { code: "NOT_FOUND" });
  const issue = service.readRedacted(decodeURIComponent(match[1]), requireProject(url));
  const views = {
    evidence: { issue_id: issue.issue_id, evidence: issue.evidence ?? null },
    "codex-assessment-blind": issue.assessments?.chatgpt && issue.assessments?.codex
      ? { issue_id: issue.issue_id, own_assessment: issue.assessments.chatgpt, counterpart_assessment: issue.assessments.codex, counterpart_sealed: false, pair_complete: true, consensus_delta: issue.consensus_delta }
      : { issue_id: issue.issue_id, own_assessment: issue.assessments?.chatgpt ?? null, counterpart_assessment: null, counterpart_sealed: true, pair_complete: false },
    candidate: { issue_id: issue.issue_id, candidate: issue.active_candidate ?? null },
    diff: { issue_id: issue.issue_id, changed_files: issue.active_candidate?.changed_files ?? [], patch_summary: issue.active_candidate?.patch_summary ?? null },
    ci: { issue_id: issue.issue_id, github_run: issue.active_candidate?.github_run ?? null, machine_verdict: issue.verdicts.machine },
    artifact: { issue_id: issue.issue_id, artifact: issue.active_candidate ? {
      artifact_id: issue.active_candidate.artifact_id,
      artifact_digest: issue.active_candidate.artifact_digest,
      artifact_commit: issue.active_candidate.artifact_commit,
    } : null },
    findings: { issue_id: issue.issue_id, findings: issue.findings },
    "codex-responses": { issue_id: issue.issue_id, responses: issue.finding_responses },
    "decision-template": decisionTemplate(issue),
    "verify-candidate": verifyCandidate(issue),
  };
  return send(res, 200, views[match[2]]);
}

function applyBridgeDecision(service, body, now) {
  if (body.purpose === "CHATGPT_ASSESSMENT") return service.submitAssessment(body.issue_id, "chatgpt", body.decision, now);
  if (body.purpose === "CHATGPT_VERDICT") return service.recordVerdict(body.issue_id, "chatgpt", body.decision, now);
  if (body.purpose === "FINDING_DECISION") return service.decideFinding(body.issue_id, body.decision.finding_id, body.decision.decision, "chatgpt", now);
  throw problem("UNSUPPORTED_BRIDGE_PURPOSE");
}

function decisionTemplate(issue) {
  return { issue_id: issue.issue_id, candidate_id: issue.active_candidate?.candidate_id ?? null, candidate_commit: issue.active_candidate?.candidate_commit ?? null, allowed_purposes: ["CHATGPT_ASSESSMENT", "CHATGPT_VERDICT", "FINDING_DECISION"], constitution_content_hash: CONSTITUTION_HASH, writeback: "USER_GESTURE_CHALLENGE_REQUIRED" };
}

function verifyCandidate(issue) {
  const candidate = issue.active_candidate;
  const checks = candidate ? {
    base_commit: candidate.base_commit === issue.base_commit,
    constitution: candidate.constitution_content_hash === CONSTITUTION_HASH,
    task_package: candidate.task_package_content_hash === issue.task_package_content_hash,
    commit_present: /^[0-9a-f]{40,64}$/.test(candidate.candidate_commit),
    tree_present: /^[0-9a-f]{40,64}$/.test(candidate.tree),
    branch_present: typeof candidate.branch === "string" && candidate.branch.length > 0,
    github_run: Boolean(candidate.github_run?.id) && candidate.github_run?.head_sha === candidate.candidate_commit,
    artifact: Boolean(candidate.artifact_id) && /^sha256:[0-9a-f]{64}$/.test(candidate.artifact_digest) && candidate.artifact_commit === candidate.candidate_commit,
    evidence_index: /^[0-9a-f]{64}$/.test(candidate.evidence_index_hash),
    nonce_present: typeof candidate.candidate_nonce === "string" && candidate.candidate_nonce.length >= 16,
    changed_files: Array.isArray(candidate.changed_files),
    known_limitations: Array.isArray(candidate.known_limitations),
  } : {};
  return { issue_id: issue.issue_id, candidate_id: candidate?.candidate_id ?? null, checks, verified: candidate ? Object.values(checks).every(Boolean) : false };
}

function authenticate(req, expectedToken, revokedHash) {
  const value = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (!safeEqual(value, expectedToken) || (revokedHash && safeEqual(sha256(value), revokedHash))) throw problem("LOCAL_PAIRING_REQUIRED", "LOCAL_PAIRING_REQUIRED", 401);
}

function requireProject(url) { const value = url.searchParams.get("project_id"); if (!value) throw problem("PROJECT_SCOPE_REQUIRED"); return value; }
function issueReceipt(issue) { return { issue_id: issue.issue_id, lane: issue.lane, state: issue.state, content_hash: issue.content_hash, entity_version: issue.entity_version }; }
function autoEvidenceItems({ report, evidenceItems, appBuildId, appTree, route, now }) {
  const capturedAt = now.toISOString();
  const automatic = [
    { kind: "reproduction", completeness_kind: "reproduction", local_only: true, captured_at: capturedAt, content: { what_happened: report.what_happened, expected_result: report.expected_result, blocks_work: report.blocks_work } },
    { kind: "runtime", completeness_kind: "runtime", local_only: true, captured_at: capturedAt, content: { app_build_id: appBuildId, app_tree: appTree, platform: process.platform, architecture: process.arch, node: process.version } },
    { kind: "source_map", completeness_kind: "sourceMap", local_only: true, captured_at: capturedAt, content: { location: report.location, route } },
  ];
  if (Array.isArray(report.screenshot_refs) && report.screenshot_refs.length) automatic.push({ kind: "screenshot", completeness_kind: "screenshot", local_only: true, captured_at: capturedAt, content: { local_references: report.screenshot_refs } });
  return [...automatic, ...(Array.isArray(evidenceItems) ? evidenceItems : [])];
}
function assertAllowedKeys(value, allowed) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw problem("INVALID_BODY"); }

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) throw problem("REQUEST_TOO_LARGE", "REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw problem("INVALID_JSON"); }
}

function send(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }
function setSecurityHeaders(res) { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); }
function isLoopbackHost(value = "") { const host = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0]; return ["127.0.0.1", "localhost", "::1"].includes(host); }

function preflight(req, res) {
  const origin = req.headers.origin ?? "";
  if (!allowedOrigin(origin)) return send(res, 403, { code: "ORIGIN_DENIED" });
  applyCors(req, res); res.setHeader("Access-Control-Allow-Headers", "authorization,content-type,x-filmos-user-gesture"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.statusCode = 204; res.end();
}

function applyCors(req, res) { const origin = req.headers.origin ?? ""; if (origin && !allowedOrigin(origin)) throw problem("ORIGIN_DENIED", "ORIGIN_DENIED", 403); if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); } }
export function allowedOrigin(origin) {
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || origin === "filmos://desktop") return true;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname) && (url.pathname === "/" || url.pathname === "");
  } catch { return false; }
}

function rateLimitChallenge(req, now) {
  if (req.headers["x-filmos-user-gesture"] !== "1") throw problem("CHROME_USER_GESTURE_REQUIRED", "CHROME_USER_GESTURE_REQUIRED", 403);
  const key = String(req.socket.remoteAddress ?? "loopback"); const windowStart = now.getTime() - 60_000;
  const values = (challengeRate.get(key) ?? []).filter((time) => time > windowStart);
  if (values.length >= 20) throw problem("CHALLENGE_RATE_LIMITED", "CHALLENGE_RATE_LIMITED", 429);
  values.push(now.getTime()); challengeRate.set(key, values);
}

export function ensureLocalToken(path, explicit) {
  if (explicit) return explicit;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(36).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function startFromEnvironment(env = process.env) {
  const localDir = resolve(env.FILMOS_REVIEW_BUS_LOCAL_DIR ?? DEFAULT_DIR);
  const port = Number(env.FILMOS_REVIEW_BUS_PORT ?? DEFAULT_PORT);
  const host = env.FILMOS_REVIEW_BUS_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Review Bus must bind to loopback");
  const busToken = ensureLocalToken(resolve(localDir, "review-bus.token"), env.FILMOS_REVIEW_BUS_TOKEN);
  const bridgeToken = ensureLocalToken(resolve(localDir, "review-bridge.token"), env.FILMOS_REVIEW_BRIDGE_TOKEN);
  const store = new ReviewBusStore(resolve(localDir, "review-bus.sqlite"));
  const constitutionPath = resolve(env.FILMOS_REVIEW_CONSTITUTION_PATH ?? resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"));
  const constitution = JSON.parse(readFileSync(constitutionPath, "utf8"));
  const service = new ReviewBusService(store, { baseCommit: env.FILMOS_REVIEW_BASE_COMMIT, taskPackageContentHash: env.FILMOS_REVIEW_TASK_PACKAGE_HASH });
  const server = createReviewBusHttp({ service, store, busToken, bridgeToken, constitution, listenPort: port });
  const backupDirectory = resolve(env.FILMOS_REVIEW_BACKUP_DIR ?? resolve(localDir, "backups"));
  const backupIntervalMs = Math.max(60_000, Number(env.FILMOS_REVIEW_BACKUP_INTERVAL_MS ?? 86_400_000));
  const backupTimer = setInterval(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try { store.backup(resolve(backupDirectory, `review-bus-${stamp}.sqlite`)); } catch (error) { process.stderr.write(`Review Bus backup failed: ${error.message}\n`); }
  }, backupIntervalMs);
  backupTimer.unref();
  server.listen(port, host);
  return { server, store, service, host, port, backupTimer };
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))) {
  try { const { host, port } = startFromEnvironment(); process.stdout.write(`FilmOS Review Bus: http://${host}:${port}/healthz\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}

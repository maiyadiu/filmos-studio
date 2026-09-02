#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exactObject, problem, safeEqual, sha256 } from "./canonical.mjs";
import { CONSTITUTION_HASH, CONSTITUTION_VERSION } from "./contracts.mjs";
import { GitHubEvidenceVerifier } from "./github-evidence-verifier.mjs";
import { normalizeInstalledSubmission, normalizeStageASubmission, normalizeStagedAttachment, STAGE_A_BOOTSTRAP, SUBMISSION_SCHEMA } from "./intake-contract.mjs";
import { loadInstalledSourceIdentity } from "./installed-source-identity.mjs";
import { buildLiveRoundtripTrace } from "./live-roundtrip-trace.mjs";
import { ReviewBusService } from "./service.mjs";
import { ReviewBusStore } from "./store.mjs";

const DEFAULT_PORT = 17920;
const DEFAULT_DIR = resolve(homedir(), "Library/Application Support/FilmOS Studio/review-bus");
const challengeRate = new Map();
const pairingRate = new Map();
const BRIDGE_PURPOSES = new Set(["CHATGPT_ASSESSMENT", "CHATGPT_CONSENSUS_DECISION", "CHATGPT_REVIEW_DECISION", "CHATGPT_VERDICT", "FINDING_DECISION"]);

export function createReviewBusHttp({ service, store, busToken, bridgeToken, constitution, githubVerifier = new GitHubEvidenceVerifier(), listenPort = DEFAULT_PORT, now = () => new Date(), runtimeInstanceId = `review-runtime-${randomUUID()}`, intakeBootstrap = STAGE_A_BOOTSTRAP, installedSourceIdentity = null, sourceIdentityErrorCode = "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE" }) {
  if (String(busToken).length < 24 || String(bridgeToken).length < 24) throw new Error("Review Bus local tokens must contain at least 24 characters");
  for (const initial of store.list()) {
    if (installedSourceIdentity && initial.lane === "architecture" && initial.architecture_protocol_version !== "filmos.architecture-protocol.v2") {
      service.anchorLegacyArchitecture(initial.issue_id, installedSourceIdentity.commit, now());
    }
    service.recordRuntimeObservation(initial.issue_id, runtimeInstanceId, now());
  }
  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 400, { code: "LOOPBACK_HOST_REQUIRED" });
      applyCors(req, res);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") return preflight(req, res);
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, {
        ok: true,
        service: "filmos-review-bus",
        schema_version: "filmos.review-bus.v1",
        storage: "sqlite-wal",
        port: listenPort,
        constitution_version: CONSTITUTION_VERSION,
        constitution_content_hash: CONSTITUTION_HASH,
        installed_source_identity: installedSourceIdentity
          ? { status: "VERIFIED", build_id: installedSourceIdentity.build_id, commit: installedSourceIdentity.commit, tree: installedSourceIdentity.tree, content_hash: installedSourceIdentity.content_hash }
          : { status: "UNAVAILABLE", error_code: sourceIdentityErrorCode },
        external_network_requests: 0,
        openai_model_api_calls: 0,
      });

      const bridgeRoute = url.pathname.startsWith("/v1/bridge/");
      const pairingRoute = req.method === "POST" && url.pathname === "/v1/bridge/pair";
      const bridgeIdentity = bridgeRoute && !pairingRoute
        ? authenticateBridge(req, bridgeToken, store, now())
        : (!bridgeRoute ? authenticate(req, busToken, null) : null);
      const attachmentUpload = req.method === "POST" && (/^\/v1\/issues\/[^/]+\/attachments$/.test(url.pathname)
        || /^\/v1\/submissions\/[^/]+\/attachments$/.test(url.pathname));
      const body = ["POST", "PUT"].includes(req.method ?? "") ? await readJson(req, attachmentUpload ? 36 * 1024 * 1024 : 1_048_576) : null;

      if (req.method === "POST" && url.pathname === "/v1/submissions") {
        const stageABootstrap = body?.submission_id === intakeBootstrap.submission_id;
        if (stageABootstrap && !store.stageABootstrapAvailableFor(intakeBootstrap.submission_id)) throw problem("BOOTSTRAP_ALREADY_CONSUMED");
        if (!stageABootstrap && !installedSourceIdentity) throw problem(sourceIdentityErrorCode, sourceIdentityErrorCode, 503);
        const normalized = stageABootstrap
          ? normalizeStageASubmission(body, intakeBootstrap)
          : normalizeInstalledSubmission(body, installedSourceIdentity);
        const status = store.stageSubmission({
          submissionId: normalized.payload.submission_id,
          projectId: normalized.payload.project_id,
          captureSchema: SUBMISSION_SCHEMA,
          captureHash: normalized.captureHash,
          capturePayload: normalized.payload,
          now: now(),
        });
        return send(res, status.idempotent_replay ? 200 : 201, status);
      }
      const submissionRoute = /^\/v1\/submissions\/([^/]+)(?:\/(attachments|finalize))?$/.exec(url.pathname);
      if (submissionRoute) {
        const submissionId = decodeURIComponent(submissionRoute[1]);
        const action = submissionRoute[2] ?? "";
        if (req.method === "GET" && !action) {
          const status = store.submissionStatus(submissionId);
          if (status.project_id !== requireProject(url)) throw problem("PROJECT_SCOPE_DENIED", "PROJECT_SCOPE_DENIED", 403);
          return send(res, 200, status);
        }
        if (req.method === "POST" && action === "attachments") {
          const attachment = normalizeStagedAttachment(body);
          const staged = store.stageAttachment({
            submissionId,
            attachmentId: attachment.attachment_id,
            mediaType: attachment.media_type,
            originalName: attachment.original_name,
            sizeBytes: attachment.size_bytes,
            digest: attachment.sha256,
            bytes: attachment.bytes,
            capturedAt: attachment.captured_at,
            now: now(),
          });
          return send(res, staged.idempotent_replay ? 200 : 201, staged);
        }
        if (req.method === "POST" && action === "finalize") {
          exactObject(body, ["project_id", "capture_hash"]);
          if (typeof body.project_id !== "string" || !/^[a-f0-9]{64}$/.test(body.capture_hash ?? "")) throw problem("INVALID_FINALIZE_REQUEST");
          const finalized = store.finalizeSubmission({ submissionId, projectId: body.project_id, captureHash: body.capture_hash, bootstrap: intakeBootstrap, now: now() }, ({ capture, attachments, bindAttachments, sourceIdentity }) => {
            const report = {
              project_id: capture.project_id,
              what_happened: capture.what_happened,
              expected_result: capture.expected_result,
              location: capture.location,
              blocks_work: capture.blocks_work,
              captured_at: capture.captured_at,
              suggested_lane: capture.suggested_lane,
              risk: capture.risk,
              allowed_change_scope: capture.allowed_change_scope,
              screenshot_refs: [],
            };
            const issue = service.createIssue(report, "user", now(), {
              submissionId,
              baseCommit: sourceIdentity.commit,
              ...(sourceIdentity.schema_version === "filmos.source-identity.bootstrap.v1" ? { architectureProtocolVersion: null } : {}),
            });
            service.recordRuntimeObservation(issue.issue_id, runtimeInstanceId, now());
            const boundAttachments = bindAttachments(issue.issue_id);
            return service.freezeEvidence(issue.issue_id, {
              source_commit: sourceIdentity.commit,
              items: autoEvidenceItems({
                report,
                evidenceItems: attachmentEvidenceItems(boundAttachments),
                appBuildId: capture.app_build_id,
                appTree: capture.app_tree,
                route: capture.route,
                contextSnapshot: capture.context_snapshot,
                capturedAt: capture.captured_at,
              }),
            }, "system", now());
          });
          const finalizedIssue = service.requireIssue(finalized.receipt.formal_issue_id);
          if (installedSourceIdentity && finalizedIssue.lane === "architecture" && finalizedIssue.architecture_protocol_version !== "filmos.architecture-protocol.v2") {
            service.anchorLegacyArchitecture(finalizedIssue.issue_id, installedSourceIdentity.commit, now());
          }
          return send(res, finalized.idempotent_replay ? 200 : 201, finalized);
        }
      }
      if (req.method === "POST" && url.pathname === "/v1/issues") {
        throw problem("INTAKE_PROTOCOL_UPGRADE_REQUIRED");
      }
      let match = /^\/v1\/issues\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (match) {
        const issueId = decodeURIComponent(match[1]);
        const action = match[2] ?? "";
        if (req.method === "GET" && !action) return send(res, 200, service.readRedacted(issueId, requireProject(url)));
        if (req.method === "POST" && action === "attachments") {
          const stored = service.storeAttachment(issueId, body, "user", now());
          return send(res, 201, { ...issueReceipt(stored.issue), attachment: stored.attachment });
        }
        if (req.method === "POST" && action === "evidence/freeze") return send(res, 200, issueReceipt(service.freezeEvidence(issueId, body, "codex", now())));
        if (req.method === "POST" && action === "assessments/codex") return send(res, 200, issueReceipt(service.submitAssessment(issueId, "codex", body, now())));
        if (req.method === "POST" && action === "assessments/chatgpt") return send(res, 200, issueReceipt(service.submitAssessment(issueId, "chatgpt", body, now())));
        if (req.method === "POST" && action === "architecture/assessments/begin") return send(res, 200, issueReceipt(service.beginArchitectureAssessments(issueId, "review-codex-coordinator", now())));
        if (req.method === "GET" && action === "assessments/blind") return send(res, 200, service.assessmentBlind(issueId, String(url.searchParams.get("viewer") ?? "")));
        if (req.method === "POST" && action === "consensus/responses/codex") return send(res, 200, issueReceipt(service.respondConsensus(issueId, "codex", body, now())));
        if (req.method === "POST" && action === "architecture/consensus/propose") return send(res, 200, issueReceipt(service.proposeArchitectureConsensus(issueId, "review-codex-coordinator", now())));
        if (req.method === "POST" && action === "architecture/task-package/freeze") return send(res, 200, issueReceipt(service.freezeArchitectureTaskPackage(issueId, body, "codex", now())));
        if (req.method === "POST" && action === "architecture/implementation/start") return send(res, 200, issueReceipt(service.startArchitectureImplementation(issueId, "codex", now())));
        if (req.method === "POST" && action === "consensus/rounds/next") return send(res, 200, issueReceipt(service.startNextAssessmentRound(issueId, "codex", now())));
        if (req.method === "POST" && action === "architecture/requirement-delta") return send(res, 200, issueReceipt(service.freezeRequirementDelta(issueId, body, "user", now())));
        if (req.method === "POST" && action === "architecture/options") return send(res, 200, issueReceipt(service.setArchitectureOptions(issueId, body.options, "codex", now())));
        if (req.method === "POST" && action === "architecture/accept-option") return send(res, 200, issueReceipt(service.acceptArchitectureOption(issueId, body, "user", now())));
        if (req.method === "POST" && action === "candidates") {
          const remoteVerification = await githubVerifier.verify(body);
          return send(res, 200, issueReceipt(service.submitCandidate(issueId, { ...body, github_remote_verification: remoteVerification }, "codex", now())));
        }
        if (req.method === "POST" && action === "rounds/next") return send(res, 200, issueReceipt(service.startNextRound(issueId, "codex", now())));
        if (req.method === "POST" && action === "findings") return send(res, 200, issueReceipt(service.addFinding(issueId, body, "chatgpt", now())));
        if (req.method === "POST" && action === "finding-responses") return send(res, 200, issueReceipt(service.respondFinding(issueId, body, "codex", now())));
        if (req.method === "POST" && action === "verdicts/codex") return send(res, 200, issueReceipt(service.recordVerdict(issueId, "codex", body, now())));
        if (req.method === "POST" && action === "verdicts/chatgpt") return send(res, 200, issueReceipt(service.recordVerdict(issueId, "chatgpt", body, now())));
        if (req.method === "POST" && action === "verdicts/machine") return send(res, 200, issueReceipt(service.recordVerdict(issueId, "machine", body, now())));
        if (req.method === "POST" && action === "pilot") return send(res, 200, issueReceipt(service.deployPilot(issueId, body, "system", now())));
        if (req.method === "POST" && action === "codex-coordination") return send(res, 200, issueReceipt(service.recordCodexCoordination(issueId, body, "review-codex-coordinator", now())));
        if (req.method === "POST" && action === "codex-coordination/result") return send(res, 200, issueReceipt(service.recordCodexCoordinationResult(issueId, body, "review-codex-coordinator", now()).value));
      }
      if (req.method === "GET" && url.pathname === "/v1/review/pending") {
        const projectId = requireProject(url);
        const issues = service.pending(projectId);
        if (readConsumer(req) === "chatgpt-mcp") for (const issue of issues) {
          const current = service.readRedacted(issue.issue_id, projectId);
          store.recordReadReceipt({
            issueId: current.issue_id,
            projectId,
            consumer: "chatgpt-mcp",
            toolName: "issue_list_pending",
            projectionContentHash: current.content_hash,
            evidenceManifestHash: current.evidence?.manifest?.contentHash ?? current.evidence?.manifest?.content_hash ?? null,
            now: now(),
          });
        }
        return send(res, 200, { issues });
      }
      if (req.method === "GET" && url.pathname === "/v1/review/internal/pending") return send(res, 200, { issues: service.pendingAll() });
      if (req.method === "GET" && url.pathname === "/v1/review/constitution") return send(res, 200, constitution);
      if (req.method === "GET" && url.pathname === "/v1/review/admin/issues") return send(res, 200, { issues: service.listRedactedAdmin() });
      const adminIssue = /^\/v1\/review\/admin\/issues\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && adminIssue) return send(res, 200, service.readRedactedAdmin(decodeURIComponent(adminIssue[1])));
      if (req.method === "POST" && url.pathname === "/v1/review/pairing-codes") {
        exactObject(body, []);
        return send(res, 201, store.createPairingCode({ now: now() }));
      }
      if (req.method === "GET" && url.pathname === "/v1/review/bridge-clients") return send(res, 200, { clients: store.listBridgeClients() });
      const revokeClient = /^\/v1\/review\/bridge-clients\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === "POST" && revokeClient) {
        exactObject(body, []);
        return send(res, 200, { revoked: true, client: store.revokeBridgeClient(decodeURIComponent(revokeClient[1]), now()) });
      }
      const internalAttachment = /^\/v1\/review\/internal\/issues\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && internalAttachment) {
        const value = service.readLocalAttachment(decodeURIComponent(internalAttachment[1]), decodeURIComponent(internalAttachment[2]), requireProject(url));
        return sendBinary(res, 200, value.bytes, value.metadata.media_type, value.metadata.sha256);
      }
      const internal = /^\/v1\/review\/internal\/issues\/([^/]+)\/full-context$/.exec(url.pathname);
      if (req.method === "GET" && internal) return send(res, 200, service.readLocalFull(decodeURIComponent(internal[1]), requireProject(url)));
      const coordinationResult = /^\/v1\/review\/internal\/issues\/([^/]+)\/codex-coordination\/results\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && coordinationResult) return send(res, 200, service.readCodexCoordinationResult(decodeURIComponent(coordinationResult[1]), requireProject(url), decodeURIComponent(coordinationResult[2])));
      const intakeConfirmation = /^\/v1\/review\/internal\/issues\/([^/]+)\/intake-confirmation$/.exec(url.pathname);
      if (req.method === "GET" && intakeConfirmation) {
        const issueId = decodeURIComponent(intakeConfirmation[1]);
        const projectId = requireProject(url);
        const issue = service.readRedacted(issueId, projectId);
        if (!issue.submission_id) throw problem("SUBMISSION_RECEIPT_NOT_FOUND", "SUBMISSION_RECEIPT_NOT_FOUND", 404);
        const submission = store.submissionStatus(issue.submission_id);
        if (!submission.receipt) throw problem("SUBMISSION_RECEIPT_NOT_FOUND", "SUBMISSION_RECEIPT_NOT_FOUND", 404);
        const receipts = store.readReceipts(issueId, "chatgpt-mcp");
        return send(res, 200, {
          submission_id: issue.submission_id,
          formal_issue_id: issueId,
          project_id: projectId,
          capture_hash: submission.capture_hash,
          receipt_hash: submission.receipt.receipt_hash,
          projection_content_hash: submission.receipt.projection_content_hash,
          current_projection_content_hash: issue.content_hash,
          evidence_manifest_hash: submission.receipt.evidence_manifest_hash,
          current_evidence_manifest_hash: issue.evidence?.manifest?.contentHash ?? issue.evidence?.manifest?.content_hash ?? null,
          pending_read: receipts.some((receipt) => receipt.tool_name === "issue_list_pending"),
          evidence_read: receipts.some((receipt) => receipt.tool_name === "issue_get_evidence"),
          receipts,
        });
      }
      const liveTrace = /^\/v1\/review\/internal\/issues\/([^/]+)\/live-roundtrip-trace$/.exec(url.pathname);
      if (req.method === "GET" && liveTrace) {
        const issueId = decodeURIComponent(liveTrace[1]);
        const issue = service.readLocalFull(issueId, requireProject(url));
        return send(res, 200, buildLiveRoundtripTrace(issue, store.events(issueId), { eventChainVerified: store.verifyEventChain(issueId), generatedAt: now() }));
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/review/issues/")) return readReviewProjection(service, store, url, req, res, now());

      if (pairingRoute) {
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? "")) throw problem("CHROME_EXTENSION_ORIGIN_REQUIRED", "CHROME_EXTENSION_ORIGIN_REQUIRED", 403);
        rateLimitPairing(req, now());
        exactObject(body, ["pairing_code", "client_name"]);
        if (!/^\d{6}$/.test(body.pairing_code) || typeof body.client_name !== "string" || !body.client_name.trim() || body.client_name.length > 80) throw problem("INVALID_PAIRING_REQUEST");
        return send(res, 201, store.consumePairingCode({ pairingCode: body.pairing_code, clientName: body.client_name.trim(), now: now() }));
      }

      if (req.method === "POST" && url.pathname === "/v1/bridge/challenge") {
        exactObject(body, ["purpose", "issue_id", "candidate_id", "candidate_commit"]);
        if (!BRIDGE_PURPOSES.has(body.purpose)) throw problem("UNSUPPORTED_BRIDGE_PURPOSE");
        rateLimitChallenge(req, now());
        const issue = service.requireIssue(body.issue_id);
        if (body.candidate_id && issue.active_candidate?.candidate_id !== body.candidate_id) throw problem("CANDIDATE_BINDING_MISMATCH");
        if (body.candidate_commit && issue.active_candidate?.candidate_commit !== body.candidate_commit) throw problem("CANDIDATE_COMMIT_MISMATCH");
        return send(res, 201, store.issueChallenge({ purpose: body.purpose, issueId: body.issue_id, candidateId: body.candidate_id, candidateCommit: body.candidate_commit, now: now() }));
      }
      if (req.method === "POST" && url.pathname === "/v1/bridge/decision") {
        exactObject(body, ["challenge_id", "nonce", "purpose", "issue_id", "candidate_id", "candidate_commit", "decision"]);
        if (!BRIDGE_PURPOSES.has(body.purpose)) throw problem("UNSUPPORTED_BRIDGE_PURPOSE");
        const decisionTime = now();
        const issue = store.consumeChallengeAndApply(
          { challengeId: body.challenge_id, nonce: body.nonce, purpose: body.purpose, issueId: body.issue_id, candidateId: body.candidate_id, candidateCommit: body.candidate_commit, now: decisionTime },
          () => applyBridgeDecision(service, body, decisionTime),
        );
        return send(res, 200, { ack: true, issue_id: issue.issue_id, state: issue.state, content_hash: issue.content_hash });
      }
      if (req.method === "POST" && url.pathname === "/v1/bridge/revoke") {
        exactObject(body, []);
        if (req.headers["x-filmos-user-gesture"] !== "1") throw problem("CHROME_USER_GESTURE_REQUIRED", "CHROME_USER_GESTURE_REQUIRED", 403);
        if (bridgeIdentity?.kind === "client") store.revokeBridgeClient(bridgeIdentity.client.client_id, now());
        else store.setConfiguration("revoked_bridge_token_hash", sha256(bridgeToken), now());
        const revoked = store.revokeChallenges(now());
        return send(res, 200, { revoked: true, outstanding_challenges_revoked: revoked });
      }
      return send(res, 404, { code: "NOT_FOUND" });
    } catch (error) {
      const status = Number(error.status ?? 400);
      const code = safeProblemCode(error.code);
      return send(res, status, { status, code, message: code, retryable: retryableProblem(code, status) });
    }
  });
  return server;
}

function readReviewProjection(service, store, url, req, res, now) {
  const match = /^\/v1\/review\/issues\/([^/]+)\/(evidence|codex-assessment-blind|consensus|architecture-options|task-package|candidate|candidate-history|diff|ci|artifact|findings|codex-responses|decision-template|verify-candidate)$/.exec(url.pathname);
  if (!match) return send(res, 404, { code: "NOT_FOUND" });
  const issue = service.readRedacted(decodeURIComponent(match[1]), requireProject(url));
  const scope = { issue_id: issue.issue_id, project_id: issue.project_id };
  const views = {
    evidence: { ...scope, evidence: issue.evidence ?? null },
    "codex-assessment-blind": issue.assessments?.chatgpt && issue.assessments?.codex
      ? { ...scope, own_assessment: issue.assessments.chatgpt, counterpart_assessment: issue.assessments.codex, counterpart_sealed: false, pair_complete: true, consensus_delta: issue.consensus_delta }
      : { ...scope, own_assessment: issue.assessments?.chatgpt ?? null, counterpart_assessment: null, counterpart_sealed: true, pair_complete: false },
    consensus: {
      ...scope,
      assessment_round: issue.assessment_round ?? 1,
      history: issue.assessment_round_history ?? [],
      proposal: issue.consensus_proposal ?? null,
      responses: issue.consensus_responses ?? [],
      record: issue.consensus_record ?? null,
    },
    "architecture-options": { ...scope, requirement_delta: issue.requirement_delta ?? null, options: issue.architecture_options ?? [] },
    "task-package": { ...scope, task_package: issue.issue_task_package ?? null },
    candidate: { ...scope, candidate: issue.active_candidate ?? null },
    "candidate-history": { ...scope, active_candidate_id: issue.active_candidate?.candidate_id ?? null, history: issue.candidate_history ?? [], stale_bindings: issue.stale_candidate_bindings ?? [] },
    diff: { ...scope, changed_files: issue.active_candidate?.changed_files ?? [], patch_summary: issue.active_candidate?.patch_summary ?? null },
    ci: { ...scope, github_run: issue.active_candidate?.github_run ?? null, machine_verdict: issue.verdicts.machine },
    artifact: { ...scope, artifact: issue.active_candidate ? {
      artifact_id: issue.active_candidate.artifact_id,
      artifact_digest: issue.active_candidate.artifact_digest,
      artifact_commit: issue.active_candidate.artifact_commit,
    } : null },
    findings: { ...scope, findings: issue.findings },
    "codex-responses": { ...scope, responses: issue.finding_responses },
    "decision-template": decisionTemplate(issue),
    "verify-candidate": verifyCandidate(issue),
  };
  if (match[2] === "evidence" && readConsumer(req) === "chatgpt-mcp") store.recordReadReceipt({
    issueId: issue.issue_id,
    projectId: issue.project_id,
    consumer: "chatgpt-mcp",
    toolName: "issue_get_evidence",
    projectionContentHash: issue.content_hash,
    evidenceManifestHash: issue.evidence?.manifest?.contentHash ?? issue.evidence?.manifest?.content_hash ?? null,
    now,
  });
  return send(res, 200, views[match[2]]);
}

function applyBridgeDecision(service, body, now) {
  if (body.purpose === "CHATGPT_ASSESSMENT") return service.submitAssessment(body.issue_id, "chatgpt", body.decision, now);
  if (body.purpose === "CHATGPT_CONSENSUS_DECISION") return service.respondConsensus(body.issue_id, "chatgpt", body.decision, now);
  if (body.purpose === "CHATGPT_REVIEW_DECISION") return service.submitChatGPTReviewDecision(body.issue_id, body.decision, "chatgpt", now);
  if (body.purpose === "CHATGPT_VERDICT") return service.recordVerdict(body.issue_id, "chatgpt", body.decision, now);
  if (body.purpose === "FINDING_DECISION") return service.decideFinding(body.issue_id, body.decision.finding_id, body.decision.decision, "chatgpt", now);
  throw problem("UNSUPPORTED_BRIDGE_PURPOSE");
}

function decisionTemplate(issue) {
  return {
    issue_id: issue.issue_id,
    project_id: issue.project_id,
    assessment_round: issue.assessment_round ?? 1,
    candidate_id: issue.active_candidate?.candidate_id ?? null,
    candidate_commit: issue.active_candidate?.candidate_commit ?? null,
    evidence_manifest_hash: issue.evidence?.manifest?.contentHash ?? issue.evidence?.manifest?.content_hash ?? null,
    allowed_purposes: [...BRIDGE_PURPOSES],
    constitution_content_hash: CONSTITUTION_HASH,
    writeback: "USER_GESTURE_CHALLENGE_REQUIRED",
  };
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
    github_remote_verified: candidate.github_remote_verification?.status === "VERIFIED" && candidate.github_remote_verification?.candidate_commit === candidate.candidate_commit,
    nonce_present: typeof candidate.candidate_nonce === "string" && candidate.candidate_nonce.length >= 16,
    changed_files: Array.isArray(candidate.changed_files),
    known_limitations: Array.isArray(candidate.known_limitations),
  } : {};
  return { issue_id: issue.issue_id, project_id: issue.project_id, candidate_id: candidate?.candidate_id ?? null, checks, verified: candidate ? Object.values(checks).every(Boolean) : false };
}

function authenticate(req, expectedToken, revokedHash) {
  const value = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (!safeEqual(value, expectedToken) || (revokedHash && safeEqual(sha256(value), revokedHash))) throw problem("LOCAL_PAIRING_REQUIRED", "LOCAL_PAIRING_REQUIRED", 401);
}
function authenticateBridge(req, legacyToken, store, now) {
  const value = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
  const revokedHash = store.getConfiguration("revoked_bridge_token_hash");
  if (safeEqual(value, legacyToken) && !(revokedHash && safeEqual(sha256(value), revokedHash))) return { kind: "legacy" };
  const client = value.length >= 24 ? store.authenticateBridgeClient(value, now) : null;
  if (!client) throw problem("LOCAL_PAIRING_REQUIRED", "LOCAL_PAIRING_REQUIRED", 401);
  return { kind: "client", client };
}

function requireProject(url) { const value = url.searchParams.get("project_id"); if (!value) throw problem("PROJECT_SCOPE_REQUIRED"); return value; }
function readConsumer(req) { return req.headers["x-filmos-read-consumer"] === "chatgpt-mcp" ? "chatgpt-mcp" : null; }
function issueReceipt(issue) {
  return {
    issue_id: issue.issue_id,
    lane: issue.lane,
    state: issue.state,
    content_hash: issue.content_hash,
    entity_version: issue.entity_version,
    ...(issue.operation_receipt ? { operation_receipt: issue.operation_receipt } : {}),
    ...(typeof issue.idempotent_replay === "boolean" ? { idempotent_replay: issue.idempotent_replay } : {}),
  };
}
function autoEvidenceItems({ report, evidenceItems, appBuildId, appTree, route, contextSnapshot, capturedAt }) {
  const automatic = [
    { kind: "reproduction", completeness_kind: "reproduction", local_only: true, captured_at: capturedAt, content: { what_happened: report.what_happened, expected_result: report.expected_result, blocks_work: report.blocks_work } },
    { kind: "runtime", completeness_kind: "runtime", local_only: true, captured_at: capturedAt, content: { app_build_id: appBuildId, app_tree: appTree, platform: process.platform, architecture: process.arch, node: process.version, runtime_status: contextSnapshot?.runtimeStatus ?? {}, provider_status: contextSnapshot?.providerStatus ?? {} } },
    { kind: "source_map", completeness_kind: "sourceMap", local_only: true, captured_at: capturedAt, content: { location: report.location, route } },
  ];
  if (contextSnapshot) automatic.push(
    { kind: "logs", completeness_kind: "logs", local_only: true, captured_at: capturedAt, content: { recent_audit_ids: contextSnapshot.recentAuditIds ?? [], recent_error_codes: contextSnapshot.recentErrorCodes ?? [] } },
    { kind: "database", completeness_kind: "database", local_only: true, captured_at: capturedAt, content: { project_id: contextSnapshot.domainProjectId ?? contextSnapshot.projectId ?? report.project_id, content_unit_id: contextSnapshot.contentUnitId ?? null, scene_id: contextSnapshot.sceneId ?? null, director_unit_id: contextSnapshot.directorUnitId ?? null, shot_id: contextSnapshot.shotId ?? null } },
    { kind: "workbench_context", completeness_kind: "context", local_only: true, captured_at: capturedAt, content: contextSnapshot },
  );
  if (Array.isArray(report.screenshot_refs) && report.screenshot_refs.length) automatic.push({ kind: "screenshot", completeness_kind: "screenshot", local_only: true, captured_at: capturedAt, content: { local_references: report.screenshot_refs } });
  return [...automatic, ...(Array.isArray(evidenceItems) ? evidenceItems : [])];
}
function attachmentEvidenceItems(attachments) {
  return attachments.map((attachment) => ({
    evidence_id: `evidence-${attachment.attachment_id}`,
    kind: attachment.media_type.startsWith("image/") ? "screenshot" : "attachment",
    completeness_kind: attachment.media_type.startsWith("image/") ? "screenshot" : "attachment",
    local_only: true,
    redacted_alias: attachment.redacted_alias,
    captured_at: attachment.captured_at,
    content: {
      attachment_id: attachment.attachment_id,
      sha256: attachment.sha256,
      media_type: attachment.media_type,
      size_bytes: attachment.size_bytes,
      redacted_alias: attachment.redacted_alias,
    },
  }));
}
function assertAllowedKeys(value, allowed) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw problem("INVALID_BODY"); }

function safeProblemCode(value) { return /^[A-Z0-9_]{1,96}$/.test(String(value ?? "")) ? String(value) : "REVIEW_BUS_ERROR"; }
function retryableProblem(code, status) {
  if (status === 503 && ["INTAKE_TEMPORARILY_UNAVAILABLE", "MCP_READBACK_UNAVAILABLE", "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE"].includes(code)) return true;
  return false;
}

async function readJson(req, limit = 1_048_576) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw problem("REQUEST_TOO_LARGE", "REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw problem("INVALID_JSON"); }
}

function send(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }
function sendBinary(res, status, bytes, mediaType, digest) { res.statusCode = status; res.setHeader("Content-Type", mediaType); res.setHeader("Content-Length", String(bytes.length)); res.setHeader("Digest", `sha-256=${Buffer.from(digest, "hex").toString("base64")}`); res.setHeader("X-FilmOS-SHA256", digest); res.end(bytes); }
function setSecurityHeaders(res) { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); }
function isLoopbackHost(value = "") { const host = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0]; return ["127.0.0.1", "localhost", "::1"].includes(host); }

function preflight(req, res) {
  const origin = req.headers.origin ?? "";
  if (!allowedOrigin(origin)) return send(res, 403, { code: "ORIGIN_DENIED" });
  applyCors(req, res); res.setHeader("Access-Control-Allow-Headers", "authorization,content-type,x-filmos-user-gesture,x-filmos-read-consumer"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.statusCode = 204; res.end();
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

function rateLimitPairing(req, now) {
  const key = String(req.socket.remoteAddress ?? "loopback"); const windowStart = now.getTime() - 60_000;
  const values = (pairingRate.get(key) ?? []).filter((time) => time > windowStart);
  if (values.length >= 10) throw problem("PAIRING_RATE_LIMITED", "PAIRING_RATE_LIMITED", 429);
  values.push(now.getTime()); pairingRate.set(key, values);
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
  let installedSourceIdentity = null;
  let sourceIdentityErrorCode = "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE";
  try {
    installedSourceIdentity = loadInstalledSourceIdentity({
      sourceIdentityPath: env.FILMOS_INSTALLED_SOURCE_IDENTITY_PATH,
      internalRuntimePath: env.FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH,
      repositoryLocatorPath: env.FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR,
    });
  } catch (error) {
    sourceIdentityErrorCode = safeProblemCode(error?.code ?? "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE");
  }
  const service = new ReviewBusService(store, { taskPackageContentHash: env.FILMOS_REVIEW_TASK_PACKAGE_HASH });
  const githubVerifier = new GitHubEvidenceVerifier({ repository: env.FILMOS_REVIEW_GITHUB_REPOSITORY ?? "maiyadiu/filmos-studio" });
  const server = createReviewBusHttp({ service, store, busToken, bridgeToken, constitution, githubVerifier, listenPort: port, installedSourceIdentity, sourceIdentityErrorCode });
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

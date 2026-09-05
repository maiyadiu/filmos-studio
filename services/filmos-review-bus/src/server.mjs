#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ARCHITECTURE_PROTOCOL_VERSION } from "./architecture-protocol.mjs";
import { exactObject, problem, safeEqual, sha256 } from "./canonical.mjs";
import { CONSTITUTION_HASH, CONSTITUTION_VERSION, TASK_PACKAGE_HASH } from "./contracts.mjs";
import { REVIEW_ERROR_CODE_PATTERN } from "./generated-review-contract.mjs";
import { GitHubEvidenceVerifier } from "./github-evidence-verifier.mjs";
import { normalizeInstalledSubmission, normalizeStageASubmission, normalizeStagedAttachment, STAGE_A_BOOTSTRAP, SUBMISSION_SCHEMA } from "./intake-contract.mjs";
import { loadInstalledSourceIdentity } from "./installed-source-identity.mjs";
import { buildLiveRoundtripTrace } from "./live-roundtrip-trace.mjs";
import { ReviewBusService } from "./service.mjs";
import { REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ, REVIEW_BUS_RUNTIME_MODE_NORMAL, ReviewBusStore, assertExternalReadRuntimeCapability } from "./store.mjs";

const DEFAULT_PORT = 17920;
const DEFAULT_DIR = resolve(homedir(), "Library/Application Support/FilmOS Studio/review-bus");
const DEFAULT_DATABASE = resolve(DEFAULT_DIR, "review-bus.sqlite");
const DEFAULT_SOURCE_ROOT = resolve(import.meta.dirname, "../../..");
const SEAL_IDENTITY_RESOURCES_RELATIVE = ".local/phase5a4-seal-runtime/Resources";
const EXTERNAL_READ_IDENTITY_RESOURCES_RELATIVE = ".local/phase7-external-read-runtime/Resources";
const PHASE_7_CONSTITUTION_FILE_SHA256 = "a8dd0d55d8ff394a0271b5db3f83124c04efaf08401da0bc8c9b060fc732c4d9";
const challengeRate = new Map();
const pairingRate = new Map();
const BRIDGE_PURPOSES = new Set(["CHATGPT_ASSESSMENT", "CHATGPT_CONSENSUS_DECISION", "CHATGPT_REVIEW_DECISION", "CHATGPT_VERDICT", "FINDING_DECISION"]);
const REVIEW_BUS_RUNTIME_MODES = new Set([REVIEW_BUS_RUNTIME_MODE_NORMAL, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ]);
const SEAL_ERROR_CODES = new Set([
  "INVALID_REVIEW_BUS_RUNTIME_MODE",
  "SEAL_RUNTIME_DATABASE_REQUIRED",
  "SEAL_RUNTIME_EVIDENCE_ROOT_REQUIRED",
  "SEAL_RUNTIME_SCHEMA_MISMATCH",
  "SEAL_RUNTIME_TOKEN_REQUIRED",
  "SEAL_RUNTIME_SOURCE_IDENTITY_REQUIRED",
  "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH",
  "SEAL_RUNTIME_TARGET_REQUIRED",
  "SEAL_RUNTIME_TARGET_MISMATCH",
  "SEAL_RUNTIME_ROUTE_DENIED",
  "EXTERNAL_READ_RUNTIME_DATABASE_REQUIRED",
  "EXTERNAL_READ_RUNTIME_PENDING_MISMATCH",
  "EXTERNAL_READ_RUNTIME_RECEIPT_SET_MISMATCH",
  "EXTERNAL_READ_RUNTIME_ROUTE_DENIED",
  "EXTERNAL_READ_RUNTIME_TARGET_MISMATCH",
  "EXTERNAL_READ_RUNTIME_TARGET_REQUIRED",
  "EXTERNAL_READ_RUNTIME_WRITE_BUDGET_EXCEEDED",
  "EXTERNAL_READ_RUNTIME_WRITE_DENIED",
]);
const PHASE_5A4_SEAL_TARGET = Object.freeze({
  projectId: "ca40511be3ae12112101cc1de6059b95",
  issueId: "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b",
  submissionId: "FILMOS-SUBMISSION-b3274782-30a0-44a1-a05e-01730678da8b",
  actor: "codex",
  assessmentRound: 1,
  entityVersion: 124,
  issueEventCount: 124,
  lastEventHash: "82912bd2fb0d6d7dc0d325fb46224ad3b2ed598ff9925cb75f11d33ae4e89c23",
  projectionHash: "e43bb789f4006ce9eff4c00dcbc9d047fee4ff178d987857f55450b72060ee33",
  intakeReceiptHash: "dfe3907891533dbf29b6602d7cb6fdc87728cfd03fdd4696f06b447dc6910f35",
});
const PHASE_5A4_SEAL_DATABASE_ORIGIN = Object.freeze({
  device: 16777234,
  inode: 101926348,
  size: 12910592,
  sha256: "81f74d8692c03f688fa42683620ccdc70a4f9ad53644482690c9992dde2a65a2",
  journalMode: "wal",
  pageCount: 3155,
  schemaVersion: 25,
  walSha256: "4a4209437e690f81be71905414afa1c20a85de713a2695ca2f377b70a5a0b528",
  logicalSnapshotSha256: "dd81cd18f76f0658959f245706560639acf28b9f6f57ee1e0d2349b0b726a2b1",
  stateSnapshotSha256: "cc654b0fd22307c6eb00f957e26fcff371e9a80af862c035063509ee6d883b9f",
  schemaSqlSha256: "276182d7a5655de8cd0a90e9affe2740b0d9d9f057068b817715ae6560825605",
  submissionCaptureHash: "0fb0fef9788bbeace08a263f93c49c22e7611e0edca5c7039945b3c75a4315fa",
  immutableSubmissionIntakeSha256: "8f7fb589fc5373256ca71df96c878f83394da94004c64169052d59d407901d20",
});
const PHASE_7_EXTERNAL_READ_POLICY = Object.freeze({
  projectId: "ca40511be3ae12112101cc1de6059b95",
  targetIssueId: "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b",
  targetEntityVersion: 125,
  targetProjectionHash: "ba7b958f555d723bc0c4a679f3b5d104435015af4f5b53c0833aa1c180f04cae",
  targetIssueEventCount: 125,
  targetLastEventSequence: 12988,
  targetLastEventHash: "8650686aced0251fa8452164ed0cd5e649a17549a7cb2f73f13bdfda27aa47e7",
  pendingSummarySha256: "d6ac890757b44e57e93f093506a819f6ade90d1ee7f9af91057f8b58f7d29361",
  readReceiptRowCount: 6,
  readReceiptKeysSha256: "46a037f9500d7fb637dac87050f5bb611b693ab9ca136e16362e47980d335efc",
  pendingIssues: Object.freeze([
    Object.freeze({ issueId: "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b", state: "ARCHITECTURE_ASSESSMENTS_PENDING", entityVersion: 125, contentHash: "ba7b958f555d723bc0c4a679f3b5d104435015af4f5b53c0833aa1c180f04cae" }),
    Object.freeze({ issueId: "FILMOS-ISSUE-final-build-id-binding-v8-20260901", state: "DUAL_APPROVED", entityVersion: 152, contentHash: "5278980ffb26addeedb2edbb4e57b556ff52e26427a15b0cfb41754347f68e14" }),
    Object.freeze({ issueId: "FILMOS-ISSUE-final-candidate-intake-v7-20260901", state: "DUAL_APPROVED", entityVersion: 155, contentHash: "febda7810c50c617d707ac2cc2c9d389a4b2ffe13655737ed7ebb6e9245b98c1" }),
    Object.freeze({ issueId: "FILMOS-ISSUE-final-project-scope-v5-20260901", state: "EVIDENCE_FROZEN", entityVersion: 144, contentHash: "a3e5bba0f239209e2ed6755685a7797af886300ad4a1f74272de05fe9a93a4a8" }),
    Object.freeze({ issueId: "FILMOS-ISSUE-final-project-scope-v6-20260901", state: "TASK_PACKAGE_FROZEN", entityVersion: 1504, contentHash: "e48be830be33c0662a094a99b38903d0db793798ebd99b6ff5ebb13aa43d14b6" }),
  ]),
  databaseIdentity: Object.freeze({
    device: 16777234,
    inode: 101926348,
    size: 12910592,
    sha256: "81f74d8692c03f688fa42683620ccdc70a4f9ad53644482690c9992dde2a65a2",
    wal: Object.freeze({ device: 16777234, inode: 101926350, size: 2212472, sha256: "e4a3ecf55b99ba5e354178e90d166fbf369a33bd3547109ba30fc7122721830a" }),
    shm: Object.freeze({ device: 16777234, inode: 101926351, size: 32768, sha256: "f42991894ef415450fc2eff57b432dd8d522aac4a6d609f71e9267de1030bd5d" }),
  }),
});

// A second, separately pinned target of the same single-actor runtime, not permission
// to select an arbitrary issue or to reopen the first Assessment.
const CHATGPT_ASSESSMENT_SEAL_TARGET = Object.freeze({
  ...PHASE_5A4_SEAL_TARGET,
  actor: "chatgpt",
  entityVersion: PHASE_7_EXTERNAL_READ_POLICY.targetEntityVersion,
  issueEventCount: PHASE_7_EXTERNAL_READ_POLICY.targetIssueEventCount,
  lastEventHash: PHASE_7_EXTERNAL_READ_POLICY.targetLastEventHash,
  projectionHash: PHASE_7_EXTERNAL_READ_POLICY.targetProjectionHash,
});
const CHATGPT_ASSESSMENT_SEAL_DATABASE_ORIGIN = Object.freeze({
  ...PHASE_5A4_SEAL_DATABASE_ORIGIN,
  walSha256: PHASE_7_EXTERNAL_READ_POLICY.databaseIdentity.wal.sha256,
  logicalSnapshotSha256: "dd05f28e38641c030c6e3a44c85a38277e5a3e1ec8ca932edb7c746b8bc225ad",
  stateSnapshotSha256: "cc199a350e5cb771629dd5d39431096f73c5538ecffec64c9162b0cb0235d667",
});

export function createReviewBusHttp({ service, store, busToken, bridgeToken, constitution, githubVerifier = new GitHubEvidenceVerifier(), listenPort = DEFAULT_PORT, now = () => new Date(), runtimeInstanceId = `review-runtime-${randomUUID()}`, intakeBootstrap = STAGE_A_BOOTSTRAP, installedSourceIdentity = null, sourceIdentityErrorCode = "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", runtimeMode = REVIEW_BUS_RUNTIME_MODE_NORMAL, sealContext = null, externalReadContext = null }) {
  if (!REVIEW_BUS_RUNTIME_MODES.has(runtimeMode)) throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
  if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL && (!sealContext || store.runtimeMode !== REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL)) {
    throw problem("SEAL_RUNTIME_TARGET_REQUIRED");
  }
  if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL && sha256(sealContext.target) !== sha256(store.sealTarget)) {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }
  if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ
    && (!externalReadContext || store.runtimeMode !== REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ)) {
    throw problem("EXTERNAL_READ_RUNTIME_TARGET_REQUIRED");
  }
  if (String(busToken).length < 24
    || (runtimeMode !== REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ && String(bridgeToken).length < 24)) {
    throw new Error("Review Bus local tokens must contain at least 24 characters");
  }
  if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_NORMAL) {
    for (const initial of store.list()) {
      if (installedSourceIdentity && initial.lane === "architecture" && initial.architecture_protocol_version !== "filmos.architecture-protocol.v2") {
        service.anchorLegacyArchitecture(initial.issue_id, installedSourceIdentity.commit, now());
      }
      service.recordRuntimeObservation(initial.issue_id, runtimeInstanceId, now());
    }
  }
  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 400, { code: "LOOPBACK_HOST_REQUIRED" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) {
        const route = externalReadRoute(req.method, url, externalReadContext.policy);
        if (!route) throw problem("EXTERNAL_READ_RUNTIME_ROUTE_DENIED", "EXTERNAL_READ_RUNTIME_ROUTE_DENIED", 404);
        applyCors(req, res);
        const snapshot = store.refreshSealSnapshot();
        if (route === "health") {
          return send(res, 200, externalReadHealth(
            externalReadContext,
            server.address()?.port ?? listenPort,
            snapshot,
            store.externalReadOperationCount(),
            store.externalReadReceiptState(),
          ));
        }
        authenticate(req, busToken, null);
        assertExternalReadProject(url, externalReadContext.policy);
        if (route === "pending") {
          const issues = service.pending(externalReadContext.policy.projectId);
          store.assertExternalPendingIssues(issues);
          if (readConsumer(req) === "chatgpt-mcp") store.recordReadReceipts(issues.map((issue) => {
            const current = service.readRedacted(issue.issue_id, externalReadContext.policy.projectId);
            return {
              issueId: current.issue_id,
              projectId: externalReadContext.policy.projectId,
              consumer: "chatgpt-mcp",
              toolName: "issue_list_pending",
              projectionContentHash: current.content_hash,
              evidenceManifestHash: current.evidence?.manifest?.contentHash ?? current.evidence?.manifest?.content_hash ?? null,
              now: now(),
            };
          }));
          return send(res, 200, { issues });
        }
        if (route === "constitution") return send(res, 200, constitution);
        return readReviewProjection(service, store, url, req, res, now());
      }
      if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL) {
        const allowedPath = `/v1/issues/${sealContext.target.issueId}/assessments/${sealContext.target.actor}`;
        if (!((req.method === "GET" && url.pathname === "/healthz") || (req.method === "POST" && url.pathname === allowedPath))) {
          throw problem("SEAL_RUNTIME_ROUTE_DENIED", "SEAL_RUNTIME_ROUTE_DENIED", 404);
        }
        applyCors(req, res);
        if (req.method === "GET" && url.pathname === "/healthz") {
          const snapshot = store.refreshSealSnapshot();
          return send(res, 200, sealHealth(sealContext, server.address()?.port ?? listenPort, snapshot, store.sealDatabaseBinding));
        }
        authenticate(req, busToken, null);
        assertSealRequestBinding(url, sealContext.target);
        const assessment = await readJson(req, 1_048_576);
        const value = store.withSealTargetTransaction(() => submitAssessmentResponse({
          service,
          store,
          issueId: sealContext.target.issueId,
          actor: sealContext.target.actor,
          assessment,
          url,
          now: now(),
        }));
        return send(res, 200, value);
      }
      applyCors(req, res);
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
        if (req.method === "POST" && action === "assessments/codex") return send(res, 200, submitAssessmentResponse({ service, store, issueId, actor: "codex", assessment: body, url, now: now() }));
        if (req.method === "POST" && action === "assessments/chatgpt") return send(res, 200, submitAssessmentResponse({ service, store, issueId, actor: "chatgpt", assessment: body, url, now: now() }));
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
        const bridgeIssue = service.requireIssue(body.issue_id);
        const architectureAssessment = body.purpose === "CHATGPT_ASSESSMENT" && isArchitectureV2Issue(bridgeIssue);
        if (architectureAssessment) validateArchitectureAssessmentBinding(store, bridgeIssue, url);
        const decisionTime = now();
        const issue = store.consumeChallengeAndApply(
          { challengeId: body.challenge_id, nonce: body.nonce, purpose: body.purpose, issueId: body.issue_id, candidateId: body.candidate_id, candidateCommit: body.candidate_commit, now: decisionTime },
          () => applyBridgeDecision(service, body, decisionTime),
        );
        if (architectureAssessment) return send(res, 200, { ack: true, ...assessmentIssueReceipt(issue, "chatgpt") });
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
  const scope = { issue_id: issue.issue_id, submission_id: issue.submission_id ?? null, project_id: issue.project_id };
  const submission = issue.submission_id ? store.submissionStatus(issue.submission_id) : null;
  const intakeReceipt = submission?.receipt ?? null;
  const views = {
    evidence: {
      ...scope,
      formal_issue_id: intakeReceipt?.formal_issue_id ?? issue.issue_id,
      capture_hash: submission?.capture_hash ?? null,
      receipt_hash: intakeReceipt?.receipt_hash ?? null,
      evidence_manifest_hash: intakeReceipt?.evidence_manifest_hash ?? issue.evidence?.manifest?.contentHash ?? issue.evidence?.manifest?.content_hash ?? null,
      current_evidence_manifest_hash: issue.evidence?.manifest?.contentHash ?? issue.evidence?.manifest?.content_hash ?? null,
      evidence: issue.evidence ?? null,
    },
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
function submitAssessmentResponse({ service, store, issueId, actor, assessment, url, now }) {
  const current = service.requireIssue(issueId);
  if (!isArchitectureV2Issue(current)) return issueReceipt(service.submitAssessment(issueId, actor, assessment, now));
  validateArchitectureAssessmentBinding(store, current, url);
  return assessmentIssueReceipt(service.submitAssessment(issueId, actor, assessment, now), actor);
}
function isArchitectureV2Issue(issue) {
  return issue?.lane === "architecture" && issue.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION;
}
function validateArchitectureAssessmentBinding(store, issue, url) {
  const requestedProjectId = url.searchParams.get("project_id");
  if (requestedProjectId && requestedProjectId !== issue.project_id) throw problem("PROJECT_SCOPE_DENIED", "PROJECT_SCOPE_DENIED", 403);
  if (!issue.submission_id) throw problem("SUBMISSION_RECEIPT_NOT_FOUND", "SUBMISSION_RECEIPT_NOT_FOUND", 404);
  const requestedSubmissionId = url.searchParams.get("submission_id");
  if (requestedSubmissionId && requestedSubmissionId !== issue.submission_id) {
    throw problem("SUBMISSION_BINDING_MISMATCH", "SUBMISSION_BINDING_MISMATCH", 409);
  }
  let submission;
  try { submission = store.submissionStatus(issue.submission_id); }
  catch (error) {
    if (error?.code === "SUBMISSION_NOT_FOUND") throw problem("SUBMISSION_RECEIPT_NOT_FOUND", "SUBMISSION_RECEIPT_NOT_FOUND", 404);
    throw error;
  }
  if (!submission.receipt) throw problem("SUBMISSION_RECEIPT_NOT_FOUND", "SUBMISSION_RECEIPT_NOT_FOUND", 404);
  if (submission.project_id !== issue.project_id
    || submission.formal_issue_id !== issue.issue_id
    || submission.receipt?.submission_id !== issue.submission_id
    || submission.receipt?.formal_issue_id !== issue.issue_id
    || submission.receipt?.project_id !== issue.project_id) {
    throw problem("SUBMISSION_BINDING_MISMATCH", "SUBMISSION_BINDING_MISMATCH", 409);
  }
}
function assessmentIssueReceipt(issue, actor) {
  const receipt = issue.operation_receipt;
  if (!receipt
    || receipt.actor !== actor
    || receipt.assessor !== actor
    || receipt.issue_id !== issue.issue_id
    || receipt.project_id !== issue.project_id
    || receipt.submission_id !== issue.submission_id) {
    throw problem("ASSESSMENT_RESPONSE_OBSERVABILITY_FAILED", "ASSESSMENT_RESPONSE_OBSERVABILITY_FAILED", 500);
  }
  return {
    ...issueReceipt(issue),
    project_id: receipt.project_id,
    issue_id: receipt.issue_id,
    submission_id: receipt.submission_id,
    actor: receipt.actor,
    assessment_id: receipt.assessment_id,
    assessment_content_hash: receipt.assessment_content_hash,
    assessment_receipt: receipt,
    event_id: receipt.event_id,
  };
}
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

function safeProblemCode(value) {
  const code = String(value ?? "");
  return REVIEW_ERROR_CODE_PATTERN.test(code) || SEAL_ERROR_CODES.has(code) ? code : "REVIEW_BUS_ERROR";
}
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

function sealHealth(context, listenPort, snapshot, binding) {
  return {
    ok: true,
    service: "filmos-review-bus",
    schema_version: "filmos.review-bus.v1",
    runtime_mode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
    storage: "sqlite-wal",
    port: listenPort,
    constitution_version: CONSTITUTION_VERSION,
    constitution_content_hash: CONSTITUTION_HASH,
    source_identity: {
      status: "VERIFIED",
      source_root: context.sourceIdentity.source_root,
      branch: context.sourceIdentity.branch,
      commit: context.sourceIdentity.commit,
      tree: context.sourceIdentity.tree,
      source_fingerprint_sha256: context.sourceIdentity.source_fingerprint_sha256,
      content_hash: context.sourceIdentity.content_hash,
    },
    seal_target: {
      project_id: context.target.projectId,
      issue_id: context.target.issueId,
      submission_id: context.target.submissionId,
      actor: context.target.actor,
      assessment_round: context.target.assessmentRound,
      entity_version: context.target.entityVersion,
      issue_event_count: context.target.issueEventCount,
      frozen_last_issue_event_hash: context.target.lastEventHash,
      projection_content_hash: context.target.projectionHash,
      intake_receipt_hash: context.target.intakeReceiptHash,
    },
    frozen_scope_logical_snapshot_sha256: binding.logicalSnapshotSha256,
    pristine_state_snapshot_sha256: binding.stateSnapshotSha256,
    current_scope_logical_snapshot_sha256: snapshot.logicalSnapshotSha256,
    current_state_snapshot_sha256: snapshot.stateSnapshotSha256,
    current_seal_state: snapshot.sealState,
    external_network_requests: 0,
    openai_model_api_calls: 0,
  };
}

function externalReadRoute(method, url, policy) {
  if (method !== "GET") return null;
  if (url.pathname === "/healthz") return url.search === "" ? "health" : null;
  const targetPrefix = `/v1/review/issues/${policy.targetIssueId}/`;
  if (url.pathname === "/v1/review/pending") return "pending";
  if (url.pathname === "/v1/review/constitution") return "constitution";
  if (url.pathname === `${targetPrefix}codex-assessment-blind`) return "codex-assessment-blind";
  if (url.pathname === `${targetPrefix}evidence`) return "evidence";
  return null;
}

function assertExternalReadProject(url, policy) {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== "project_id" || entries[0][1] !== policy.projectId) {
    throw problem("EXTERNAL_READ_RUNTIME_ROUTE_DENIED", "EXTERNAL_READ_RUNTIME_ROUTE_DENIED", 404);
  }
}

function externalReadHealth(context, listenPort, snapshot, operationCount, receiptState) {
  return {
    ok: true,
    service: "filmos-review-bus",
    schema_version: "filmos.review-bus.v1",
    runtime_mode: REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ,
    storage: "canonical-sqlite-wal-bounded-read-receipts",
    port: listenPort,
    constitution_version: CONSTITUTION_VERSION,
    constitution_content_hash: CONSTITUTION_HASH,
    source_identity: {
      status: "VERIFIED",
      source_root: context.sourceIdentity.source_root,
      branch: context.sourceIdentity.branch,
      commit: context.sourceIdentity.commit,
      tree: context.sourceIdentity.tree,
      source_fingerprint_sha256: context.sourceIdentity.source_fingerprint_sha256,
      content_hash: context.sourceIdentity.content_hash,
    },
    target: {
      project_id: context.policy.projectId,
      issue_id: context.policy.targetIssueId,
      state: "ARCHITECTURE_ASSESSMENTS_PENDING",
      entity_version: snapshot.entityVersion,
      projection_content_hash: snapshot.projectionContentHash,
      issue_event_count: snapshot.issueEventCount,
      last_event_sequence: snapshot.lastEventSequence,
      last_event_hash: snapshot.lastEventHash,
      codex_slot: snapshot.codexSlot,
      chatgpt_slot: snapshot.chatgptSlot,
    },
    pending_issue_count: context.policy.pendingIssues.length,
    pending_summary_sha256: context.policy.pendingSummarySha256,
    read_receipt_operation_count: operationCount,
    read_receipt_operation_limit: context.policy.pendingIssues.length + 1,
    read_receipt_row_count: receiptState.rowCount,
    read_receipt_keys_sha256: receiptState.keysSha256,
    current_seal_state: snapshot.sealState,
    external_network_requests: 0,
    openai_model_api_calls: 0,
  };
}

function assertSealRequestBinding(url, target) {
  if (url.searchParams.get("project_id") !== target.projectId) {
    throw problem("PROJECT_SCOPE_DENIED", "PROJECT_SCOPE_DENIED", 403);
  }
  if (url.searchParams.get("submission_id") !== target.submissionId) {
    throw problem("SUBMISSION_BINDING_MISMATCH", "SUBMISSION_BINDING_MISMATCH", 409);
  }
}

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

export function readExistingSealToken(path, explicit) {
  if (explicit !== undefined && explicit !== null) {
    if (String(explicit).length < 24) throw problem("SEAL_RUNTIME_TOKEN_REQUIRED");
    return String(explicit);
  }
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error("token drift");
    const token = readFileSync(path, "utf8").trim();
    if (token.length < 24) throw new Error("short token");
    return token;
  } catch {
    throw problem("SEAL_RUNTIME_TOKEN_REQUIRED");
  }
}

export function loadSealSourceIdentity(env = process.env, {
  expectedSourceRoot = DEFAULT_SOURCE_ROOT,
  identityResourcesRelative = SEAL_IDENTITY_RESOURCES_RELATIVE,
} = {}) {
  const required = [
    "FILMOS_REVIEW_SEAL_SOURCE_ROOT",
    "FILMOS_REVIEW_SEAL_SOURCE_COMMIT",
    "FILMOS_REVIEW_SEAL_SOURCE_TREE",
    "FILMOS_REVIEW_SEAL_SOURCE_FINGERPRINT_SHA256",
    "FILMOS_INSTALLED_SOURCE_IDENTITY_PATH",
    "FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH",
    "FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR",
  ];
  if (required.some((name) => typeof env[name] !== "string" || !env[name])) {
    throw problem("SEAL_RUNTIME_SOURCE_IDENTITY_REQUIRED", "SEAL_RUNTIME_SOURCE_IDENTITY_REQUIRED", 503);
  }
  try {
    const sourceRootInput = env.FILMOS_REVIEW_SEAL_SOURCE_ROOT;
    if (!isAbsolute(sourceRootInput) || resolve(sourceRootInput) !== sourceRootInput) throw new Error("source root must be absolute");
    const sourceRootMetadata = lstatSync(sourceRootInput);
    if (!sourceRootMetadata.isDirectory() || sourceRootMetadata.isSymbolicLink()) throw new Error("source root must be a regular directory");
    const sourceRoot = realpathSync(sourceRootInput);
    const expectedRoot = realpathSync(expectedSourceRoot);
    if (sourceRoot !== sourceRootInput
      || sourceRoot === "/"
      || resolve(expectedSourceRoot) !== expectedSourceRoot
      || expectedRoot !== expectedSourceRoot
      || sourceRoot !== expectedRoot) {
      throw new Error("source root drift");
    }

    const identityPaths = [
      env.FILMOS_INSTALLED_SOURCE_IDENTITY_PATH,
      env.FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH,
      env.FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR,
    ];
    const identityResources = resolve(sourceRoot, identityResourcesRelative);
    const expectedIdentityPaths = [
      resolve(identityResources, "SourceIdentity.json"),
      resolve(identityResources, "InternalRuntime.json"),
      resolve(identityResources, "DeveloperRepository.json"),
    ];
    for (const path of identityPaths) assertRegularIdentityFile(path);
    if (canonicalPathList(identityPaths) !== canonicalPathList(expectedIdentityPaths)
      || realpathSync(identityResources) !== identityResources
      || basename(identityPaths[0]) !== "SourceIdentity.json"
      || basename(identityPaths[1]) !== "InternalRuntime.json"
      || basename(identityPaths[2]) !== "DeveloperRepository.json") {
      throw new Error("identity document layout mismatch");
    }
    const locator = JSON.parse(readFileSync(identityPaths[2], "utf8"));
    if (locator.source_repository !== sourceRootInput || realpathSync(locator.source_repository) !== sourceRoot) {
      throw new Error("repository locator mismatch");
    }

    const documentIdentity = loadInstalledSourceIdentity({
      sourceIdentityPath: identityPaths[0],
      internalRuntimePath: identityPaths[1],
      repositoryLocatorPath: identityPaths[2],
      gitExecutable: "/usr/bin/git",
    });
    const branch = runGit(sourceRoot, ["symbolic-ref", "--short", "HEAD"]);
    const commit = runGit(sourceRoot, ["rev-parse", "HEAD"]);
    const tree = runGit(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
    const trackedStatus = runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
    const fingerprintExecutable = resolve(sourceRoot, "desktop/macos/scripts/source-fingerprint");
    assertRegularIdentityFile(fingerprintExecutable);
    const fingerprintResult = spawnSync(fingerprintExecutable, ["--json"], {
      cwd: sourceRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (fingerprintResult.status !== 0) throw new Error("source fingerprint failed");
    const fingerprint = JSON.parse(fingerprintResult.stdout);
    if (branch !== "integration"
      || trackedStatus !== ""
      || fingerprint.source_clean !== true
      || fingerprint.git_commit_sha !== commit
      || fingerprint.git_tree_sha !== tree
      || commit !== env.FILMOS_REVIEW_SEAL_SOURCE_COMMIT
      || tree !== env.FILMOS_REVIEW_SEAL_SOURCE_TREE
      || fingerprint.source_fingerprint_sha256 !== env.FILMOS_REVIEW_SEAL_SOURCE_FINGERPRINT_SHA256
      || documentIdentity.commit !== commit
      || documentIdentity.tree !== tree
      || documentIdentity.source_fingerprint_sha256 !== fingerprint.source_fingerprint_sha256
      || documentIdentity.source_clean !== true) {
      throw new Error("independent source identity mismatch");
    }
    return Object.freeze({
      ...documentIdentity,
      source_root: sourceRoot,
      branch,
      commit,
      tree,
      source_fingerprint_sha256: fingerprint.source_fingerprint_sha256,
      source_file_count: fingerprint.source_file_count,
      source_clean: true,
    });
  } catch (error) {
    if (error?.code === "SEAL_RUNTIME_SOURCE_IDENTITY_REQUIRED") throw error;
    throw problem("SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH", "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH", 503);
  }
}

export function startFromEnvironment(env = process.env, { assessmentSealTestOnly = null, externalReadTestOnly = null } = {}) {
  const runtimeMode = env.FILMOS_REVIEW_BUS_RUNTIME_MODE ?? REVIEW_BUS_RUNTIME_MODE_NORMAL;
  if (!REVIEW_BUS_RUNTIME_MODES.has(runtimeMode)) throw problem("INVALID_REVIEW_BUS_RUNTIME_MODE");
  if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL) {
    return startSealRuntime(env, sealRuntimeConfiguration(assessmentSealTestOnly, env.FILMOS_REVIEW_SEAL_ACTOR));
  }
  if (runtimeMode === REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ) {
    assertExternalReadRuntimeCapability();
    return startExternalReadRuntime(env, externalReadRuntimeConfiguration(externalReadTestOnly));
  }

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

function startExternalReadRuntime(env, configuration) {
  const {
    canonicalDatabase,
    expectedSourceRoot,
    sealTarget,
    sealBinding,
    externalReadPolicy,
    port: requiredPort,
    identityResourcesRelative,
  } = configuration;
  const canonicalLocalDir = dirname(canonicalDatabase);
  const localDir = resolve(env.FILMOS_REVIEW_BUS_LOCAL_DIR ?? canonicalLocalDir);
  const port = Number(env.FILMOS_REVIEW_BUS_PORT ?? requiredPort);
  const host = env.FILMOS_REVIEW_BUS_HOST ?? "127.0.0.1";
  if (localDir !== canonicalLocalDir
    || host !== "127.0.0.1"
    || port !== requiredPort
    || env.FILMOS_REVIEW_BUS_TOKEN !== undefined
    || env.FILMOS_REVIEW_CONSTITUTION_PATH !== undefined
    || env.FILMOS_REVIEW_TASK_PACKAGE_HASH !== undefined) {
    throw problem("EXTERNAL_READ_RUNTIME_DATABASE_REQUIRED");
  }
  const sourceIdentity = loadSealSourceIdentity(env, { expectedSourceRoot, identityResourcesRelative });
  const busToken = readExistingSealToken(resolve(localDir, "review-bus.token"), undefined);
  const constitutionPath = resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json");
  assertRegularIdentityFile(constitutionPath);
  const constitutionBytes = readFileSync(constitutionPath, "utf8");
  const constitution = JSON.parse(constitutionBytes);
  if (sha256(constitutionBytes) !== PHASE_7_CONSTITUTION_FILE_SHA256
    || constitution.content_hash !== CONSTITUTION_HASH
    || constitution.constitution_version !== CONSTITUTION_VERSION) {
    throw problem("EXTERNAL_READ_RUNTIME_TARGET_MISMATCH");
  }
  const store = new ReviewBusStore(canonicalDatabase, {
    runtimeMode: REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ,
    sealBinding,
    sealTarget,
    externalReadPolicy,
  });
  try {
    const service = new ReviewBusService(store, { taskPackageContentHash: TASK_PACKAGE_HASH });
    store.assertExternalPendingIssues(service.pending(externalReadPolicy.projectId));
    store.externalReadReceiptState();
    const externalReadContext = Object.freeze({
      sourceIdentity,
      policy: store.externalReadPolicy,
    });
    const server = createReviewBusHttp({
      service,
      store,
      busToken,
      bridgeToken: null,
      constitution,
      listenPort: port,
      installedSourceIdentity: sourceIdentity,
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ,
      externalReadContext,
    });
    server.listen(port, host);
    return {
      server,
      store,
      service,
      host,
      port,
      backupTimer: null,
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ,
      externalReadContext,
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

function startSealRuntime(env, configuration) {
  const { canonicalDatabase, expectedSourceRoot, expectedTarget, expectedDatabaseOrigin, port: requiredPort } = configuration;
  const canonicalLocalDir = dirname(canonicalDatabase);
  const localDir = resolve(env.FILMOS_REVIEW_BUS_LOCAL_DIR ?? canonicalLocalDir);
  const port = Number(env.FILMOS_REVIEW_BUS_PORT ?? requiredPort);
  const host = env.FILMOS_REVIEW_BUS_HOST ?? "127.0.0.1";
  if (localDir !== canonicalLocalDir || host !== "127.0.0.1" || port !== requiredPort) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  const sourceIdentity = loadSealSourceIdentity(env, {
    expectedSourceRoot,
    // Keep the completed Codex seal's evidence files intact; the second actor
    // consumes the existing source launcher's independently verified identity.
    identityResourcesRelative: expectedTarget.actor === "chatgpt"
      ? ".local/source-host/Resources" : SEAL_IDENTITY_RESOURCES_RELATIVE,
  });
  const target = sealTargetFromEnvironment(env, expectedTarget);
  const binding = sealBindingFromEnvironment(env, canonicalDatabase, expectedDatabaseOrigin);
  const busToken = readExistingSealToken(resolve(localDir, "review-bus.token"), env.FILMOS_REVIEW_BUS_TOKEN);
  const bridgeToken = readExistingSealToken(resolve(localDir, "review-bridge.token"), env.FILMOS_REVIEW_BRIDGE_TOKEN);
  const constitutionPath = resolve(env.FILMOS_REVIEW_CONSTITUTION_PATH ?? resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"));
  const constitution = JSON.parse(readFileSync(constitutionPath, "utf8"));
  const store = new ReviewBusStore(canonicalDatabase, {
    runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
    sealBinding: binding,
    sealTarget: target,
  });
  try {
    const service = new ReviewBusService(store, { taskPackageContentHash: env.FILMOS_REVIEW_TASK_PACKAGE_HASH });
    const githubVerifier = new GitHubEvidenceVerifier({ repository: env.FILMOS_REVIEW_GITHUB_REPOSITORY ?? "maiyadiu/filmos-studio" });
    const sealContext = Object.freeze({
      sourceIdentity,
      target: store.sealTarget,
    });
    const server = createReviewBusHttp({
      service,
      store,
      busToken,
      bridgeToken,
      constitution,
      githubVerifier,
      listenPort: port,
      installedSourceIdentity: sourceIdentity,
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
      sealContext,
    });
    server.listen(port, host);
    return {
      server,
      store,
      service,
      host,
      port,
      backupTimer: null,
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
      sealContext,
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

function sealRuntimeConfiguration(testOnly, actor) {
  if (testOnly === null) {
    return Object.freeze({
      canonicalDatabase: DEFAULT_DATABASE,
      expectedSourceRoot: DEFAULT_SOURCE_ROOT,
      expectedTarget: actor === "chatgpt" ? CHATGPT_ASSESSMENT_SEAL_TARGET : PHASE_5A4_SEAL_TARGET,
      expectedDatabaseOrigin: actor === "chatgpt" ? CHATGPT_ASSESSMENT_SEAL_DATABASE_ORIGIN : PHASE_5A4_SEAL_DATABASE_ORIGIN,
      port: DEFAULT_PORT,
    });
  }
  if (!process.env.NODE_TEST_CONTEXT
    || !testOnly || testOnly.enabled !== true
    || typeof testOnly.canonicalDatabase !== "string"
    || typeof testOnly.expectedSourceRoot !== "string"
    || !testOnly.expectedTarget
    || !testOnly.expectedDatabaseOrigin
    || !Number.isInteger(testOnly.port)
    || testOnly.port < 0) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  return Object.freeze({
    canonicalDatabase: resolve(testOnly.canonicalDatabase),
    expectedSourceRoot: resolve(testOnly.expectedSourceRoot),
    expectedTarget: Object.freeze({ ...testOnly.expectedTarget }),
    expectedDatabaseOrigin: Object.freeze({ ...testOnly.expectedDatabaseOrigin }),
    port: testOnly.port,
  });
}

function externalReadRuntimeConfiguration(testOnly) {
  if (testOnly === null) {
    return Object.freeze({
      canonicalDatabase: DEFAULT_DATABASE,
      expectedSourceRoot: DEFAULT_SOURCE_ROOT,
      sealTarget: PHASE_5A4_SEAL_TARGET,
      sealBinding: Object.freeze({
        canonicalPath: DEFAULT_DATABASE,
        ...PHASE_5A4_SEAL_DATABASE_ORIGIN,
      }),
      externalReadPolicy: PHASE_7_EXTERNAL_READ_POLICY,
      port: DEFAULT_PORT,
      identityResourcesRelative: EXTERNAL_READ_IDENTITY_RESOURCES_RELATIVE,
    });
  }
  if (!process.env.NODE_TEST_CONTEXT
    || !testOnly || testOnly.enabled !== true
    || typeof testOnly.canonicalDatabase !== "string"
    || typeof testOnly.expectedSourceRoot !== "string"
    || !testOnly.sealTarget
    || !testOnly.sealBinding
    || !testOnly.externalReadPolicy
    || !Number.isInteger(testOnly.port)
    || testOnly.port < 0) {
    throw problem("EXTERNAL_READ_RUNTIME_DATABASE_REQUIRED");
  }
  return Object.freeze({
    canonicalDatabase: resolve(testOnly.canonicalDatabase),
    expectedSourceRoot: resolve(testOnly.expectedSourceRoot),
    sealTarget: Object.freeze({ ...testOnly.sealTarget }),
    sealBinding: Object.freeze({ ...testOnly.sealBinding, canonicalPath: resolve(testOnly.canonicalDatabase) }),
    externalReadPolicy: Object.freeze(testOnly.externalReadPolicy),
    port: testOnly.port,
    identityResourcesRelative: testOnly.identityResourcesRelative ?? SEAL_IDENTITY_RESOURCES_RELATIVE,
  });
}

function sealTargetFromEnvironment(env, expectedTarget = PHASE_5A4_SEAL_TARGET) {
  const required = [
    "FILMOS_REVIEW_SEAL_PROJECT_ID",
    "FILMOS_REVIEW_SEAL_ISSUE_ID",
    "FILMOS_REVIEW_SEAL_SUBMISSION_ID",
    "FILMOS_REVIEW_SEAL_ACTOR",
    "FILMOS_REVIEW_SEAL_ASSESSMENT_ROUND",
    "FILMOS_REVIEW_SEAL_ENTITY_VERSION",
    "FILMOS_REVIEW_SEAL_ISSUE_EVENT_COUNT",
    "FILMOS_REVIEW_SEAL_LAST_EVENT_HASH",
    "FILMOS_REVIEW_SEAL_PROJECTION_HASH",
    "FILMOS_REVIEW_SEAL_INTAKE_RECEIPT_HASH",
  ];
  if (required.some((name) => typeof env[name] !== "string" || !env[name])) throw problem("SEAL_RUNTIME_TARGET_REQUIRED");
  const target = {
    projectId: env.FILMOS_REVIEW_SEAL_PROJECT_ID,
    issueId: env.FILMOS_REVIEW_SEAL_ISSUE_ID,
    submissionId: env.FILMOS_REVIEW_SEAL_SUBMISSION_ID,
    actor: env.FILMOS_REVIEW_SEAL_ACTOR,
    assessmentRound: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_ASSESSMENT_ROUND, "SEAL_RUNTIME_TARGET_REQUIRED"),
    entityVersion: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_ENTITY_VERSION, "SEAL_RUNTIME_TARGET_REQUIRED"),
    issueEventCount: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_ISSUE_EVENT_COUNT, "SEAL_RUNTIME_TARGET_REQUIRED"),
    lastEventHash: env.FILMOS_REVIEW_SEAL_LAST_EVENT_HASH,
    projectionHash: env.FILMOS_REVIEW_SEAL_PROJECTION_HASH,
    intakeReceiptHash: env.FILMOS_REVIEW_SEAL_INTAKE_RECEIPT_HASH,
  };
  if (Object.entries(expectedTarget).some(([key, expected]) => target[key] !== expected)) {
    throw problem("SEAL_RUNTIME_TARGET_MISMATCH");
  }
  return target;
}

function sealBindingFromEnvironment(env, canonicalDatabase, expectedOrigin = PHASE_5A4_SEAL_DATABASE_ORIGIN) {
  const required = [
    "FILMOS_REVIEW_SEAL_DATABASE_REALPATH",
    "FILMOS_REVIEW_SEAL_DATABASE_DEVICE",
    "FILMOS_REVIEW_SEAL_DATABASE_INODE",
    "FILMOS_REVIEW_SEAL_DATABASE_SIZE",
    "FILMOS_REVIEW_SEAL_DATABASE_SHA256",
    "FILMOS_REVIEW_SEAL_DATABASE_JOURNAL_MODE",
    "FILMOS_REVIEW_SEAL_DATABASE_PAGE_COUNT",
    "FILMOS_REVIEW_SEAL_DATABASE_SCHEMA_VERSION",
    "FILMOS_REVIEW_SEAL_DATABASE_WAL_SHA256",
    "FILMOS_REVIEW_SEAL_LOGICAL_SNAPSHOT_SHA256",
  ];
  if (required.some((name) => typeof env[name] !== "string" || !env[name])
    || env.FILMOS_REVIEW_SEAL_DATABASE_REALPATH !== canonicalDatabase) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  const binding = {
    canonicalPath: canonicalDatabase,
    device: strictNonNegativeInteger(env.FILMOS_REVIEW_SEAL_DATABASE_DEVICE, "SEAL_RUNTIME_DATABASE_REQUIRED"),
    inode: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_DATABASE_INODE, "SEAL_RUNTIME_DATABASE_REQUIRED"),
    size: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_DATABASE_SIZE, "SEAL_RUNTIME_DATABASE_REQUIRED"),
    sha256: env.FILMOS_REVIEW_SEAL_DATABASE_SHA256,
    journalMode: env.FILMOS_REVIEW_SEAL_DATABASE_JOURNAL_MODE,
    pageCount: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_DATABASE_PAGE_COUNT, "SEAL_RUNTIME_DATABASE_REQUIRED"),
    schemaVersion: strictPositiveInteger(env.FILMOS_REVIEW_SEAL_DATABASE_SCHEMA_VERSION, "SEAL_RUNTIME_DATABASE_REQUIRED"),
    walSha256: env.FILMOS_REVIEW_SEAL_DATABASE_WAL_SHA256,
    logicalSnapshotSha256: env.FILMOS_REVIEW_SEAL_LOGICAL_SNAPSHOT_SHA256,
    stateSnapshotSha256: expectedOrigin.stateSnapshotSha256,
    schemaSqlSha256: expectedOrigin.schemaSqlSha256,
    submissionCaptureHash: expectedOrigin.submissionCaptureHash,
    immutableSubmissionIntakeSha256: expectedOrigin.immutableSubmissionIntakeSha256,
  };
  if (Object.entries(expectedOrigin).some(([key, expected]) => binding[key] !== expected)) {
    throw problem("SEAL_RUNTIME_DATABASE_REQUIRED");
  }
  return binding;
}

function strictPositiveInteger(value, code) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) throw problem(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw problem(code);
  return number;
}

function strictNonNegativeInteger(value, code) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ""))) throw problem(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw problem(code);
  return number;
}

function assertRegularIdentityFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new Error("identity path required");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(path) !== path) throw new Error("identity path drift");
}

function canonicalPathList(paths) {
  return JSON.stringify(paths.map((path) => ({ path, realpath: realpathSync(path) })));
}

function runGit(repository, args) {
  const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error("git identity check failed");
  return result.stdout.trim();
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))) {
  try { const { host, port } = startFromEnvironment(); process.stdout.write(`FilmOS Review Bus: http://${host}:${port}/healthz\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}

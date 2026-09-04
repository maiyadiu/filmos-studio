import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { sha256 } from "../src/canonical.mjs";
import { architectureCandidateBindingHash } from "../src/architecture-review.mjs";
import { GitHubEvidenceVerifier, readArtifactEvidenceIndex, readHandoffEvidenceIndex, resolveGitHubCLI } from "../src/github-evidence-verifier.mjs";
import { loadInstalledSourceIdentity } from "../src/installed-source-identity.mjs";
import { buildLiveRoundtripTrace } from "../src/live-roundtrip-trace.mjs";
import { ReviewBusService, candidateBinding, fileInScope } from "../src/service.mjs";
import { allowedOrigin, createReviewBusHttp, loadSealSourceIdentity, readExistingSealToken, startFromEnvironment } from "../src/server.mjs";
import { prepareReviewBusSealBinding, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ, ReviewBusStore } from "../src/store.mjs";
import { redactEvidence } from "../src/redaction.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const commit = "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a";
const taskHash = "7cf9bed457611e44a6b1f1bbb96968f20d83edec0d7d00bedfc73c7cdea2a10f";
const constitutionHash = "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41";
const handoffName = "FilmOS_V1_1_Dual_Expert_Operational_Closure_Handoff_deadbeef";
const stageASubmissionId = "FILMOS-SUBMISSION-b3274782-30a0-44a1-a05e-01730678da8b";

test("GitHub CLI resolver honors an explicit executable for Dock-launched Review Bus", () => {
  assert.equal(resolveGitHubCLI({ FILMOS_GH_EXECUTABLE: "/bin/sh" }), "/bin/sh");
});

test("candidate scope matches exact paths even when the frozen descriptor marks a file as not yet existing", () => {
  assert.equal(fileInScope("web/new-view.ts", "web/new-view.ts（当前不存在）"), true);
  assert.equal(fileInScope("web/new-view.ts", "web/new-view.ts（冻结基线中不存在）"), true);
  assert.equal(fileInScope("web/other.ts", "web/new-view.ts（当前不存在）"), false);
  assert.equal(fileInScope("web/new-view.ts（当前不存在）", "web/new-view.ts（当前不存在）"), false);
});

function fixture() {
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  return { store, service };
}

function createPendingArchitectureAssessment(service, uuid = "55555555-5555-4555-8555-555555555555", scopedProjectId = projectId) {
  const submissionId = `FILMOS-SUBMISSION-${uuid}`;
  const issue = service.createIssue({
    project_id: scopedProjectId,
    what_happened: "Assessment sealing must be safely replayable.",
    expected_result: "One immutable Assessment receipt per actor and round.",
    location: "Review Bus Assessment workflow",
    blocks_work: true,
    lane: "architecture",
  }, "user", new Date("2026-09-04T00:00:00.000Z"), { submissionId });
  service.freezeRequirementDelta(issue.issue_id, architectureDelta, "user", new Date("2026-09-04T00:01:00.000Z"));
  service.freezeEvidence(issue.issue_id, { source_commit: commit, items: architectureEvidence }, "codex", new Date("2026-09-04T00:02:00.000Z"));
  service.beginArchitectureAssessments(issue.issue_id, "review-codex-coordinator", new Date("2026-09-04T00:03:00.000Z"));
  return service.requireIssue(issue.issue_id);
}

function bindTestSubmission(store, issue) {
  const timestamp = "2026-09-04T00:00:00.000Z";
  const captureHash = sha256({ submission_id: issue.submission_id, project_id: issue.project_id });
  const receiptBase = {
    schema_version: "filmos.issue-intake-receipt.v1",
    submission_id: issue.submission_id,
    formal_issue_id: issue.issue_id,
    project_id: issue.project_id,
  };
  const receipt = { ...receiptBase, receipt_hash: sha256(receiptBase) };
  store.db.prepare(`INSERT INTO review_submissions(submission_id,project_id,capture_schema,capture_hash,capture_json,state,formal_issue_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(issue.submission_id, issue.project_id, "filmos.test-capture.v1", captureHash, "{}", "ACCEPTED_AWAITING_READBACK", issue.issue_id, timestamp, timestamp);
  store.db.prepare("INSERT INTO review_submission_receipts(submission_id,formal_issue_id,receipt_json,receipt_hash,created_at) VALUES(?,?,?,?,?)")
    .run(issue.submission_id, issue.issue_id, JSON.stringify(receipt), receipt.receipt_hash, timestamp);
}

function runAssessmentChild(workerPath, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, FILMOS_APPEND_WORKER_DATA: JSON.stringify(input) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `ASSESSMENT_CHILD_EXIT_${code}`));
      try {
        const message = JSON.parse(stdout.trim().split("\n").at(-1));
        if (!message.ok) return reject(Object.assign(new Error(message.error), { code: message.code }));
        resolvePromise(message.result);
      } catch (error) { reject(error); }
    });
  });
}

function runCrashedSealWrite(value) {
  const input = {
    storeModule: new URL("../src/store.mjs", import.meta.url).href,
    serviceModule: new URL("../src/service.mjs", import.meta.url).href,
    databasePath: value.databasePath,
    binding: value.binding,
    target: value.target,
    assessment: codexAssessment,
    baseCommit: commit,
    taskPackageContentHash: taskHash,
  };
  const source = `
    const input = JSON.parse(process.env.FILMOS_SEAL_CRASH_DATA);
    const { ReviewBusStore, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL } = await import(input.storeModule);
    const { ReviewBusService } = await import(input.serviceModule);
    const store = new ReviewBusStore(input.databasePath, {
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
      sealBinding: input.binding,
      sealTarget: input.target,
    });
    const service = new ReviewBusService(store, {
      baseCommit: input.baseCommit,
      taskPackageContentHash: input.taskPackageContentHash,
    });
    process.stdout.write("READY\\n");
    process.stdin.once("data", () => {
      store.withSealTargetTransaction(() => service.submitAssessment(
        input.target.issueId,
        "codex",
        input.assessment,
        new Date("2026-09-04T04:00:00.000Z"),
      ));
      process.abort();
    });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, FILMOS_SEAL_CRASH_DATA: JSON.stringify(input) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolvePromise, reject) => {
    let ready = false;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (ready || !String(chunk).includes("READY")) return;
      ready = true;
      try {
        value.normalStore.close();
        child.stdin.end("SUBMIT\n");
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!ready) return reject(new Error(stderr || `SEAL_CRASH_CHILD_EXIT_${code}`));
      if (code === 0 && !signal) return reject(new Error("SEAL_CRASH_CHILD_DID_NOT_TERMINATE_ABRUPTLY"));
      resolvePromise({ code, signal, stderr });
    });
  });
}

function stageABody(overrides = {}) {
  return {
    submission_id: stageASubmissionId,
    project_id: projectId,
    what_happened: "Review Bus intake did not accept the saved local draft.",
    expected_result: "Review Bus assigns the Architecture lane and returns one canonical Issue ID.",
    location: "agent:/canvas/example",
    blocks_work: false,
    captured_at: "2026-09-01T16:16:00.955Z",
    risk: { architecture_gap: true },
    suggested_lane: "architecture",
    allowed_change_scope: [],
    app_build_id: "candidate-8951d975-52f2a685",
    app_tree: "52f2a6853ff89a9aa231b6d5b00f6f0712a20b97",
    route: "/canvas/example",
    context_snapshot: { domainProjectId: projectId, recentAuditIds: [], recentErrorCodes: ["INVALID_ISSUE_ID"], runtimeStatus: { reviewBus: "ready" }, providerStatus: {} },
    attachment_manifest: [],
    ...overrides,
  };
}

async function startReviewServer(service, store, options = {}) {
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const token = "bus-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken: "bridge-token-1234567890-abcdefghijkl", constitution, ...options });
  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  return {
    server,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://127.0.0.1:43100" },
  };
}

function installedIdentityFixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-installed-identity-"));
  const repository = resolve(directory, "repository");
  const resources = resolve(directory, "FilmOS Studio.app", "Contents", "Resources");
  const locatorPath = resolve(directory, "review-bus", "developer-repository.json");
  mkdirSync(repository, { recursive: true });
  mkdirSync(resources, { recursive: true });
  mkdirSync(dirname(locatorPath), { recursive: true });
  execFileSync("git", ["-C", repository, "init", "-q"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "FilmOS Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "filmos-test@example.invalid"]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", "https://github.com/maiyadiu/filmos-studio.git"]);
  execFileSync("git", ["-C", repository, "remote", "set-url", "--push", "origin", "git@github.com:maiyadiu/filmos-studio.git"]);
  writeFileSync(resolve(repository, "source.txt"), "installed source\n");
  execFileSync("git", ["-C", repository, "add", "source.txt"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "test: installed source"]);
  const sourceCommit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["-C", repository, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const fingerprint = "f".repeat(64);
  const buildID = `candidate-${sourceCommit.slice(0, 8)}-${sourceTree.slice(0, 8)}`;
  const sourcePath = resolve(resources, "SourceIdentity.json");
  const runtimePath = resolve(resources, "InternalRuntime.json");
  const source = {
    schema_version: "1.0.0",
    repository: "maiyadiu/filmos-studio",
    source_fingerprint_sha256: fingerprint,
    git_commit_sha: sourceCommit,
    git_tree_sha: sourceTree,
    source_file_count: 1,
    source_scopes: ["services/filmos-review-bus"],
    source_clean: true,
    build_id: buildID,
    release_channel: "candidate",
    external_paid_submit_enabled: false,
  };
  const runtime = {
    schema_version: 4,
    source_repository: "maiyadiu/filmos-studio",
    source_commit: sourceCommit,
    source_tree: sourceTree,
    source_fingerprint_sha256: fingerprint,
    build_id: buildID,
    release_channel: "candidate",
    external_paid_submit_enabled: false,
  };
  const locator = { schema_version: "1.0.0", repository: "maiyadiu/filmos-studio", source_repository: repository, source_commit: sourceCommit, source_tree: sourceTree };
  writeFileSync(sourcePath, JSON.stringify(source));
  writeFileSync(runtimePath, JSON.stringify(runtime));
  writeFileSync(locatorPath, JSON.stringify(locator));
  const load = () => loadInstalledSourceIdentity({ sourceIdentityPath: sourcePath, internalRuntimePath: runtimePath, repositoryLocatorPath: locatorPath, gitExecutable: "/usr/bin/git" });
  return { directory, repository, sourcePath, runtimePath, locatorPath, source, runtime, locator, sourceCommit, sourceTree, buildID, load };
}

function sealSourceIdentityFixture() {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "filmos-seal-source-identity-")));
  const repository = resolve(directory, "repository");
  const resources = resolve(repository, ".local/phase5a4-seal-runtime/Resources");
  const fingerprintPath = resolve(repository, "desktop/macos/scripts/source-fingerprint");
  mkdirSync(dirname(fingerprintPath), { recursive: true });
  mkdirSync(resolve(repository, "services/filmos-review-bus"), { recursive: true });
  mkdirSync(resources, { recursive: true });
  execFileSync("git", ["-C", directory, "init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "FilmOS Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "filmos-test@example.invalid"]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", "https://github.com/maiyadiu/filmos-studio.git"]);
  execFileSync("git", ["-C", repository, "remote", "set-url", "--push", "origin", "git@github.com:maiyadiu/filmos-studio.git"]);
  copyFileSync(resolve(import.meta.dirname, "../../../desktop/macos/scripts/source-fingerprint"), fingerprintPath);
  chmodSync(fingerprintPath, 0o755);
  writeFileSync(resolve(repository, "services/filmos-review-bus/source.txt"), "seal source\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "test: seal source"]);
  execFileSync("git", ["-C", repository, "branch", "-M", "integration"]);
  const fingerprint = JSON.parse(execFileSync(fingerprintPath, ["--json"], { cwd: repository, encoding: "utf8" }));
  const buildID = `development-${fingerprint.git_commit_sha.slice(0, 8)}-${fingerprint.source_fingerprint_sha256.slice(0, 8)}`;
  const sourcePath = resolve(resources, "SourceIdentity.json");
  const runtimePath = resolve(resources, "InternalRuntime.json");
  const locatorPath = resolve(resources, "DeveloperRepository.json");
  writeFileSync(sourcePath, JSON.stringify({
    ...fingerprint,
    repository: "maiyadiu/filmos-studio",
    build_id: buildID,
    release_channel: "development",
    external_paid_submit_enabled: false,
  }));
  writeFileSync(runtimePath, JSON.stringify({
    schema_version: 4,
    source_repository: "maiyadiu/filmos-studio",
    source_commit: fingerprint.git_commit_sha,
    source_tree: fingerprint.git_tree_sha,
    source_fingerprint_sha256: fingerprint.source_fingerprint_sha256,
    build_id: buildID,
    release_channel: "development",
    external_paid_submit_enabled: false,
  }));
  writeFileSync(locatorPath, JSON.stringify({
    schema_version: "1.0.0",
    repository: "maiyadiu/filmos-studio",
    source_repository: repository,
    source_commit: fingerprint.git_commit_sha,
    source_tree: fingerprint.git_tree_sha,
  }));
  const env = {
    FILMOS_REVIEW_SEAL_SOURCE_ROOT: repository,
    FILMOS_REVIEW_SEAL_SOURCE_COMMIT: fingerprint.git_commit_sha,
    FILMOS_REVIEW_SEAL_SOURCE_TREE: fingerprint.git_tree_sha,
    FILMOS_REVIEW_SEAL_SOURCE_FINGERPRINT_SHA256: fingerprint.source_fingerprint_sha256,
    FILMOS_INSTALLED_SOURCE_IDENTITY_PATH: sourcePath,
    FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH: runtimePath,
    FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR: locatorPath,
  };
  return { directory, repository, resources, fingerprintPath, fingerprint, env };
}

function assessmentSealFixture(uuid = "69696969-6969-4696-8696-696969696969", scopedProjectId = projectId) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "filmos-assessment-seal-")));
  const databasePath = resolve(directory, "review-bus.sqlite");
  const normalStore = new ReviewBusStore(databasePath);
  const normalService = new ReviewBusService(normalStore, { baseCommit: commit, taskPackageContentHash: taskHash });
  const issue = createPendingArchitectureAssessment(normalService, uuid, scopedProjectId);
  bindTestSubmission(normalStore, issue);
  const current = normalService.requireIssue(issue.issue_id);
  const events = normalStore.events(issue.issue_id);
  const target = {
    projectId: current.project_id,
    issueId: current.issue_id,
    submissionId: current.submission_id,
    actor: "codex",
    assessmentRound: current.assessment_round,
    entityVersion: current.entity_version,
    issueEventCount: events.length,
    lastEventHash: events.at(-1).event_hash,
    projectionHash: current.content_hash,
    intakeReceiptHash: normalStore.submissionStatus(current.submission_id).receipt.receipt_hash,
  };
  const binding = prepareReviewBusSealBinding(databasePath, target);
  const createSealStore = () => new ReviewBusStore(databasePath, {
    runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
    sealBinding: binding,
    sealTarget: target,
  });
  const sourceIdentity = Object.freeze({
    source_root: "/test/filmos-source",
    branch: "integration",
    commit,
    tree: "a".repeat(40),
    source_fingerprint_sha256: "b".repeat(64),
    content_hash: "c".repeat(64),
  });
  return { directory, databasePath, normalStore, normalService, issue: current, target, binding, createSealStore, sourceIdentity };
}

function assessmentSealRuntimeInputs(value, source) {
  const expectedDatabaseOrigin = {
    device: value.binding.device,
    inode: value.binding.inode,
    size: value.binding.size,
    sha256: value.binding.sha256,
    journalMode: value.binding.journalMode,
    pageCount: value.binding.pageCount,
    schemaVersion: value.binding.schemaVersion,
    walSha256: value.binding.walSha256,
    logicalSnapshotSha256: value.binding.logicalSnapshotSha256,
    stateSnapshotSha256: value.binding.stateSnapshotSha256,
    schemaSqlSha256: value.binding.schemaSqlSha256,
    submissionCaptureHash: value.binding.submissionCaptureHash,
    immutableSubmissionIntakeSha256: value.binding.immutableSubmissionIntakeSha256,
  };
  return {
    env: {
      FILMOS_REVIEW_BUS_RUNTIME_MODE: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
      FILMOS_REVIEW_BUS_LOCAL_DIR: value.directory,
      FILMOS_REVIEW_BUS_HOST: "127.0.0.1",
      FILMOS_REVIEW_BUS_PORT: "0",
      FILMOS_REVIEW_TASK_PACKAGE_HASH: taskHash,
      ...source.env,
      FILMOS_REVIEW_SEAL_PROJECT_ID: value.target.projectId,
      FILMOS_REVIEW_SEAL_ISSUE_ID: value.target.issueId,
      FILMOS_REVIEW_SEAL_SUBMISSION_ID: value.target.submissionId,
      FILMOS_REVIEW_SEAL_ACTOR: value.target.actor,
      FILMOS_REVIEW_SEAL_ASSESSMENT_ROUND: String(value.target.assessmentRound),
      FILMOS_REVIEW_SEAL_ENTITY_VERSION: String(value.target.entityVersion),
      FILMOS_REVIEW_SEAL_ISSUE_EVENT_COUNT: String(value.target.issueEventCount),
      FILMOS_REVIEW_SEAL_LAST_EVENT_HASH: value.target.lastEventHash,
      FILMOS_REVIEW_SEAL_PROJECTION_HASH: value.target.projectionHash,
      FILMOS_REVIEW_SEAL_INTAKE_RECEIPT_HASH: value.target.intakeReceiptHash,
      FILMOS_REVIEW_SEAL_DATABASE_REALPATH: value.databasePath,
      FILMOS_REVIEW_SEAL_DATABASE_DEVICE: String(value.binding.device),
      FILMOS_REVIEW_SEAL_DATABASE_INODE: String(value.binding.inode),
      FILMOS_REVIEW_SEAL_DATABASE_SIZE: String(value.binding.size),
      FILMOS_REVIEW_SEAL_DATABASE_SHA256: value.binding.sha256,
      FILMOS_REVIEW_SEAL_DATABASE_JOURNAL_MODE: value.binding.journalMode,
      FILMOS_REVIEW_SEAL_DATABASE_PAGE_COUNT: String(value.binding.pageCount),
      FILMOS_REVIEW_SEAL_DATABASE_SCHEMA_VERSION: String(value.binding.schemaVersion),
      FILMOS_REVIEW_SEAL_DATABASE_WAL_SHA256: value.binding.walSha256,
      FILMOS_REVIEW_SEAL_LOGICAL_SNAPSHOT_SHA256: value.binding.logicalSnapshotSha256,
    },
    options: {
      assessmentSealTestOnly: {
        enabled: true,
        canonicalDatabase: value.databasePath,
        expectedSourceRoot: source.repository,
        expectedTarget: value.target,
        expectedDatabaseOrigin,
        port: 0,
      },
    },
  };
}

async function startAssessmentSealServer(value, store = value.createSealStore()) {
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const busToken = "bus-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({
    service,
    store,
    busToken,
    bridgeToken: "bridge-token-1234567890-abcdefghijkl",
    constitution,
    runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
    sealContext: {
      sourceIdentity: value.sourceIdentity,
      target: store.sealTarget,
    },
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  return {
    server,
    store,
    service,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    headers: { authorization: `Bearer ${busToken}`, "content-type": "application/json", origin: "http://127.0.0.1:43100" },
  };
}

function createCoreIssue(service, suffix = "a") {
  const issue = service.createIssue({ issue_id: `FILMOS-ISSUE-${suffix}`, project_id: projectId, what_happened: "Host request failed", expected_result: "ChatGPT answers", location: "Agent panel", blocks_work: true, lane: "core" });
  service.freezeEvidence(issue.issue_id, { source_commit: commit, items: [
    { kind: "reproduction", completeness_kind: "reproduction", content: { steps: ["click", "send"] } },
    { kind: "runtime", completeness_kind: "runtime", content: { state: "failed", runtime_key: "secret-value" } },
    { kind: "logs", completeness_kind: "logs", content: "Bearer abcdefghijklmnop /Users/alice/private/log.json" },
    { kind: "source", completeness_kind: "sourceMap", content: { file: "web/agent.tsx" } },
  ] });
  return service.requireIssue(issue.issue_id);
}

function createFastIssue(service, suffix, scope = ["web/copy.ts"]) {
  const issue = service.createIssue({ issue_id: `FILMOS-ISSUE-${suffix}`, project_id: projectId, what_happened: "Wording is unclear", expected_result: "Clear wording", location: scope[0], blocks_work: false, lane: "fast", allowed_change_scope: scope });
  return service.freezeEvidence(issue.issue_id, { source_commit: commit, items: [
    { kind: "reproduction", completeness_kind: "reproduction", content: { steps: ["open"] } },
    { kind: "runtime", completeness_kind: "runtime", content: { state: "ready" } },
    { kind: "logs", completeness_kind: "logs", content: "no runtime errors" },
    { kind: "source", completeness_kind: "sourceMap", content: { files: scope } },
  ] });
}

const codexAssessment = { reproduced: true, root_cause: "host context is stale", call_chain: ["ui", "host"], files: ["web/agent.tsx"], minimal_change: ["refresh context"], regression_risk: "low", tests: ["host context test"], rollback: ["revert"] };
const chatgptAssessment = { product_goal_fit: false, root_cause: "host context is stale", root_cause_explains_symptom: true, authority_risk: false, resolution_layer: "workflow", workflow_impact: "restores handoff", acceptance_gates: ["host ready"], scope_drift: false };
const architectureDelta = { current_flow: "single route", current_blocker: "multi route missing", target_experience: "per task routes", must_preserve: ["Film Core authority"], may_change: ["policy adapter"], success_criteria: ["Pilot copy passes"] };
const architectureOptions = [{ option: "A", kind: "local extension" }, { option: "B", kind: "structure evolution" }, { option: "C", kind: "core rewrite" }];
const architectureEvidence = [
  { kind: "reproduction", completeness_kind: "reproduction", content: { steps: ["open architecture issue"] } },
  { kind: "runtime", completeness_kind: "runtime", content: { state: "ready" } },
  { kind: "logs", completeness_kind: "logs", content: "architecture trace" },
  { kind: "source", completeness_kind: "sourceMap", content: { file: "services/filmos-review-bus/src/service.mjs" } },
];
const architectureTaskInput = {
  allowedChangeScope: ["web/agent.tsx"],
  explicitNonGoals: ["Canvas schema migration"],
  implementationPlan: ["Apply the frozen architecture option"],
  acceptanceGates: ["Architecture v2 tests pass"],
  rollbackPlan: ["Revert the candidate commit"],
};

function createAcceptedArchitecture(service, suffix) {
  const issue = service.createIssue({ issue_id: `FILMOS-ARCH-${suffix}`, project_id: projectId, what_happened: "current structure blocks real work", expected_result: "evolvable structure", location: "project workflow", blocks_work: true, lane: "architecture" });
  service.freezeRequirementDelta(issue.issue_id, architectureDelta);
  service.freezeEvidence(issue.issue_id, { source_commit: commit, items: architectureEvidence });
  service.beginArchitectureAssessments(issue.issue_id);
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  const ownerGate = service.setArchitectureOptions(issue.issue_id, architectureOptions);
  const selected = ownerGate.architecture_options.options.find((item) => item.option === "B");
  return service.acceptArchitectureOption(issue.issue_id, { option: "B", option_content_hash: selected.content_hash, user_authorized: true });
}
function candidate(overrides = {}) {
  const value = { candidate_id: "candidate-1", base_commit: commit, candidate_commit: "d".repeat(40), tree: "e".repeat(40), branch: "fix/example", github_run: { id: 123, head_sha: "d".repeat(40), conclusion: "success" }, artifact_id: "artifact-1", artifact_digest: `sha256:${"f".repeat(64)}`, artifact_commit: "d".repeat(40), evidence_index_hash: "a".repeat(64), task_package_content_hash: taskHash, constitution_content_hash: constitutionHash, candidate_nonce: "nonce-1234567890-abcdef", changed_files: ["web/agent.tsx"], known_limitations: [], ...overrides };
  const remote = { schema_version: "filmos.github-evidence-verification.v1", status: "VERIFIED", repository: "maiyadiu/filmos-studio", candidate_commit: value.candidate_commit, candidate_tree: value.tree, branch: value.branch, github_run_id: String(value.github_run.id), artifact_id: String(value.artifact_id), artifact_digest: value.artifact_digest, evidence_index_hash: value.evidence_index_hash, checks: { commit_exists: true, tree_matches: true, branch_exists: true, run_exists: true, run_head_matches: true, run_success: true, artifact_exists: true, artifact_run_matches: true, artifact_digest_matches: true, evidence_index_present: true, evidence_index_hash_matches: true }, verified_at: "2026-08-31T12:00:00.000Z" };
  return { ...value, github_remote_verification: overrides.github_remote_verification ?? { ...remote, content_hash: sha256(remote) } };
}
function strictFinding(findingId, overrides = {}) { return { finding_id: findingId, severity: "P0", category: "runtime", title: "Host context is stale", problem: "The current Host context cannot accept the request.", evidence: [{ source_type: "github_file", locator: "web/agent.tsx", line_start: 1 }], required_change: "Refresh the Host context before sending.", acceptance_gate: "Host readiness integration test passes.", ...overrides }; }
function reviewDecision(issueId, value, overrides = {}) { return { purpose: "CHATGPT_REVIEW_DECISION", issue_id: issueId, candidate_id: value.candidate_id, candidate_commit: value.candidate_commit, verdict: "CHANGES_REQUIRED", summary: "Candidate needs one bounded fix.", findings: [strictFinding("finding-round-1")], closed_finding_ids: [], reopened_finding_ids: [], accepted_limitations: [], scope_assessment: { task_package_hash_matches: true, constitution_hash_matches: true, out_of_scope_changes: [] }, confidence: "high", ...overrides }; }
function reachConsensus(service, issueId) {
  service.submitAssessment(issueId, "codex", codexAssessment);
  const proposed = service.submitAssessment(issueId, "chatgpt", chatgptAssessment);
  const proposalHash = proposed.consensus_proposal.contentHash;
  service.respondConsensus(issueId, "codex", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
  return service.respondConsensus(issueId, "chatgpt", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
}

function handoffArtifact({ evidenceEntries = [[`${handoffName}/EVIDENCE_INDEX.json`, '{"schema_version":"test"}\n']], outerName = `${handoffName}.zip` } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-artifact-test-"));
  const nestedRoot = resolve(directory, "nested");
  const outerRoot = resolve(directory, "outer");
  mkdirSync(nestedRoot, { recursive: true });
  mkdirSync(outerRoot, { recursive: true });
  if (evidenceEntries.length === 0) evidenceEntries = [[`${handoffName}/README.txt`, "no evidence index"]];
  for (const [relativePath, content] of evidenceEntries) {
    const path = resolve(nestedRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const nestedZip = resolve(directory, `${handoffName}.zip`);
  const roots = [...new Set(evidenceEntries.map(([relativePath]) => relativePath.split("/")[0]))];
  execFileSync("zip", ["-q", "-r", nestedZip, ...roots], { cwd: nestedRoot });
  const outerEntry = resolve(outerRoot, outerName);
  mkdirSync(dirname(outerEntry), { recursive: true });
  copyFileSync(nestedZip, outerEntry);
  const artifactPath = resolve(directory, "artifact.zip");
  execFileSync("zip", ["-q", "-r", artifactPath, outerName.split("/")[0]], { cwd: outerRoot });
  return { path: artifactPath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function candidateArtifact({ evidenceEntries = [["EVIDENCE_INDEX.json", '{"schema_version":"test"}\n']] } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-candidate-artifact-test-"));
  const outerRoot = resolve(directory, "outer");
  mkdirSync(outerRoot, { recursive: true });
  if (evidenceEntries.length === 0) evidenceEntries = [["README.txt", "no evidence index"]];
  for (const [relativePath, content] of evidenceEntries) {
    const path = resolve(outerRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const artifactPath = resolve(directory, "artifact.zip");
  const roots = [...new Set(evidenceEntries.map(([relativePath]) => relativePath.split("/")[0]))];
  execFileSync("zip", ["-q", "-r", artifactPath, ...roots], { cwd: outerRoot });
  return { path: artifactPath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function githubApiFor(value) {
  return async (endpoint) => {
    if (endpoint.includes("/git/commits/")) return { sha: value.candidate_commit, tree: { sha: value.tree } };
    if (endpoint.includes("/branches/")) return { commit: { sha: value.candidate_commit } };
    if (endpoint.includes("/actions/runs/")) return { id: value.github_run.id, head_sha: value.candidate_commit, conclusion: "success" };
    if (endpoint.includes("/actions/artifacts/")) return { id: value.artifact_id, digest: value.artifact_digest, expired: false, workflow_run: { head_sha: value.candidate_commit } };
    throw new Error("unexpected endpoint");
  };
}

test("consensus changes advance to an append-only assessment round with fresh evidence bindings", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "consensus-round");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const proposed = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  const firstHash = proposed.consensus_proposal.contentHash;
  service.respondConsensus(issue.issue_id, "codex", { proposal_content_hash: firstHash, position: "CHANGES_REQUESTED", requested_changes: ["narrow scope"] });
  service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: firstHash, position: "CHANGES_REQUESTED", requested_changes: ["bind evidence"] });

  const advanced = service.startNextAssessmentRound(issue.issue_id);
  assert.equal(advanced.state, "EVIDENCE_FROZEN");
  assert.equal(advanced.assessment_round, 2);
  assert.equal(advanced.assessment_round_history.length, 1);
  assert.equal(advanced.assessment_round_history[0].consensus_proposal.contentHash, firstHash);
  assert.equal(advanced.assessment_round_history[0].consensus_responses.length, 2);
  assert.deepEqual(advanced.assessments, {});
  assert.equal(advanced.consensus_proposal, null);
  const roundTwoCoordinationKey = service.pending(projectId).find((item) => item.issue_id === issue.issue_id).coordination_key;

  const codex = service.submitAssessment(issue.issue_id, "codex", codexAssessment).assessments.codex;
  assert.equal(codex.assessment_round, 2);
  assert.equal(codex.project_id, projectId);
  assert.equal(codex.evidence_manifest_hash, service.requireIssue(issue.issue_id).evidence.manifest.contentHash);
  assert.equal(codex.constitution_content_hash, constitutionHash);
  const second = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  assert.equal(second.consensus_proposal.assessmentRound, 2);
  assert.equal(second.consensus_proposal.evidenceManifestHash, codex.evidence_manifest_hash);
  assert.notEqual(second.consensus_proposal.contentHash, firstHash);
  service.respondConsensus(issue.issue_id, "codex", { proposal_content_hash: second.consensus_proposal.contentHash, position: "CHANGES_REQUESTED", requested_changes: ["refine gates"] });
  service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: second.consensus_proposal.contentHash, position: "CHANGES_REQUESTED", requested_changes: ["refine gates"] });
  const thirdRound = service.startNextAssessmentRound(issue.issue_id);
  assert.equal(thirdRound.state, "EVIDENCE_FROZEN");
  assert.equal(thirdRound.assessment_round, 3);
  const roundThreeCoordinationKey = service.pending(projectId).find((item) => item.issue_id === issue.issue_id).coordination_key;
  assert.notEqual(roundThreeCoordinationKey, roundTwoCoordinationKey);
  store.close();
});

test("consensus proposal preserves structured evidence gaps from the paired assessments", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "structured-evidence-gaps");
  const screenshotGap = "screenshot=false; structured context is not pixel evidence";
  const remoteReceiptGap = "GitHub Run, Artifact, and Evidence Index receipts are missing";
  service.submitAssessment(issue.issue_id, "codex", { ...codexAssessment, evidence_gaps: [screenshotGap] });
  const proposed = service.submitAssessment(issue.issue_id, "chatgpt", {
    ...chatgptAssessment,
    needs_more_evidence: true,
    evidence_gaps: [screenshotGap, remoteReceiptGap],
  });

  assert.deepEqual(proposed.consensus_delta.evidence_differences, [screenshotGap, remoteReceiptGap]);
  assert.deepEqual(proposed.consensus_proposal.evidenceGaps, [screenshotGap, remoteReceiptGap]);
  assert.equal(proposed.consensus_proposal.evidenceGaps.includes("additional_evidence_requested"), false);
  store.close();
});

test("Review Bus uses SQLite WAL, immutable events, and redacts the external evidence projection", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "sqlite");
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  assert.throws(() => store.db.exec("UPDATE review_events SET actor='tamper'"), /REVIEW_EVENT_APPEND_ONLY/);
  const redacted = service.readRedacted(issue.issue_id, projectId);
  const admin = service.readRedactedAdmin(issue.issue_id);
  assert.equal(admin.event_chain_verified, true);
  assert.equal("local_items" in redacted.evidence, false);
  const body = JSON.stringify(redacted);
  assert.equal(body.includes("secret-value"), false);
  assert.equal(body.includes("/Users/alice"), false);
  assert.match(body, /REDACTED_SECRET/);
  const backup = store.backup(resolve(directory, "backups/review-bus.sqlite"));
  assert.equal(existsSync(backup.destination), true);
  assert.match(backup.sha256, /^[0-9a-f]{64}$/);
  const backupDatabase = new DatabaseSync(backup.destination, { readOnly: true });
  assert.equal(backupDatabase.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(backupDatabase.prepare("SELECT COUNT(*) AS count FROM review_projections").get().count, store.db.prepare("SELECT COUNT(*) AS count FROM review_projections").get().count);
  assert.equal(backupDatabase.prepare("SELECT COUNT(*) AS count FROM review_events").get().count, store.db.prepare("SELECT COUNT(*) AS count FROM review_events").get().count);
  backupDatabase.close();
  store.close();
});

test("GitHub verifier independently binds commit, tree, branch, successful Run, Artifact digest, and Artifact Evidence Index", async () => {
  const evidenceBytes = Buffer.from('{"schema_version":"test"}\n');
  const value = candidate({ artifact_id: "456", evidence_index_hash: sha256(evidenceBytes.toString("utf8")) });
  const apiJson = async (endpoint) => {
    if (endpoint.includes("/git/commits/")) return { sha: value.candidate_commit, tree: { sha: value.tree } };
    if (endpoint.includes("/branches/")) return { commit: { sha: value.candidate_commit } };
    if (endpoint.includes("/actions/runs/")) return { id: 123, head_sha: value.candidate_commit, conclusion: "success" };
    if (endpoint.includes("/actions/artifacts/")) return { id: 456, digest: value.artifact_digest, expired: false, workflow_run: { head_sha: value.candidate_commit } };
    throw new Error("unexpected endpoint");
  };
  let cleaned = false;
  const verifier = new GitHubEvidenceVerifier({ apiJson, downloadArtifact: async () => ({ cleanup: () => { cleaned = true; } }), readArtifactEvidenceIndex: async () => evidenceBytes, now: () => new Date("2026-08-31T12:00:00.000Z") });
  const receipt = await verifier.verify(value);
  assert.equal(receipt.status, "VERIFIED");
  assert.equal(receipt.checks.evidence_index_hash_matches, true);
  assert.equal(receipt.repository, "maiyadiu/filmos-studio");
  assert.equal(cleaned, true);
  await assert.rejects(() => new GitHubEvidenceVerifier({ apiJson: async (endpoint) => endpoint.includes("artifacts") ? { id: 456, digest: `sha256:${"0".repeat(64)}`, expired: false } : apiJson(endpoint), downloadArtifact: async () => ({}), readArtifactEvidenceIndex: async () => evidenceBytes }).verify(value), /artifact_digest_matches/);
});

test("GitHub Artifact resolves the unique nested Handoff Evidence Index and verifies its byte hash", async () => {
  const artifact = handoffArtifact();
  const expected = Buffer.from('{"schema_version":"test"}\n');
  const value = candidate({ artifact_id: "456", evidence_index_hash: sha256(expected.toString("utf8")) });
  try {
    assert.deepEqual(await readHandoffEvidenceIndex(artifact), expected);
    const receipt = await new GitHubEvidenceVerifier({
      apiJson: githubApiFor(value),
      downloadArtifact: async () => artifact,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    }).verify(value);
    assert.equal(receipt.checks.evidence_index_hash_matches, true);
  } finally { artifact.cleanup(); }
});

test("candidate-stage GitHub Artifact accepts one exact root Evidence Index without a final Handoff", async () => {
  const artifact = candidateArtifact();
  const expected = Buffer.from('{"schema_version":"test"}\n');
  const value = candidate({ artifact_id: "456", evidence_index_hash: sha256(expected.toString("utf8")) });
  try {
    assert.deepEqual(await readArtifactEvidenceIndex(artifact), expected);
    const receipt = await new GitHubEvidenceVerifier({
      apiJson: githubApiFor(value),
      downloadArtifact: async () => artifact,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    }).verify(value);
    assert.equal(receipt.checks.evidence_index_hash_matches, true);
  } finally { artifact.cleanup(); }
});

test("candidate-stage GitHub Artifact fails closed on missing, duplicate, or nested Evidence Index", async () => {
  const missing = candidateArtifact({ evidenceEntries: [] });
  const duplicate = candidateArtifact({ evidenceEntries: [
    ["EVIDENCE_INDEX.json", "one"],
    ["rogue/EVIDENCE_INDEX.json", "two"],
  ] });
  const nested = candidateArtifact({ evidenceEntries: [["nested/EVIDENCE_INDEX.json", "one"]] });
  try {
    await assert.rejects(() => readArtifactEvidenceIndex(missing), /ARTIFACT_EVIDENCE_INDEX_MISSING/);
    await assert.rejects(() => readArtifactEvidenceIndex(duplicate), /ARTIFACT_EVIDENCE_INDEX_AMBIGUOUS/);
    await assert.rejects(() => readArtifactEvidenceIndex(nested), /ARTIFACT_EVIDENCE_INDEX_INVALID_NESTING/);
  } finally { missing.cleanup(); duplicate.cleanup(); nested.cleanup(); }
});

test("GitHub Artifact fails closed when the Handoff Evidence Index is missing", async () => {
  const artifact = handoffArtifact({ evidenceEntries: [] });
  try { await assert.rejects(() => readHandoffEvidenceIndex(artifact), /ARTIFACT_EVIDENCE_INDEX_MISSING/); }
  finally { artifact.cleanup(); }
});

test("GitHub Artifact fails closed on duplicate Evidence Indexes and illegal Handoff nesting", async () => {
  const duplicate = handoffArtifact({ evidenceEntries: [
    [`${handoffName}/EVIDENCE_INDEX.json`, "one"],
    ["rogue/EVIDENCE_INDEX.json", "two"],
  ] });
  const illegal = handoffArtifact({ outerName: `nested/${handoffName}.zip` });
  try {
    await assert.rejects(() => readHandoffEvidenceIndex(duplicate), /ARTIFACT_EVIDENCE_INDEX_AMBIGUOUS/);
    await assert.rejects(() => readHandoffEvidenceIndex(illegal), /ARTIFACT_HANDOFF_MISSING/);
  } finally { duplicate.cleanup(); illegal.cleanup(); }
});

test("GitHub Artifact fails closed when the declared Evidence Index hash drifts from nested bytes", async () => {
  const artifact = handoffArtifact();
  const value = candidate({ artifact_id: "456", evidence_index_hash: "0".repeat(64) });
  try {
    await assert.rejects(() => new GitHubEvidenceVerifier({
      apiJson: githubApiFor(value),
      downloadArtifact: async () => artifact,
    }).verify(value), /evidence_index_hash_matches/);
  } finally { artifact.cleanup(); }
});

test("formal live trace preserves multiple assessment rounds while requiring candidate-bound A to B reviews", () => {
  const candidateA = candidate({ candidate_id: "candidate-A" });
  const candidateB = candidate({ candidate_id: "candidate-B", candidate_commit: "b".repeat(40), tree: "c".repeat(40), github_run: { id: 124, head_sha: "b".repeat(40), conclusion: "success" }, artifact_id: "artifact-B", artifact_commit: "b".repeat(40), candidate_nonce: "nonce-B-1234567890-abcdef" });
  const roundOneAssessment = { assessment_round: 1, content_hash: "6".repeat(64) };
  const roundOneConsensus = { actor: "chatgpt", content_hash: "7".repeat(64) };
  const archivedRoundBase = {
    assessment_round: 1,
    assessments: { chatgpt: roundOneAssessment },
    consensus_delta: null,
    consensus_proposal: { contentHash: "8".repeat(64) },
    consensus_responses: [roundOneConsensus],
    ended_at: "2026-08-31T10:00:00.000Z",
    reason: "CONSENSUS_CHANGES_REQUESTED",
  };
  const decisionA = { purpose: "CHATGPT_REVIEW_DECISION", verdict: "CHANGES_REQUIRED", round: 1, candidate_binding: candidateBinding(candidateA), content_hash: "9".repeat(64) };
  const decisionB = { purpose: "CHATGPT_REVIEW_DECISION", verdict: "EXTERNAL_APPROVED", round: 2, candidate_binding: candidateBinding(candidateB), content_hash: "a".repeat(64) };
  const issue = {
    issue_id: "FILMOS-ISSUE-live-trace",
    project_id: projectId,
    state: "DUAL_APPROVED",
    current_round: 2,
    candidate_history: [
      { candidate: candidateA, status: "SUPERSEDED", round: 1, supersededByCandidateId: "candidate-B" },
      { candidate: candidateB, status: "APPROVED", round: 2 },
    ],
    findings: [{ finding_id: "finding-1", severity: "P0", status: "CLOSED" }],
    finding_responses: [{ finding_id: "finding-1", disposition: "FIXED_WITH_EVIDENCE" }],
    assessment_round: 2,
    assessment_round_history: [{ ...archivedRoundBase, content_hash: sha256(archivedRoundBase) }],
    assessments: { chatgpt: { assessment_round: 2, content_hash: "b".repeat(64) } },
    consensus_responses: [{ actor: "chatgpt", content_hash: "c".repeat(64) }],
    decision_history: [decisionA, decisionB],
    verdicts: { codex: "LOCAL_ACCEPTED", chatgpt: "EXTERNAL_APPROVED", machine: "PASS" },
    dual_signoff: { content_hash: "1".repeat(64) },
    issue_task_package: { contentHash: "2".repeat(64) },
    consensus_record: { contentHash: "3".repeat(64) },
    runtime_recovery: { observed_start_ids: ["runtime-first-1234567890", "runtime-second-123456789"] },
    codex_coordination: { status: "COMPLETED", session_id: "brain-session-live-123" },
    evidence: { manifest: { contentHash: "4".repeat(64) } },
    attachments: [{ attachment_id: "attachment-1", sha256: "5".repeat(64), size_bytes: 10 }],
  };
  const events = [
    ["runtime.observed", "filmos-review-bus", {}],
    ["assessment.codex.submitted", "codex", {}],
    ["assessment.chatgpt.submitted", "chatgpt", { content_hash: roundOneAssessment.content_hash }],
    ["consensus.responded", "chatgpt", roundOneConsensus],
    ["assessment.round.advanced", "codex", {}],
    ["assessment.chatgpt.submitted", "chatgpt", { content_hash: issue.assessments.chatgpt.content_hash }],
    ["consensus.responded", "chatgpt", issue.consensus_responses[0]],
    ["chatgpt.review_decision", "chatgpt", { decision: decisionA }],
    ["finding.codex_response", "codex", {}],
    ["runtime.observed", "filmos-review-bus", {}],
    ["chatgpt.review_decision", "chatgpt", { decision: decisionB }],
    ["codex.coordination", "review-codex-coordinator", {}],
    ["verdict.codex", "codex", {}],
  ].map(([event_type, actor, payload], index) => ({ issue_id: issue.issue_id, event_type, actor, payload, event_hash: String(index).padStart(64, "0") }));
  const trace = buildLiveRoundtripTrace(issue, events, { eventChainVerified: true, generatedAt: new Date("2026-08-31T12:00:00.000Z") });
  assert.equal(trace.status, "PASSED");
  assert.equal(trace.formal_github_remote_evidence, true);
  assert.equal(trace.chatgpt_user_gesture_writebacks.exact_count, 6);
  assert.equal(trace.chatgpt_user_gesture_writebacks.assessment, 2);
  assert.equal(trace.chatgpt_user_gesture_writebacks.consensus, 2);
  assert.equal(trace.chatgpt_user_gesture_writebacks.candidate_reviews, 2);
  assert.equal(trace.chatgpt_user_gesture_writebacks.assessment_rounds, 2);
  const localOnly = structuredClone(issue);
  localOnly.candidate_history[1].candidate.github_remote_verification.verification_mode = "DETERMINISTIC_LOCAL_ACCEPTANCE_ONLY";
  assert.throws(() => buildLiveRoundtripTrace(localOnly, events, { eventChainVerified: true }), /FORMAL_GITHUB_REMOTE_EVIDENCE_REQUIRED/);
});

test("attachments stay local and a post-freeze text crash report preserves every authority binding", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-attachment-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "attachment");
  const bytes = Buffer.from("real screenshot bytes");
  const stored = service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-pasted-1",
    media_type: "image/png",
    original_name: "private-desktop-name.png",
    base64: bytes.toString("base64"),
    captured_at: "2026-08-31T10:00:00.000Z",
  });
  assert.match(stored.attachment.sha256, /^[0-9a-f]{64}$/);
  const local = service.readLocalAttachment(issue.issue_id, "attachment-pasted-1", projectId);
  assert.deepEqual(local.bytes, bytes);
  assert.equal(local.metadata.original_name, "private-desktop-name.png");
  assert.equal(local.metadata.local_path.startsWith(resolve(directory, "evidence", issue.issue_id)), true);
  const redacted = service.readRedacted(issue.issue_id, projectId);
  const external = JSON.stringify(redacted);
  assert.equal(external.includes("private-desktop-name.png"), false);
  assert.equal(external.includes(directory), false);
  assert.equal(external.includes("evidence://"), true);
  assert.equal(redacted.evidence.manifest.completeness.screenshot, true);

  const consensus = reachConsensus(service, issue.issue_id);
  const active = service.submitCandidate(issue.issue_id, candidate({
    consensus_record_hash: consensus.consensus_record.contentHash,
    task_package_content_hash: consensus.issue_task_package.contentHash,
  })).active_candidate;
  const binding = candidateBinding(active);
  service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding });
  service.recordVerdict(issue.issue_id, "chatgpt", { verdict: "EXTERNAL_APPROVED", binding });
  service.recordVerdict(issue.issue_id, "machine", { verdict: "PASS", binding });
  const beforeSupplement = service.requireIssue(issue.issue_id);
  assert.equal(beforeSupplement.state, "DUAL_APPROVED");
  const immutableBefore = {
    manifest: beforeSupplement.evidence.manifest,
    local_items: beforeSupplement.evidence.local_items,
    task_package: beforeSupplement.issue_task_package,
    task_package_content_hash: beforeSupplement.task_package_content_hash,
    active_candidate: beforeSupplement.active_candidate,
    candidate_history: beforeSupplement.candidate_history,
    verdicts: beforeSupplement.verdicts,
    verdict_bindings: beforeSupplement.verdict_bindings,
    dual_signoff: beforeSupplement.dual_signoff,
  };
  const crashBytes = Buffer.from("Chrome launch crash\nSIGABRT in HIServices\n", "utf8");
  const supplemental = service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-chrome-crash-1",
    media_type: "text/plain",
    original_name: "private-crash-report.txt",
    base64: crashBytes.toString("base64"),
    captured_at: "2026-09-01T04:00:38.858Z",
  });
  const afterSupplement = supplemental.issue;
  assert.equal(afterSupplement.state, "DUAL_APPROVED");
  assert.deepEqual({
    manifest: afterSupplement.evidence.manifest,
    local_items: afterSupplement.evidence.local_items,
    task_package: afterSupplement.issue_task_package,
    task_package_content_hash: afterSupplement.task_package_content_hash,
    active_candidate: afterSupplement.active_candidate,
    candidate_history: afterSupplement.candidate_history,
    verdicts: afterSupplement.verdicts,
    verdict_bindings: afterSupplement.verdict_bindings,
    dual_signoff: afterSupplement.dual_signoff,
  }, immutableBefore);
  assert.equal(afterSupplement.evidence.supplemental_items.length, 1);
  assert.equal(afterSupplement.evidence.supplemental_items[0].kind, "attachment");
  assert.equal(afterSupplement.evidence.supplemental_items[0].authority_binding.dual_signoff_hash, immutableBefore.dual_signoff.content_hash);
  assert.deepEqual(service.readLocalAttachment(issue.issue_id, "attachment-chrome-crash-1", projectId).bytes, crashBytes);
  const supplementalExternal = JSON.stringify(service.readRedacted(issue.issue_id, projectId));
  assert.equal(supplementalExternal.includes("private-crash-report.txt"), false);
  assert.equal(supplementalExternal.includes("SIGABRT"), false);
  assert.equal(supplementalExternal.includes(directory), false);
  assert.throws(() => service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-unsupported",
    media_type: "application/pdf",
    original_name: "unsupported.pdf",
    base64: Buffer.from("pdf").toString("base64"),
    captured_at: undefined,
  }), /INVALID_ATTACHMENT_MEDIA_TYPE/);
  assert.throws(() => service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-text-too-large",
    media_type: "text/plain",
    original_name: "too-large.txt",
    base64: Buffer.alloc(1024 * 1024 + 1, 65).toString("base64"),
    captured_at: undefined,
  }), /INVALID_ATTACHMENT_BYTES/);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("supplemental crash evidence is append-only after Task Package freeze and does not stale the active candidate", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-supplemental-attachment-"));
  const store = new ReviewBusStore(resolve(directory, "review-bus.sqlite"));
  const service = new ReviewBusService(store, { baseCommit: commit });
  const issue = createCoreIssue(service, "supplemental-attachment");
  const consensus = reachConsensus(service, issue.issue_id);
  const submitted = service.submitCandidate(issue.issue_id, candidate({
    consensus_record_hash: consensus.consensus_record.contentHash,
    task_package_content_hash: consensus.issue_task_package.contentHash,
  }));
  const before = service.requireIssue(issue.issue_id);
  const beforeManifestHash = before.evidence.manifest.contentHash;
  const beforeTaskPackageHash = before.task_package_content_hash;
  const beforeCandidateHash = before.active_candidate.content_hash;
  const stored = service.storeAttachment(issue.issue_id, {
    attachment_id: "attachment-chrome-crash-report",
    media_type: "text/plain",
    original_name: "chrome-crash.txt",
    base64: Buffer.from("Chrome SIGABRT report").toString("base64"),
    captured_at: "2026-09-01T04:00:38.858Z",
  });
  assert.equal(stored.issue.state, submitted.state);
  assert.equal(stored.issue.evidence.manifest.contentHash, beforeManifestHash);
  assert.equal(stored.issue.task_package_content_hash, beforeTaskPackageHash);
  assert.equal(stored.issue.active_candidate.content_hash, beforeCandidateHash);
  assert.equal(stored.issue.attachments.length, 1);
  assert.match(stored.issue.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.issue.evidence.supplemental_items.length, 1);
  assert.equal(stored.issue.evidence.supplemental_items[0].kind, "attachment");
  assert.equal(store.events(issue.issue_id).at(-1).event_type, "evidence.supplemented");
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("blind assessment prevents anchoring until both experts submit", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "blind");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const blind = service.assessmentBlind(issue.issue_id, "chatgpt");
  assert.equal(blind.counterpart_assessment, null);
  assert.equal(blind.counterpart_sealed, true);
  service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  const paired = service.assessmentBlind(issue.issue_id, "chatgpt");
  assert.equal(paired.pair_complete, true);
  assert.equal(paired.counterpart_assessment.root_cause, codexAssessment.root_cause);
  assert.equal(service.requireIssue(issue.issue_id).state, "CONSENSUS_PROPOSED");
  store.close();
});

test("paired assessments auto-create a stable Consensus Proposal and dual responses freeze Record plus per-issue Task Package", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "proposal");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const proposed = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  assert.equal(proposed.state, "CONSENSUS_PROPOSED");
  assert.equal(proposed.consensus_proposal.codexPosition, "PENDING");
  assert.equal(proposed.consensus_proposal.chatgptPosition, "PENDING");
  assert.match(proposed.consensus_proposal.contentHash, /^[0-9a-f]{64}$/);
  const hash = proposed.consensus_proposal.contentHash;
  const codexAccepted = service.respondConsensus(issue.issue_id, "codex", { proposal_content_hash: hash, position: "ACCEPTED", requested_changes: [] });
  assert.equal(codexAccepted.consensus_proposal.contentHash, hash);
  assert.equal(codexAccepted.consensus_record, undefined);
  const frozen = service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: hash, position: "ACCEPTED", requested_changes: [] });
  assert.equal(frozen.state, "TASK_PACKAGE_FROZEN");
  assert.match(frozen.consensus_record.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(frozen.issue_task_package.consensusRecordHash, frozen.consensus_record.contentHash);
  assert.equal(frozen.issue_task_package.evidenceManifestHash, frozen.evidence.manifest.contentHash);
  assert.notEqual(frozen.issue_task_package.contentHash, frozen.build_lineage_task_package_hash);
  assert.throws(() => service.respondConsensus(issue.issue_id, "chatgpt", { proposal_content_hash: hash, position: "ACCEPTED", requested_changes: [] }), /CONSENSUS_RESPONSE_IMMUTABLE/);
  store.close();
});

test("Task Package hash is issue-specific and candidate scope fails closed", () => {
  const { service, store } = fixture();
  const first = createFastIssue(service, "task-a", ["web/a.ts"]);
  const second = createFastIssue(service, "task-b", ["web/b.ts"]);
  assert.notEqual(first.issue_task_package.contentHash, second.issue_task_package.contentHash);
  assert.throws(() => service.submitCandidate(first.issue_id, candidate({ changed_files: ["web/b.ts"], task_package_content_hash: first.issue_task_package.contentHash })), /CANDIDATE_SCOPE_EXCEEDED/);
  assert.throws(() => service.submitCandidate(first.issue_id, candidate({ changed_files: ["web/a.ts"], task_package_content_hash: taskHash })), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("Core candidate needs consensus and Codex cannot self-approve external review", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "consensus");
  const value = candidate();
  assert.throws(() => service.submitCandidate(issue.issue_id, value), /IMPLEMENTATION_BLOCKED_NO_CONSENSUS/);
  const consensus = reachConsensus(service, issue.issue_id);
  value.consensus_record_hash = consensus.consensus_record.contentHash;
  value.task_package_content_hash = consensus.issue_task_package.contentHash;
  const submitted = service.submitCandidate(issue.issue_id, value);
  const binding = candidateBinding(submitted.active_candidate);
  assert.throws(() => service.recordVerdict(issue.issue_id, "codex", "EXTERNAL_APPROVED"), /REVIEW_CODEX_CANNOT_SELF_APPROVE/);
  assert.throws(() => service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding: { ...binding, candidate_commit: "0".repeat(40) } }), /CURRENT_CANDIDATE_BINDING_MISMATCH/);
  service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding });
  service.recordVerdict(issue.issue_id, "chatgpt", { verdict: "EXTERNAL_APPROVED", binding });
  const accepted = service.recordVerdict(issue.issue_id, "machine", { verdict: "PASS", binding });
  assert.equal(accepted.state, "DUAL_APPROVED");
  assert.equal(accepted.next_pilot_allowed, true);
  assert.ok(accepted.dual_signoff.content_hash);
  store.close();
});

test("late findings require taxonomy and Codex responses cannot close ChatGPT findings", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "finding");
  const consensus = reachConsensus(service, issue.issue_id);
  const candidateA = candidate({ consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash });
  const submittedA = service.submitCandidate(issue.issue_id, candidateA);
  service.submitChatGPTReviewDecision(issue.issue_id, reviewDecision(issue.issue_id, submittedA.active_candidate));
  service.respondFinding(issue.issue_id, { finding_id: "finding-round-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test-A"] });
  service.nextRound(issue.issue_id);
  const candidateB = candidate({ candidate_id: "candidate-2", candidate_commit: "b".repeat(40), tree: "c".repeat(40), github_run: { id: 124, head_sha: "b".repeat(40), conclusion: "success" }, artifact_id: "artifact-2", artifact_commit: "b".repeat(40), candidate_nonce: "nonce-B-1234567890-abcdef", consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash });
  service.submitCandidate(issue.issue_id, candidateB);
  assert.throws(() => service.addFinding(issue.issue_id, strictFinding("finding-2", { severity: "P1", title: "Late issue" })), /LATE_FINDING_CLASSIFICATION_REQUIRED/);
  service.addFinding(issue.issue_id, strictFinding("finding-2", { severity: "P1", title: "Late issue", late_finding_classification: "PREVIOUS_REVIEW_MISS", reason_newly_discoverable: "The second candidate exposes this path." }));
  const response = service.respondFinding(issue.issue_id, { finding_id: "finding-2", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test"] });
  assert.equal(response.findings.find((item) => item.finding_id === "finding-2").status, "OPEN");
  assert.throws(() => service.decideFinding(issue.issue_id, "finding-2", "DISPUTE_ACCEPTED", "codex"), /REVIEW_CODEX_CANNOT_SELF_CLOSE/);
  const closed = service.decideFinding(issue.issue_id, "finding-2", "DISPUTE_ACCEPTED", "chatgpt");
  assert.equal(closed.findings.find((item) => item.finding_id === "finding-2").status, "CLOSED");
  service.recordVerdict(issue.issue_id, "chatgpt", { verdict: "CHANGES_REQUIRED", binding: candidateBinding(service.requireIssue(issue.issue_id).active_candidate) });
  service.respondFinding(issue.issue_id, { finding_id: "finding-round-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test-B"] });
  const escalated = service.nextRound(issue.issue_id);
  assert.equal(escalated.current_round, 3);
  assert.equal(escalated.state, "OWNER_DECISION_REQUIRED");
  store.close();
});

test("Candidate A to B preserves immutable history, resets verdicts, and rejects stale candidate decisions", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "roundtrip");
  const consensus = reachConsensus(service, issue.issue_id);
  const candidateA = service.submitCandidate(issue.issue_id, candidate({ candidate_id: "candidate-A", consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash })).active_candidate;
  const bindingA = candidateBinding(candidateA);
  service.recordVerdict(issue.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding: bindingA });
  service.submitChatGPTReviewDecision(issue.issue_id, reviewDecision(issue.issue_id, candidateA));
  service.respondFinding(issue.issue_id, { finding_id: "finding-round-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["candidate-A-test"] });
  const oldChallenge = store.issueChallenge({ purpose: "CHATGPT_REVIEW_DECISION", issueId: issue.issue_id, candidateId: candidateA.candidate_id, candidateCommit: candidateA.candidate_commit });
  const advanced = service.startNextRound(issue.issue_id);
  assert.equal(advanced.current_round, 2);
  assert.equal(advanced.active_candidate, null);
  assert.deepEqual(advanced.verdicts, { codex: null, chatgpt: null, machine: null });
  assert.equal(advanced.candidate_history[0].status, "SUPERSEDED");
  assert.equal(advanced.stale_candidate_bindings.length, 1);
  assert.ok(store.candidateChallenges({ issueId: issue.issue_id, candidateId: candidateA.candidate_id, candidateCommit: candidateA.candidate_commit })[0].revoked_at);
  assert.throws(() => store.consumeChallenge({ challengeId: oldChallenge.challenge_id, nonce: oldChallenge.nonce, purpose: "CHATGPT_REVIEW_DECISION", issueId: issue.issue_id, candidateId: candidateA.candidate_id, candidateCommit: candidateA.candidate_commit }), /REVIEW_REPLAY_BLOCKED/);
  const candidateB = service.submitCandidate(issue.issue_id, candidate({ candidate_id: "candidate-B", candidate_commit: "b".repeat(40), tree: "c".repeat(40), github_run: { id: 125, head_sha: "b".repeat(40), conclusion: "success" }, artifact_id: "artifact-B", artifact_commit: "b".repeat(40), candidate_nonce: "nonce-B-1234567890-abcdef", consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash })).active_candidate;
  const current = service.requireIssue(issue.issue_id);
  assert.equal(current.candidate_history.length, 2);
  assert.equal(current.candidate_history[0].supersededByCandidateId, "candidate-B");
  assert.equal(current.candidate_history[1].status, "ACTIVE");
  assert.throws(() => service.submitChatGPTReviewDecision(issue.issue_id, reviewDecision(issue.issue_id, candidateA, { findings: [], verdict: "EVIDENCE_REQUIRED" })), /CURRENT_CANDIDATE_BINDING_MISMATCH/);
  assert.equal(candidateB.round, 2);
  store.close();
});

test("invalid ChatGPT aggregate decision rolls back challenge use and every projection change", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "atomic");
  const consensus = reachConsensus(service, issue.issue_id);
  const active = service.submitCandidate(issue.issue_id, candidate({ consensus_record_hash: consensus.consensus_record.contentHash, task_package_content_hash: consensus.issue_task_package.contentHash })).active_candidate;
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const bridgeToken = "bridge-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: "bus-token-1234567890-abcdefghijkl", bridgeToken, constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  try {
    const challengeResponse = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_REVIEW_DECISION", issue_id: issue.issue_id, candidate_id: active.candidate_id, candidate_commit: active.candidate_commit }) });
    const challenge = await challengeResponse.json();
    const before = service.requireIssue(issue.issue_id);
    const invalidDecision = reviewDecision(issue.issue_id, active, { findings: [{ finding_id: "finding-invalid", severity: "P0" }] });
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, purpose: "CHATGPT_REVIEW_DECISION", issue_id: issue.issue_id, candidate_id: active.candidate_id, candidate_commit: active.candidate_commit, decision: invalidDecision };
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(rejected.status, 409);
    assert.equal(service.requireIssue(issue.issue_id).entity_version, before.entity_version);
    const retry = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify({ ...body, decision: reviewDecision(issue.issue_id, active) }) });
    assert.equal(retry.status, 200);
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); store.close(); }
});

test("Chrome writeback challenge is one-time, candidate-bound, and replay protected", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "bridge");
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const busToken = "bus-token-1234567890-abcdefghijkl";
  const bridgeToken = "bridge-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken, bridgeToken, constitution });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  try {
    const challengeResponse = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(challengeResponse.status, 201);
    const challenge = await challengeResponse.json();
    const decision = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null, decision: chatgptAssessment };
    const accepted = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify(decision) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ack, true);
    const replay = await fetch(`http://127.0.0.1:${port}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify(decision) });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "REVIEW_REPLAY_BLOCKED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("Fast lane rejects core, provider, budget, and authority changes", () => {
  const { service, store } = fixture();
  const issue = createFastIssue(service, "fast", ["film-core/schema.py"]);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ candidate_id: "micro", branch: "fix/micro", changed_files: ["film-core/schema.py"], task_package_content_hash: issue.issue_task_package.contentHash })), /FAST_LANE_SCOPE_DENIED/);
  store.close();
});

test("Architecture v2 freezes Requirement and Evidence idempotently without a second domain event", () => {
  const { service, store } = fixture();
  const issue = service.createIssue({ issue_id: "FILMOS-ARCH-options", project_id: projectId, what_happened: "current structure blocks real work", expected_result: "evolvable structure", location: "project workflow", blocks_work: true, lane: "architecture" });
  const frozen = service.freezeRequirementDelta(issue.issue_id, architectureDelta, "user", new Date("2026-09-02T00:00:00.000Z"));
  const eventCount = store.events(issue.issue_id).length;
  const replay = service.freezeRequirementDelta(issue.issue_id, architectureDelta, "user", new Date("2026-09-02T00:10:00.000Z"));
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.operation_receipt.receipt_hash, frozen.operation_receipt.receipt_hash);
  assert.equal(replay.entity_version, frozen.entity_version);
  assert.equal(store.events(issue.issue_id).length, eventCount);
  assert.throws(() => service.freezeRequirementDelta(issue.issue_id, { ...architectureDelta, target_experience: "different" }), /REQUIREMENT_DELTA_FROZEN_CONFLICT/);

  const evidence = service.freezeEvidence(issue.issue_id, { source_commit: commit, items: architectureEvidence }, "codex", new Date("2026-09-02T00:20:00.000Z"));
  const evidenceEventCount = store.events(issue.issue_id).length;
  const evidenceReplay = service.freezeEvidence(issue.issue_id, { source_commit: commit, items: architectureEvidence }, "codex", new Date("2026-09-02T00:30:00.000Z"));
  assert.equal(evidenceReplay.idempotent_replay, true);
  assert.equal(evidenceReplay.operation_receipt.receipt_hash, evidence.operation_receipt.receipt_hash);
  assert.equal(evidenceReplay.entity_version, evidence.entity_version);
  assert.equal(store.events(issue.issue_id).length, evidenceEventCount);
  assert.throws(() => service.freezeEvidence(issue.issue_id, { source_commit: commit, items: [...architectureEvidence, { kind: "extra", completeness_kind: "attachment", content: "drift" }] }), /EVIDENCE_FROZEN_CONFLICT/);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("Architecture v2 Assessment receipts are sealed once, replayed exactly, and conflict without mutation", () => {
  const { service, store } = fixture();
  const issue = createPendingArchitectureAssessment(service);
  const before = service.requireIssue(issue.issue_id);
  const beforeEvents = store.events(issue.issue_id).length;
  const untouchedChatGPTSlot = structuredClone(before.assessment_slots.chatgpt);
  const first = service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T00:04:00.000Z"));
  const receipt = first.operation_receipt;
  const persisted = service.requireIssue(issue.issue_id);
  const submittedEvent = store.events(issue.issue_id).at(-1);

  assert.equal(first.idempotent_replay, false);
  assert.equal(first.entity_version, before.entity_version + 1);
  assert.equal(store.events(issue.issue_id).length, beforeEvents + 1);
  assert.equal(Object.keys(persisted.assessments).length, Object.keys(before.assessments).length + 1);
  assert.deepEqual(persisted.assessment_slots.chatgpt, untouchedChatGPTSlot);
  assert.equal(receipt.schema_version, "filmos.architecture-assessment-receipt.v2");
  assert.match(receipt.assessment_id, /^architecture-assessment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(receipt.project_id, issue.project_id);
  assert.equal(receipt.issue_id, issue.issue_id);
  assert.equal(receipt.submission_id, issue.submission_id);
  assert.equal(receipt.actor, "codex");
  assert.equal(receipt.assessor, "codex");
  assert.equal(receipt.assessment_round, 1);
  assert.equal(receipt.event_id, submittedEvent.event_id);
  assert.deepEqual(submittedEvent.payload.receipt, receipt);
  assert.deepEqual(persisted.assessment_receipts.codex, receipt);
  assert.equal(persisted.assessments.codex.assessment_id, receipt.assessment_id);
  assert.equal(persisted.assessments.codex.event_id, receipt.event_id);
  assert.equal(persisted.assessments.codex.content_hash, receipt.assessment_content_hash);
  assert.deepEqual(persisted.assessment_slots.codex, {
    status: "SEALED",
    binding_hash: receipt.binding_hash,
    assessment_id: receipt.assessment_id,
    assessment_content_hash: receipt.assessment_content_hash,
    receipt_hash: receipt.receipt_hash,
    event_id: receipt.event_id,
  });
  assert.equal(receipt.assessment_content_hash, sha256({
    schema_version: "filmos.architecture-assessment.v2",
    project_id: issue.project_id,
    issue_id: issue.issue_id,
    submission_id: issue.submission_id,
    actor: "codex",
    assessment_round: 1,
    binding_hash: receipt.binding_hash,
    assessment: codexAssessment,
  }));
  const { receipt_hash: receiptHash, ...receiptBase } = receipt;
  assert.equal(receiptHash, sha256(receiptBase));

  const replayVersion = persisted.entity_version;
  const replayEvents = store.events(issue.issue_id).length;
  const replay = service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T00:05:00.000Z"));
  assert.equal(replay.idempotent_replay, true);
  assert.deepEqual(replay.operation_receipt, receipt);
  assert.equal(replay.entity_version, replayVersion);
  assert.equal(store.events(issue.issue_id).length, replayEvents);

  const beforeConflict = service.requireIssue(issue.issue_id);
  const beforeConflictEvents = store.events(issue.issue_id);
  assert.throws(
    () => service.submitAssessment(issue.issue_id, "codex", { ...codexAssessment, root_cause: "different content" }),
    (error) => error.code === "ASSESSMENT_FROZEN_CONFLICT" && error.status === 409,
  );
  assert.deepEqual(service.requireIssue(issue.issue_id), beforeConflict);
  assert.deepEqual(store.events(issue.issue_id), beforeConflictEvents);

  const beforePairVersion = beforeConflict.entity_version;
  const beforePairEvents = beforeConflictEvents.length;
  const paired = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment, new Date("2026-09-04T00:06:00.000Z"));
  assert.equal(paired.idempotent_replay, false);
  assert.equal(paired.state, "OPTION_COMPARISON");
  assert.equal(paired.entity_version, beforePairVersion + 1);
  assert.equal(store.events(issue.issue_id).length, beforePairEvents + 1);
  assert.equal(paired.operation_receipt.actor, "chatgpt");
  assert.equal(paired.operation_receipt.event_id, store.events(issue.issue_id).at(-1).event_id);
  const replayAfterPair = service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T00:07:00.000Z"));
  assert.equal(replayAfterPair.idempotent_replay, true);
  assert.deepEqual(replayAfterPair.operation_receipt, receipt);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("Architecture v2 recovers a lost first Assessment response from the persisted receipt", () => {
  const { service, store } = fixture();
  const issue = createPendingArchitectureAssessment(service, "56565656-5656-4565-8565-565656565656");
  service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T01:00:00.000Z"));
  const persisted = service.requireIssue(issue.issue_id);
  const originalReceipt = structuredClone(persisted.assessment_receipts.codex);
  const eventCount = store.events(issue.issue_id).length;
  const recovered = service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T01:01:00.000Z"));
  assert.equal(recovered.idempotent_replay, true);
  assert.deepEqual(recovered.operation_receipt, originalReceipt);
  assert.equal(recovered.entity_version, persisted.entity_version);
  assert.equal(store.events(issue.issue_id).length, eventCount);
  store.close();
});

test("Architecture v2 replays the original Assessment receipt after Review Bus restart", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-assessment-restart-"));
  const databasePath = resolve(directory, "review-bus.sqlite");
  let store = new ReviewBusStore(databasePath);
  try {
    let service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
    const issue = createPendingArchitectureAssessment(service, "57575757-5757-4575-8575-575757575757");
    const first = service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T02:00:00.000Z"));
    const originalReceipt = structuredClone(first.operation_receipt);
    store.close();

    store = new ReviewBusStore(databasePath);
    service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
    const beforeReplay = service.requireIssue(issue.issue_id);
    const eventCount = store.events(issue.issue_id).length;
    const replay = service.submitAssessment(issue.issue_id, "codex", codexAssessment, new Date("2026-09-04T02:01:00.000Z"));
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(replay.operation_receipt, originalReceipt);
    assert.equal(replay.entity_version, beforeReplay.entity_version);
    assert.equal(store.events(issue.issue_id).length, eventCount);
    assert.equal(store.verifyEventChain(issue.issue_id), true);
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Architecture v2 serializes identical Assessment submissions across independent processes", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-assessment-concurrency-"));
  const databasePath = resolve(directory, "review-bus.sqlite");
  const store = new ReviewBusStore(databasePath);
  try {
    const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
    const issue = createPendingArchitectureAssessment(service, "58585858-5858-4585-8585-585858585858");
    const before = service.requireIssue(issue.issue_id);
    const beforeEvents = store.events(issue.issue_id).length;
    const input = {
      mode: "assessment",
      databasePath,
      storeModule: new URL("../src/store.mjs", import.meta.url).href,
      serviceModule: new URL("../src/service.mjs", import.meta.url).href,
      issueId: issue.issue_id,
      actor: "codex",
      assessment: codexAssessment,
      baseCommit: commit,
      taskPackageContentHash: taskHash,
      now: "2026-09-04T03:00:00.000Z",
      startAt: Date.now() + 250,
    };
    const workerPath = fileURLToPath(new URL("./append-worker.mjs", import.meta.url));
    const results = await Promise.all([
      runAssessmentChild(workerPath, input),
      runAssessmentChild(workerPath, input),
    ]);
    assert.deepEqual(results[0].operation_receipt, results[1].operation_receipt);
    assert.equal(results.filter((result) => result.idempotent_replay === false).length, 1);
    assert.equal(results.filter((result) => result.idempotent_replay === true).length, 1);
    const persisted = service.requireIssue(issue.issue_id);
    assert.equal(persisted.entity_version, before.entity_version + 1);
    assert.equal(store.events(issue.issue_id).length, beforeEvents + 1);
    assert.equal(Object.keys(persisted.assessments).length, 1);
    assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "assessment.codex.submitted").length, 1);
    assert.equal(persisted.assessment_slots.codex.assessment_id, results[0].operation_receipt.assessment_id);
    assert.equal(store.verifyEventChain(issue.issue_id), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Architecture v2 Assessment HTTP response exposes the persisted receipt and enforces scope", async () => {
  const { service, store } = fixture();
  const issue = createPendingArchitectureAssessment(service, "59595959-5959-4595-8595-595959595959");
  bindTestSubmission(store, issue);
  const { server, baseURL, headers } = await startReviewServer(service, store);
  const endpoint = `${baseURL}/v1/issues/${issue.issue_id}/assessments/codex?project_id=${issue.project_id}&submission_id=${issue.submission_id}`;
  try {
    const before = service.requireIssue(issue.issue_id);
    const beforeEvents = store.events(issue.issue_id).length;
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(codexAssessment) });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const field of ["project_id", "issue_id", "submission_id", "actor", "assessment_id", "assessment_content_hash", "assessment_receipt", "event_id"]) {
      assert.equal(Object.hasOwn(body, field), true, field);
    }
    assert.equal(body.project_id, issue.project_id);
    assert.equal(body.issue_id, issue.issue_id);
    assert.equal(body.submission_id, issue.submission_id);
    assert.equal(body.actor, "codex");
    assert.deepEqual(body.assessment_receipt, body.operation_receipt);
    const persisted = service.requireIssue(issue.issue_id);
    assert.deepEqual(body.assessment_receipt, persisted.assessment_receipts.codex);
    assert.equal(body.event_id, store.events(issue.issue_id).at(-1).event_id);
    assert.equal(body.assessment_content_hash, sha256({
      schema_version: "filmos.architecture-assessment.v2",
      project_id: issue.project_id,
      issue_id: issue.issue_id,
      submission_id: issue.submission_id,
      actor: "codex",
      assessment_round: 1,
      binding_hash: body.assessment_receipt.binding_hash,
      assessment: codexAssessment,
    }));
    assert.equal(persisted.entity_version, before.entity_version + 1);
    assert.equal(store.events(issue.issue_id).length, beforeEvents + 1);

    const replayVersion = persisted.entity_version;
    const replayEvents = store.events(issue.issue_id).length;
    const replayResponse = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(codexAssessment) });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(replay.assessment_receipt, body.assessment_receipt);
    assert.equal(service.requireIssue(issue.issue_id).entity_version, replayVersion);
    assert.equal(store.events(issue.issue_id).length, replayEvents);

    const conflictResponse = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...codexAssessment, rollback: ["different"] }) });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, "ASSESSMENT_FROZEN_CONFLICT");
    assert.equal(service.requireIssue(issue.issue_id).entity_version, replayVersion);
    assert.equal(store.events(issue.issue_id).length, replayEvents);

    const otherProjectId = "22222222-2222-4222-8222-222222222222";
    const deniedResponse = await fetch(`${baseURL}/v1/issues/${issue.issue_id}/assessments/codex?project_id=${otherProjectId}&submission_id=${issue.submission_id}`, { method: "POST", headers, body: JSON.stringify(codexAssessment) });
    assert.equal(deniedResponse.status, 403);
    const denied = await deniedResponse.json();
    assert.deepEqual(denied, { status: 403, code: "PROJECT_SCOPE_DENIED", message: "PROJECT_SCOPE_DENIED", retryable: false });

    const mismatchedSubmission = await fetch(`${baseURL}/v1/issues/${issue.issue_id}/assessments/codex?project_id=${issue.project_id}&submission_id=FILMOS-SUBMISSION-60606060-6060-4606-8606-606060606060`, { method: "POST", headers, body: JSON.stringify(codexAssessment) });
    assert.equal(mismatchedSubmission.status, 409);
    assert.equal((await mismatchedSubmission.json()).code, "SUBMISSION_BINDING_MISMATCH");

    const missingIssue = await fetch(`${baseURL}/v1/issues/FILMOS-ARCH-61616161-6161-4616-8616-616161616161/assessments/codex?project_id=${issue.project_id}&submission_id=${issue.submission_id}`, { method: "POST", headers, body: JSON.stringify(codexAssessment) });
    assert.equal(missingIssue.status, 404);
    assert.equal((await missingIssue.json()).code, "ISSUE_NOT_FOUND");
    assert.equal(store.verifyEventChain(issue.issue_id), true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
  }
});

test("Architecture v2 ChatGPT Bridge returns and replays the same persisted Assessment receipt", async () => {
  const { service, store } = fixture();
  const issue = createPendingArchitectureAssessment(service, "62626262-6262-4626-8626-626262626262");
  bindTestSubmission(store, issue);
  const { server, baseURL } = await startReviewServer(service, store);
  const headers = { authorization: "Bearer bridge-token-1234567890-abcdefghijkl", "content-type": "application/json", "x-filmos-user-gesture": "1" };
  const decisionURL = `${baseURL}/v1/bridge/decision?project_id=${issue.project_id}&submission_id=${issue.submission_id}`;
  const issueChallenge = async () => {
    const response = await fetch(`${baseURL}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const writeDecision = (challenge, assessment) => fetch(decisionURL, { method: "POST", headers, body: JSON.stringify({
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    purpose: "CHATGPT_ASSESSMENT",
    issue_id: issue.issue_id,
    candidate_id: null,
    candidate_commit: null,
    decision: assessment,
  }) });
  try {
    const firstResponse = await writeDecision(await issueChallenge(), chatgptAssessment);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.ack, true);
    for (const field of ["project_id", "issue_id", "submission_id", "actor", "assessment_id", "assessment_content_hash", "assessment_receipt", "event_id"]) {
      assert.equal(Object.hasOwn(first, field), true, field);
    }
    assert.equal(first.actor, "chatgpt");
    assert.deepEqual(first.assessment_receipt, service.requireIssue(issue.issue_id).assessment_receipts.chatgpt);
    assert.equal(first.event_id, store.events(issue.issue_id).at(-1).event_id);
    const version = service.requireIssue(issue.issue_id).entity_version;
    const eventCount = store.events(issue.issue_id).length;

    const replayResponse = await writeDecision(await issueChallenge(), chatgptAssessment);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(replay.assessment_receipt, first.assessment_receipt);
    assert.equal(service.requireIssue(issue.issue_id).entity_version, version);
    assert.equal(store.events(issue.issue_id).length, eventCount);

    const conflictResponse = await writeDecision(await issueChallenge(), { ...chatgptAssessment, workflow_impact: "different" });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, "ASSESSMENT_FROZEN_CONFLICT");
    assert.equal(service.requireIssue(issue.issue_id).entity_version, version);
    assert.equal(store.events(issue.issue_id).length, eventCount);
    assert.equal(store.verifyEventChain(issue.issue_id), true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
  }
});

test("pre-repair Architecture Assessment receipts remain immutable without history rewrite", () => {
  const { service, store } = fixture();
  const issue = createPendingArchitectureAssessment(service, "63636363-6363-4636-8636-636363636363");
  const current = service.requireIssue(issue.issue_id);
  const binding = {
    project_id: current.project_id,
    evidence_manifest_hash: current.evidence.manifest.contentHash,
    constitution_content_hash: current.constitution_content_hash,
  };
  const bindingHash = sha256(binding);
  const submittedAt = "2026-09-04T04:00:00.000Z";
  const sealedBase = {
    assessment: codexAssessment,
    assessor: "codex",
    assessment_round: 1,
    project_id: current.project_id,
    binding,
    binding_hash: bindingHash,
    submitted_at: submittedAt,
  };
  const sealed = { ...sealedBase, content_hash: sha256(sealedBase), sealed_until_pair_complete: true };
  const receiptBase = {
    schema_version: "filmos.architecture-assessment-receipt.v2",
    issue_id: current.issue_id,
    assessor: "codex",
    assessment_round: 1,
    binding_hash: bindingHash,
    assessment_content_hash: sealed.content_hash,
    accepted_at: submittedAt,
  };
  const legacyReceipt = { ...receiptBase, receipt_hash: sha256(receiptBase) };
  store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: "assessment.codex.submitted",
    actor: "codex",
    payload: { receipt: legacyReceipt },
    now: new Date(submittedAt),
    transitionAction: "assessment.submit",
    mutate: (next) => {
      next.assessments.codex = sealed;
      next.assessment_receipts.codex = legacyReceipt;
      next.assessment_slots.codex = { status: "SEALED", binding_hash: bindingHash, receipt_hash: legacyReceipt.receipt_hash };
      return next;
    },
  });
  const eventRows = store.db.prepare("SELECT * FROM review_events WHERE issue_id = ? ORDER BY sequence").all(issue.issue_id);
  const projectionRow = store.db.prepare("SELECT * FROM review_projections WHERE issue_id = ?").get(issue.issue_id);
  assert.throws(() => service.submitAssessment(issue.issue_id, "codex", codexAssessment), /ASSESSMENT_IMMUTABLE/);
  assert.deepEqual(store.db.prepare("SELECT * FROM review_events WHERE issue_id = ? ORDER BY sequence").all(issue.issue_id), eventRows);
  assert.deepEqual(store.db.prepare("SELECT * FROM review_projections WHERE issue_id = ?").get(issue.issue_id), projectionRow);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("Architecture v2 seals blind Assessments and only the Owner can accept one frozen A/B/C option", () => {
  const { service, store } = fixture();
  const issue = service.createIssue({ issue_id: "FILMOS-ARCH-owner-gate", project_id: projectId, what_happened: "current structure blocks real work", expected_result: "evolvable structure", location: "project workflow", blocks_work: true, lane: "architecture" });
  service.freezeRequirementDelta(issue.issue_id, architectureDelta);
  service.freezeEvidence(issue.issue_id, { source_commit: commit, items: architectureEvidence });
  service.beginArchitectureAssessments(issue.issue_id);
  service.submitAssessment(issue.issue_id, "codex", codexAssessment);
  const blind = service.assessmentBlind(issue.issue_id, "chatgpt");
  assert.equal(blind.counterpart_assessment, null);
  assert.equal(blind.counterpart_sealed, true);
  const paired = service.submitAssessment(issue.issue_id, "chatgpt", chatgptAssessment);
  assert.equal(paired.state, "OPTION_COMPARISON");
  assert.equal(service.assessmentBlind(issue.issue_id, "chatgpt").pair_complete, true);
  assert.throws(() => service.setArchitectureOptions(issue.issue_id, architectureOptions.slice(0, 2)), /ARCHITECTURE_OPTIONS_A_B_C_REQUIRED/);
  const ownerGate = service.setArchitectureOptions(issue.issue_id, architectureOptions);
  assert.equal(ownerGate.state, "OWNER_DECISION_REQUIRED");
  const optionsEvents = store.events(issue.issue_id).length;
  const optionsReplay = service.setArchitectureOptions(issue.issue_id, architectureOptions);
  assert.equal(optionsReplay.idempotent_replay, true);
  assert.equal(store.events(issue.issue_id).length, optionsEvents);
  const selected = ownerGate.architecture_options.options.find((item) => item.option === "B");
  assert.throws(() => service.acceptArchitectureOption(issue.issue_id, { option: "B", option_content_hash: selected.content_hash, user_authorized: true }, "codex"), /OWNER_AUTHORIZATION_REQUIRED/);
  assert.throws(() => service.acceptArchitectureOption(issue.issue_id, { option: "B", option_content_hash: "0".repeat(64), user_authorized: true }), /ARCHITECTURE_OPTION_HASH_MISMATCH/);
  const accepted = service.acceptArchitectureOption(issue.issue_id, { option: "B", option_content_hash: selected.content_hash, user_authorized: true });
  assert.equal(accepted.state, "ARCHITECTURE_OPTION_ACCEPTED");
  const acceptEventCount = store.events(issue.issue_id).length;
  const acceptReplay = service.acceptArchitectureOption(issue.issue_id, { option: "B", option_content_hash: selected.content_hash, user_authorized: true });
  assert.equal(acceptReplay.idempotent_replay, true);
  assert.equal(store.events(issue.issue_id).length, acceptEventCount);
  for (const event of store.events(issue.issue_id)) {
    assert.equal(typeof event.payload.transition?.transition_contract_hash, "string");
    assert.match(event.payload.transition?.post_projection_hash ?? "", /^[0-9a-f]{64}$/);
  }
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("Architecture v2 separates Consensus, Task Package, implementation, Candidate, and three bound Verdict axes", () => {
  const { service, store } = fixture();
  const accepted = createAcceptedArchitecture(service, "review-chain");
  const proposed = service.proposeArchitectureConsensus(accepted.issue_id);
  assert.equal(proposed.state, "CONSENSUS_PROPOSED");
  const proposalHash = proposed.consensus_proposal.content_hash;
  const oneVote = service.respondConsensus(accepted.issue_id, "codex", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
  assert.equal(oneVote.state, "CONSENSUS_PROPOSED");
  const reached = service.respondConsensus(accepted.issue_id, "chatgpt", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
  assert.equal(reached.state, "CONSENSUS_REACHED");
  assert.equal(reached.issue_task_package, null);

  const frozen = service.freezeArchitectureTaskPackage(accepted.issue_id, architectureTaskInput);
  assert.equal(frozen.state, "TASK_PACKAGE_FROZEN");
  assert.equal(frozen.issue_task_package.consensus_record_hash, reached.consensus_record.contentHash);
  const taskEventCount = store.events(accepted.issue_id).length;
  const taskReplay = service.freezeArchitectureTaskPackage(accepted.issue_id, architectureTaskInput);
  assert.equal(taskReplay.idempotent_replay, true);
  assert.equal(taskReplay.operation_receipt.receipt_hash, frozen.operation_receipt.receipt_hash);
  assert.equal(store.events(accepted.issue_id).length, taskEventCount);
  const implementing = service.startArchitectureImplementation(accepted.issue_id);
  assert.equal(implementing.state, "CODEX_IMPLEMENTING");

  const candidateValue = candidate({
    task_package_content_hash: implementing.task_package_content_hash,
    consensus_record_hash: implementing.consensus_record.contentHash,
    architecture_binding_hash: architectureCandidateBindingHash(implementing),
  });
  assert.throws(() => service.submitCandidate(accepted.issue_id, { ...candidateValue, architecture_binding_hash: "0".repeat(64) }), /ARCHITECTURE_CANDIDATE_BINDING_MISMATCH/);
  const submitted = service.submitCandidate(accepted.issue_id, candidateValue);
  assert.equal(submitted.state, "CANDIDATE_UNDER_REVIEW");
  const binding = candidateBinding(submitted.active_candidate);
  assert.equal(service.recordVerdict(accepted.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding }).state, "CANDIDATE_UNDER_REVIEW");
  assert.equal(service.recordVerdict(accepted.issue_id, "chatgpt", { verdict: "EXTERNAL_APPROVED", binding }).state, "CANDIDATE_UNDER_REVIEW");
  const approved = service.recordVerdict(accepted.issue_id, "machine", { verdict: "PASS", binding });
  assert.equal(approved.state, "DUAL_APPROVED");
  assert.equal(approved.next_pilot_allowed, true);
  assert.equal(store.events(accepted.issue_id).filter((event) => event.event_type === "candidate.approved").length, 1);
  assert.equal(store.verifyEventChain(accepted.issue_id), true);
  store.close();
});

test("Architecture v2 returns requested Consensus changes to Option Comparison without overwriting frozen history", () => {
  const { service, store } = fixture();
  const accepted = createAcceptedArchitecture(service, "consensus-revision");
  const proposed = service.proposeArchitectureConsensus(accepted.issue_id);
  const proposalHash = proposed.consensus_proposal.content_hash;
  service.respondConsensus(accepted.issue_id, "codex", { proposal_content_hash: proposalHash, position: "ACCEPTED", requested_changes: [] });
  const revised = service.respondConsensus(accepted.issue_id, "chatgpt", { proposal_content_hash: proposalHash, position: "CHANGES_REQUESTED", requested_changes: ["narrow host boundary"] });
  assert.equal(revised.state, "OPTION_COMPARISON");
  assert.equal(revised.architecture_round_history.length, 1);
  assert.equal(revised.freeze_receipt_history.length, 1);
  assert.equal(revised.architecture_options, null);
  assert.equal(revised.accepted_architecture_option, null);
  const refrozen = service.setArchitectureOptions(accepted.issue_id, architectureOptions.map((item) => ({ ...item, revision: 2 })));
  assert.equal(refrozen.state, "OWNER_DECISION_REQUIRED");
  assert.notEqual(refrozen.operation_receipt.receipt_hash, accepted.freeze_receipts.architecture_options.receipt_hash);
  assert.equal(store.verifyEventChain(accepted.issue_id), true);
  store.close();
});

test("Architecture v2 supersedes Candidate A before Candidate B and rejects every stale Verdict binding", () => {
  const { service, store } = fixture();
  const accepted = createAcceptedArchitecture(service, "candidate-a-b");
  const proposed = service.proposeArchitectureConsensus(accepted.issue_id);
  service.respondConsensus(accepted.issue_id, "codex", { proposal_content_hash: proposed.consensus_proposal.content_hash, position: "ACCEPTED", requested_changes: [] });
  service.respondConsensus(accepted.issue_id, "chatgpt", { proposal_content_hash: proposed.consensus_proposal.content_hash, position: "ACCEPTED", requested_changes: [] });
  service.freezeArchitectureTaskPackage(accepted.issue_id, architectureTaskInput);
  const implementing = service.startArchitectureImplementation(accepted.issue_id);
  const architectureBindingHash = architectureCandidateBindingHash(implementing);
  const candidateA = service.submitCandidate(accepted.issue_id, candidate({
    candidate_id: "architecture-candidate-A",
    task_package_content_hash: implementing.task_package_content_hash,
    consensus_record_hash: implementing.consensus_record.contentHash,
    architecture_binding_hash: architectureBindingHash,
  }));
  const bindingA = candidateBinding(candidateA.active_candidate);
  service.addFinding(accepted.issue_id, strictFinding("finding-architecture-A"));
  service.respondFinding(accepted.issue_id, { finding_id: "finding-architecture-A", disposition: "FIXED_WITH_EVIDENCE", evidence: ["candidate B will contain the fix"] });
  service.recordVerdict(accepted.issue_id, "chatgpt", { verdict: "CHANGES_REQUIRED", binding: bindingA });
  const fixing = service.startNextRound(accepted.issue_id);
  assert.equal(fixing.state, "CODEX_IMPLEMENTING");
  assert.equal(fixing.active_candidate, null);
  assert.equal(fixing.candidate_history[0].status, "SUPERSEDED");
  assert.equal(fixing.stale_candidate_bindings.length, 1);

  const candidateBValue = candidate({
    candidate_id: "architecture-candidate-B",
    candidate_commit: "b".repeat(40),
    tree: "c".repeat(40),
    branch: "fix/architecture-b",
    github_run: { id: 124, head_sha: "b".repeat(40), conclusion: "success" },
    artifact_id: "artifact-B",
    artifact_commit: "b".repeat(40),
    candidate_nonce: "nonce-B-1234567890-abcdef",
    task_package_content_hash: fixing.task_package_content_hash,
    consensus_record_hash: fixing.consensus_record.contentHash,
    architecture_binding_hash: architectureCandidateBindingHash(fixing),
  });
  const candidateB = service.submitCandidate(accepted.issue_id, candidateBValue);
  assert.equal(candidateB.candidate_history.length, 2);
  assert.equal(candidateB.candidate_history[0].supersededByCandidateId, "architecture-candidate-B");
  assert.throws(() => service.recordVerdict(accepted.issue_id, "codex", { verdict: "LOCAL_ACCEPTED", binding: bindingA }), /CURRENT_CANDIDATE_BINDING_MISMATCH/);
  assert.equal(store.events(accepted.issue_id).filter((event) => event.event_type === "candidate.supersede").length, 1);
  assert.equal(store.verifyEventChain(accepted.issue_id), true);
  store.close();
});

test("candidate binding fails closed on wrong GitHub commit, artifact commit, or task hash", () => {
  const { service, store } = fixture();
  const issue = createFastIssue(service, "binding", ["web/agent.tsx"]);
  const dynamicHash = issue.issue_task_package.contentHash;
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: dynamicHash, github_run: { id: 1, head_sha: "0".repeat(40), conclusion: "success" } })), /GITHUB_RUN_COMMIT_MISMATCH/);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: dynamicHash, artifact_commit: "0".repeat(40) })), /ARTIFACT_COMMIT_MISMATCH/);
  assert.throws(() => service.submitCandidate(issue.issue_id, candidate({ task_package_content_hash: "0".repeat(64) })), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("read-only artifact projection exposes the immutable artifact binding", async () => {
  const { service, store } = fixture();
  const issue = createFastIssue(service, "artifact", ["web/copy.ts"]);
  service.submitCandidate(issue.issue_id, candidate({ candidate_id: "artifact-candidate", branch: "fix/copy", changed_files: ["web/copy.ts"], task_package_content_hash: issue.issue_task_package.contentHash }));
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const token = "bus-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: token, bridgeToken: "bridge-token-1234567890-abcdefghijkl", constitution });
  server.listen(0, "127.0.0.1");
  await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/review/issues/${issue.issue_id}/artifact?project_id=${projectId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.deepEqual(receipt.artifact, { artifact_id: "artifact-1", artifact_digest: `sha256:${"f".repeat(64)}`, artifact_commit: "d".repeat(40) });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
  }
});

test("Review Bus rejects an absent or drifting task-package binding at construction", () => {
  const store = new ReviewBusStore(":memory:");
  assert.throws(() => new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: "0".repeat(64) }), /TASK_PACKAGE_HASH_MISMATCH/);
  store.close();
});

test("Issue IDs are canonical across App, MCP, and Chrome contracts", () => {
  const { service, store } = fixture();
  assert.throws(() => service.createIssue({ issue_id: "ISSUE-wrong", project_id: projectId, what_happened: "x", expected_result: "y", location: "z", blocks_work: false, lane: "fast" }), /INVALID_ISSUE_ID/);
  const normal = service.createIssue({ project_id: projectId, what_happened: "x", expected_result: "y", location: "z", blocks_work: false, lane: "fast" });
  const architecture = service.createIssue({ project_id: projectId, what_happened: "x", expected_result: "y", location: "z", blocks_work: false, lane: "architecture" });
  assert.match(normal.issue_id, /^FILMOS-ISSUE-/);
  assert.match(architecture.issue_id, /^FILMOS-ARCH-/);
  store.close();
});

test("append locks before projection read so two database connections preserve one chain and monotonic versions", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-review-concurrency-"));
  const databasePath = resolve(directory, "review-bus.sqlite");
  const store = new ReviewBusStore(databasePath);
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  const issue = service.createIssue({ issue_id: "FILMOS-ISSUE-concurrent", project_id: projectId, what_happened: "probe", expected_result: "serialized", location: "review bus", blocks_work: false, lane: "fast" });
  const workerPath = new URL("./append-worker.mjs", import.meta.url);
  const storeModule = new URL("../src/store.mjs", import.meta.url).href;
  const run = (actor) => new Promise((resolvePromise, reject) => {
    const worker = new Worker(workerPath, { workerData: { storeModule, databasePath, issueId: issue.issue_id, actor } });
    worker.once("message", (message) => message.ok ? resolvePromise(message) : reject(new Error(message.error)));
    worker.once("error", reject);
  });
  await Promise.all([run("worker-a"), run("worker-b")]);
  const projection = store.get(issue.issue_id);
  assert.equal(projection.entity_version, 3);
  assert.deepEqual(new Set(projection.concurrency_probes), new Set(["worker-a", "worker-b"]));
  assert.equal(store.events(issue.issue_id).length, 3);
  assert.equal(store.verifyEventChain(issue.issue_id), true);
  store.close();
});

test("redaction covers macOS paths with spaces, /var/folders, and Windows user paths", () => {
  const redacted = JSON.stringify(redactEvidence({
    mac: "/Users/apple/Library/Application Support/FilmOS Studio/review-bus/log.json",
    temp: "/var/folders/sw/abc/T/private capture.png",
    windows: "C:\\Users\\Alice Smith\\AppData\\Local\\FilmOS\\secret.log",
  }));
  assert.equal(redacted.includes("Application Support"), false);
  assert.equal(redacted.includes("/var/folders"), false);
  assert.equal(redacted.includes("Alice Smith"), false);
  assert.equal((redacted.match(/LOCAL_PATH/g) ?? []).length, 3);
});

test("loopback origins with ports are accepted while remote and deceptive origins are rejected", () => {
  assert.equal(allowedOrigin("http://127.0.0.1:43100"), true);
  assert.equal(allowedOrigin("http://localhost:43100"), true);
  assert.equal(allowedOrigin("http://[::1]:43100"), true);
  assert.equal(allowedOrigin("https://127.0.0.1:43100"), false);
  assert.equal(allowedOrigin("http://127.0.0.1.evil.example:43100"), false);
  assert.equal(allowedOrigin("https://evil.example"), false);
});

test("assessment-seal prerequisites fail closed without creating database, evidence, or token files", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-seal-prerequisite-"));
  const databasePath = resolve(directory, "missing", "review-bus.sqlite");
  const tokenPath = resolve(directory, "missing", "review-bus.token");
  try {
    assert.throws(
      () => new ReviewBusStore(databasePath, { runtimeMode: "unsupported" }),
      (error) => error.code === "INVALID_REVIEW_BUS_RUNTIME_MODE",
    );
    assert.throws(
      () => startFromEnvironment({ FILMOS_REVIEW_BUS_RUNTIME_MODE: "unsupported", FILMOS_REVIEW_BUS_LOCAL_DIR: dirname(databasePath) }),
      (error) => error.code === "INVALID_REVIEW_BUS_RUNTIME_MODE",
    );
    assert.equal(existsSync(dirname(databasePath)), false);
    assert.throws(
      () => new ReviewBusStore(databasePath, {
        runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
        sealBinding: {},
        sealTarget: {},
      }),
      (error) => ["SEAL_RUNTIME_TARGET_REQUIRED", "SEAL_RUNTIME_DATABASE_REQUIRED"].includes(error.code),
    );
    assert.equal(existsSync(databasePath), false);
    assert.throws(() => readExistingSealToken(tokenPath), (error) => error.code === "SEAL_RUNTIME_TOKEN_REQUIRED");
    assert.equal(existsSync(tokenPath), false);
    assert.throws(() => readExistingSealToken(tokenPath, "short"), (error) => error.code === "SEAL_RUNTIME_TOKEN_REQUIRED");
    assert.equal(readExistingSealToken(tokenPath, "explicit-seal-token-1234567890-abcdef"), "explicit-seal-token-1234567890-abcdef");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("assessment-seal source identity is independently bound to canonical Git and recomputed fingerprint", () => {
  const value = sealSourceIdentityFixture();
  try {
    const identity = loadSealSourceIdentity(value.env, { expectedSourceRoot: value.repository });
    assert.equal(identity.source_root, value.repository);
    assert.equal(identity.branch, "integration");
    assert.equal(identity.commit, value.fingerprint.git_commit_sha);
    assert.equal(identity.tree, value.fingerprint.git_tree_sha);
    assert.equal(identity.source_fingerprint_sha256, value.fingerprint.source_fingerprint_sha256);
    assert.equal(identity.source_clean, true);

    const trackedPath = resolve(value.repository, "services/filmos-review-bus/source.txt");
    writeFileSync(trackedPath, "spoofed but mutually consistent documents\n");
    assert.throws(
      () => loadSealSourceIdentity(value.env, { expectedSourceRoot: value.repository }),
      (error) => error.code === "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH",
    );
    writeFileSync(trackedPath, "seal source\n");

    const alias = resolve(value.directory, "repository-alias");
    symlinkSync(value.repository, alias);
    assert.throws(
      () => loadSealSourceIdentity({ ...value.env, FILMOS_REVIEW_SEAL_SOURCE_ROOT: alias }, { expectedSourceRoot: value.repository }),
      (error) => error.code === "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH",
    );
    assert.throws(
      () => loadSealSourceIdentity(value.env, { expectedSourceRoot: value.directory }),
      (error) => error.code === "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH",
    );
    const alternateResources = resolve(value.directory, "alternate-resources");
    mkdirSync(alternateResources, { recursive: true });
    const alternateSourcePath = resolve(alternateResources, "SourceIdentity.json");
    const alternateRuntimePath = resolve(alternateResources, "InternalRuntime.json");
    const alternateLocatorPath = resolve(alternateResources, "DeveloperRepository.json");
    copyFileSync(value.env.FILMOS_INSTALLED_SOURCE_IDENTITY_PATH, alternateSourcePath);
    copyFileSync(value.env.FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH, alternateRuntimePath);
    copyFileSync(value.env.FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR, alternateLocatorPath);
    assert.throws(
      () => loadSealSourceIdentity({
        ...value.env,
        FILMOS_INSTALLED_SOURCE_IDENTITY_PATH: alternateSourcePath,
        FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH: alternateRuntimePath,
        FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR: alternateLocatorPath,
      }, { expectedSourceRoot: value.repository }),
      (error) => error.code === "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH",
    );
    assert.throws(
      () => loadSealSourceIdentity({}, { expectedSourceRoot: value.repository }),
      (error) => error.code === "SEAL_RUNTIME_SOURCE_IDENTITY_REQUIRED",
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("assessment-seal real environment startup assembles the isolated runtime without Production defaults or startup writes", async () => {
  const value = assessmentSealFixture("84848484-8484-4848-8848-848484848484");
  const source = sealSourceIdentityFixture();
  const { env, options } = assessmentSealRuntimeInputs(value, source);
  const busTokenPath = resolve(value.directory, "review-bus.token");
  const bridgeTokenPath = resolve(value.directory, "review-bridge.token");
  const busToken = "environment-bus-token-1234567890-abcdef";
  const bridgeToken = "environment-bridge-token-1234567890-abcdef";
  const beforeIssue = value.normalService.requireIssue(value.target.issueId);
  const beforeEvents = value.normalStore.events(value.target.issueId);
  const beforeMain = createHash("sha256").update(readFileSync(value.databasePath)).digest("hex");
  const beforeWal = createHash("sha256").update(readFileSync(`${value.databasePath}-wal`)).digest("hex");
  let running = null;
  try {
    assert.throws(
      () => startFromEnvironment(env),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );
    assert.throws(
      () => startFromEnvironment(env, options),
      (error) => error.code === "SEAL_RUNTIME_TOKEN_REQUIRED",
    );
    assert.equal(existsSync(busTokenPath), false);
    assert.equal(existsSync(bridgeTokenPath), false);

    writeFileSync(busTokenPath, `${busToken}\n`, { mode: 0o600 });
    writeFileSync(bridgeTokenPath, `${bridgeToken}\n`, { mode: 0o600 });
    assert.throws(
      () => startFromEnvironment({ ...env, FILMOS_REVIEW_SEAL_SOURCE_FINGERPRINT_SHA256: "0".repeat(64) }, options),
      (error) => error.code === "SEAL_RUNTIME_SOURCE_IDENTITY_MISMATCH",
    );
    assert.throws(
      () => startFromEnvironment({ ...env, FILMOS_REVIEW_SEAL_DATABASE_SHA256: "0".repeat(64) }, options),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );

    running = startFromEnvironment(env, options);
    await new Promise((resolvePromise, reject) => {
      running.server.once("listening", resolvePromise);
      running.server.once("error", reject);
    });
    assert.equal(running.runtimeMode, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL);
    assert.equal(running.backupTimer, null);
    assert.equal(running.host, "127.0.0.1");
    assert.equal(existsSync(resolve(value.directory, "backups")), false);
    assert.equal(readFileSync(busTokenPath, "utf8"), `${busToken}\n`);
    assert.equal(readFileSync(bridgeTokenPath, "utf8"), `${bridgeToken}\n`);

    const baseURL = `http://127.0.0.1:${running.server.address().port}`;
    const healthResponse = await fetch(`${baseURL}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.runtime_mode, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL);
    assert.equal(health.port, running.server.address().port);
    assert.equal(health.source_identity.source_root, source.repository);
    assert.equal(health.source_identity.commit, source.fingerprint.git_commit_sha);
    assert.equal(health.seal_target.issue_id, value.target.issueId);
    assert.equal(health.frozen_scope_logical_snapshot_sha256, value.binding.logicalSnapshotSha256);
    assert.equal(health.pristine_state_snapshot_sha256, value.binding.stateSnapshotSha256);
    assert.equal(health.current_scope_logical_snapshot_sha256, value.binding.logicalSnapshotSha256);
    assert.equal(health.current_state_snapshot_sha256, value.binding.stateSnapshotSha256);
    assert.equal(health.current_seal_state, "PRISTINE_EMPTY");

    const denied = await fetch(`${baseURL}/v1/review/pending`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${busToken}`,
        "content-type": "application/json",
        origin: "http://127.0.0.1:43100",
      },
      body: "{",
    });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).code, "SEAL_RUNTIME_ROUTE_DENIED");
    await new Promise((resolvePromise) => running.server.close(resolvePromise));
    running.store.close();
    running = null;
    assert.deepEqual(value.normalService.requireIssue(value.target.issueId), beforeIssue);
    assert.deepEqual(value.normalStore.events(value.target.issueId), beforeEvents);
    assert.equal(createHash("sha256").update(readFileSync(value.databasePath)).digest("hex"), beforeMain);
    assert.equal(createHash("sha256").update(readFileSync(`${value.databasePath}-wal`)).digest("hex"), beforeWal);
  } finally {
    if (running) {
      await new Promise((resolvePromise) => running.server.close(resolvePromise));
      running.store.close();
    }
    value.normalStore.close();
    rmSync(value.directory, { recursive: true, force: true });
    rmSync(source.directory, { recursive: true, force: true });
  }
});

test("assessment-seal store rejects alternate, symlinked, replaced, and identity-mismatched databases", () => {
  const value = assessmentSealFixture("70707070-7070-4707-8707-707070707070");
  let sealStore;
  try {
    sealStore = value.createSealStore();
    assert.equal(sealStore.runtimeMode, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL);
    assert.equal(sealStore.sealSnapshot.issueEventCount, value.target.issueEventCount);
    assert.equal(sealStore.sealSnapshot.logicalSnapshotSha256, value.binding.logicalSnapshotSha256);
    assert.equal(sealStore.sealSnapshot.stateSnapshotSha256, value.binding.stateSnapshotSha256);
    assert.notEqual(value.binding.logicalSnapshotSha256, value.binding.stateSnapshotSha256);
    sealStore.close();
    sealStore = null;

    assert.throws(
      () => new ReviewBusStore(":memory:", { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: value.binding, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );
    assert.throws(
      () => new ReviewBusStore(value.databasePath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: { ...value.binding, inode: value.binding.inode + 1 }, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );
    assert.throws(
      () => new ReviewBusStore(value.databasePath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: { ...value.binding, sha256: "0".repeat(64) }, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );
    assert.throws(
      () => new ReviewBusStore(value.databasePath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: { ...value.binding, journalMode: "delete" }, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );
    assert.throws(
      () => new ReviewBusStore(value.databasePath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: { ...value.binding, stateSnapshotSha256: "0".repeat(64) }, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_TARGET_MISMATCH",
    );

    const alternateDirectory = resolve(value.directory, "alternate");
    mkdirSync(resolve(alternateDirectory, "evidence"), { recursive: true });
    const alternatePath = resolve(alternateDirectory, "review-bus.sqlite");
    copyFileSync(value.databasePath, alternatePath);
    copyFileSync(`${value.databasePath}-wal`, `${alternatePath}-wal`);
    assert.throws(
      () => new ReviewBusStore(alternatePath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: value.binding, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );

    const aliasPath = resolve(value.directory, "review-bus-alias.sqlite");
    symlinkSync(value.databasePath, aliasPath);
    assert.throws(
      () => new ReviewBusStore(aliasPath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: { ...value.binding, canonicalPath: aliasPath }, sealTarget: value.target }),
      (error) => error.code === "SEAL_RUNTIME_DATABASE_REQUIRED",
    );
  } finally {
    try { sealStore?.close(); } catch {}
    value.normalStore.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("assessment-seal prelisten validation rejects target, receipt, slot, and schema drift", () => {
  const missingEvidence = assessmentSealFixture("78787878-7878-4787-8787-787878787878");
  try {
    rmSync(resolve(missingEvidence.directory, "evidence"), { recursive: true, force: true });
    assert.throws(
      () => missingEvidence.createSealStore(),
      (error) => error.code === "SEAL_RUNTIME_EVIDENCE_ROOT_REQUIRED",
    );
  } finally {
    missingEvidence.normalStore.close();
    rmSync(missingEvidence.directory, { recursive: true, force: true });
  }

  const wrongTarget = assessmentSealFixture("71717171-7171-4717-8717-717171717171");
  try {
    for (const target of [
      { ...wrongTarget.target, projectId: "22222222-2222-4222-8222-222222222222" },
      { ...wrongTarget.target, issueId: "FILMOS-ARCH-72727272-7272-4727-8727-727272727272" },
      { ...wrongTarget.target, submissionId: "FILMOS-SUBMISSION-73737373-7373-4737-8737-737373737373" },
      { ...wrongTarget.target, actor: "chatgpt" },
      { ...wrongTarget.target, assessmentRound: wrongTarget.target.assessmentRound + 1 },
      { ...wrongTarget.target, entityVersion: wrongTarget.target.entityVersion + 1 },
      { ...wrongTarget.target, issueEventCount: wrongTarget.target.issueEventCount + 1 },
      { ...wrongTarget.target, lastEventHash: "2".repeat(64) },
      { ...wrongTarget.target, projectionHash: "0".repeat(64) },
      { ...wrongTarget.target, intakeReceiptHash: "1".repeat(64) },
    ]) {
      assert.throws(
        () => new ReviewBusStore(wrongTarget.databasePath, { runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL, sealBinding: wrongTarget.binding, sealTarget: target }),
        (error) => error.code === "SEAL_RUNTIME_TARGET_MISMATCH",
      );
    }
  } finally {
    wrongTarget.normalStore.close();
    rmSync(wrongTarget.directory, { recursive: true, force: true });
  }

  const sealedSlot = assessmentSealFixture("74747474-7474-4747-8747-747474747474");
  try {
    sealedSlot.normalService.submitAssessment(sealedSlot.issue.issue_id, "chatgpt", chatgptAssessment);
    assert.throws(
      () => prepareReviewBusSealBinding(sealedSlot.databasePath, sealedSlot.target),
      (error) => error.code === "SEAL_RUNTIME_TARGET_MISMATCH",
    );
  } finally {
    sealedSlot.normalStore.close();
    rmSync(sealedSlot.directory, { recursive: true, force: true });
  }

  const tamperedSuccessor = assessmentSealFixture("79797979-7979-4797-8797-797979797979");
  try {
    tamperedSuccessor.normalService.submitAssessment(tamperedSuccessor.issue.issue_id, "codex", codexAssessment);
    const row = tamperedSuccessor.normalStore.db.prepare("SELECT document_json FROM review_projections WHERE issue_id = ?").get(tamperedSuccessor.target.issueId);
    const document = JSON.parse(row.document_json);
    document.assessment_receipts.codex.receipt_hash = "3".repeat(64);
    delete document.content_hash;
    document.content_hash = sha256(document);
    tamperedSuccessor.normalStore.db.prepare("UPDATE review_projections SET document_json = ?, content_hash = ? WHERE issue_id = ?")
      .run(JSON.stringify(document), document.content_hash, tamperedSuccessor.target.issueId);
    assert.throws(
      () => prepareReviewBusSealBinding(tamperedSuccessor.databasePath, tamperedSuccessor.target),
      (error) => error.code === "SEAL_RUNTIME_TARGET_MISMATCH",
    );
  } finally {
    tamperedSuccessor.normalStore.close();
    rmSync(tamperedSuccessor.directory, { recursive: true, force: true });
  }

  const nonUniqueSuccessor = assessmentSealFixture("81818181-8181-4818-8818-818181818181");
  try {
    nonUniqueSuccessor.normalService.submitAssessment(nonUniqueSuccessor.issue.issue_id, "codex", codexAssessment);
    nonUniqueSuccessor.normalService.recordRuntimeObservation(nonUniqueSuccessor.issue.issue_id, "unexpected-runtime", new Date("2026-09-04T04:01:00.000Z"));
    assert.throws(
      () => prepareReviewBusSealBinding(nonUniqueSuccessor.databasePath, nonUniqueSuccessor.target),
      (error) => error.code === "SEAL_RUNTIME_TARGET_MISMATCH",
    );
  } finally {
    nonUniqueSuccessor.normalStore.close();
    rmSync(nonUniqueSuccessor.directory, { recursive: true, force: true });
  }

  const schemaDrift = assessmentSealFixture("75757575-7575-4757-8757-757575757575");
  try {
    schemaDrift.normalStore.db.exec("DROP TRIGGER review_events_no_delete");
    assert.throws(
      () => prepareReviewBusSealBinding(schemaDrift.databasePath, schemaDrift.target),
      (error) => error.code === "SEAL_RUNTIME_SCHEMA_MISMATCH",
    );
  } finally {
    schemaDrift.normalStore.close();
    rmSync(schemaDrift.directory, { recursive: true, force: true });
  }

  const restoredSchemaVersionDrift = assessmentSealFixture("82828282-8282-4828-8828-828282828282");
  try {
    restoredSchemaVersionDrift.normalService.submitAssessment(
      restoredSchemaVersionDrift.target.issueId,
      "codex",
      codexAssessment,
    );
    restoredSchemaVersionDrift.normalStore.db.exec(`
      DROP INDEX review_attachments_issue;
      CREATE INDEX review_attachments_issue ON review_attachments(issue_id, attachment_id);
      PRAGMA schema_version = ${restoredSchemaVersionDrift.binding.schemaVersion};
    `);
    assert.throws(
      () => new ReviewBusStore(restoredSchemaVersionDrift.databasePath, {
        runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
        sealBinding: restoredSchemaVersionDrift.binding,
        sealTarget: restoredSchemaVersionDrift.target,
      }),
      (error) => error.code === "SEAL_RUNTIME_SCHEMA_MISMATCH",
    );
  } finally {
    restoredSchemaVersionDrift.normalStore.close();
    rmSync(restoredSchemaVersionDrift.directory, { recursive: true, force: true });
  }

  const captureHashDrift = assessmentSealFixture("83838383-8383-4838-8838-838383838383");
  try {
    captureHashDrift.normalService.submitAssessment(captureHashDrift.target.issueId, "codex", codexAssessment);
    captureHashDrift.normalStore.db.prepare("UPDATE review_submissions SET capture_hash = ? WHERE submission_id = ?")
      .run("4".repeat(64), captureHashDrift.target.submissionId);
    assert.throws(
      () => new ReviewBusStore(captureHashDrift.databasePath, {
        runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
        sealBinding: captureHashDrift.binding,
        sealTarget: captureHashDrift.target,
      }),
      (error) => error.code === "SEAL_RUNTIME_TARGET_MISMATCH",
    );
  } finally {
    captureHashDrift.normalStore.close();
    rmSync(captureHashDrift.directory, { recursive: true, force: true });
  }
});

test("assessment-seal start-health-stop is zero-write and denies every route outside the exact Codex target", async () => {
  const value = assessmentSealFixture("76767676-7676-4767-8767-767676767676");
  const before = value.normalService.requireIssue(value.issue.issue_id);
  const beforeEvents = value.normalStore.events(value.issue.issue_id);
  const beforeMain = createHash("sha256").update(readFileSync(value.databasePath)).digest("hex");
  const beforeWal = createHash("sha256").update(readFileSync(`${value.databasePath}-wal`)).digest("hex");
  const running = await startAssessmentSealServer(value);
  try {
    const healthResponse = await fetch(`${running.baseURL}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.runtime_mode, REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL);
    assert.equal(health.source_identity.commit, commit);
    assert.equal(health.seal_target.issue_id, value.target.issueId);
    assert.equal(health.seal_target.actor, "codex");
    assert.equal(health.frozen_scope_logical_snapshot_sha256, value.binding.logicalSnapshotSha256);
    assert.equal(health.pristine_state_snapshot_sha256, value.binding.stateSnapshotSha256);
    assert.equal(health.current_scope_logical_snapshot_sha256, value.binding.logicalSnapshotSha256);
    assert.equal(health.current_state_snapshot_sha256, value.binding.stateSnapshotSha256);
    assert.equal(health.current_seal_state, "PRISTINE_EMPTY");
    assert.equal(JSON.stringify(health).includes("assessment_body"), false);

    const denied = await fetch(`${running.baseURL}/v1/review/pending`, { method: "POST", headers: running.headers, body: "{" });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).code, "SEAL_RUNTIME_ROUTE_DENIED");
    const wrongActor = await fetch(`${running.baseURL}/v1/issues/${value.target.issueId}/assessments/chatgpt`, { method: "POST", headers: running.headers, body: "{" });
    assert.equal(wrongActor.status, 404);
    assert.equal((await wrongActor.json()).code, "SEAL_RUNTIME_ROUTE_DENIED");

    const endpoint = `${running.baseURL}/v1/issues/${value.target.issueId}/assessments/codex`;
    const wrongProject = await fetch(`${endpoint}?project_id=wrong&submission_id=${value.target.submissionId}`, { method: "POST", headers: running.headers, body: "{" });
    assert.equal(wrongProject.status, 403);
    assert.equal((await wrongProject.json()).code, "PROJECT_SCOPE_DENIED");
    const wrongSubmission = await fetch(`${endpoint}?project_id=${value.target.projectId}&submission_id=wrong`, { method: "POST", headers: running.headers, body: "{" });
    assert.equal(wrongSubmission.status, 409);
    assert.equal((await wrongSubmission.json()).code, "SUBMISSION_BINDING_MISMATCH");
    const missingScope = await fetch(endpoint, { method: "POST", headers: running.headers, body: "{" });
    assert.equal(missingScope.status, 403);
    assert.equal((await missingScope.json()).code, "PROJECT_SCOPE_DENIED");
    assert.equal(existsSync(resolve(value.directory, "backups")), false);
  } finally {
    await new Promise((resolvePromise) => running.server.close(resolvePromise));
    running.store.close();
  }
  assert.deepEqual(value.normalService.requireIssue(value.issue.issue_id), before);
  assert.deepEqual(value.normalStore.events(value.issue.issue_id), beforeEvents);
  assert.equal(createHash("sha256").update(readFileSync(value.databasePath)).digest("hex"), beforeMain);
  assert.equal(createHash("sha256").update(readFileSync(`${value.databasePath}-wal`)).digest("hex"), beforeWal);
  value.normalStore.close();
  rmSync(value.directory, { recursive: true, force: true });
});

test("assessment-seal preserves one first write across concurrency and process-restart recovery", async () => {
  const value = assessmentSealFixture("77777777-7777-4777-8777-777777777777");
  const firstStore = value.createSealStore();
  const secondStore = value.createSealStore();
  value.normalStore.close();
  let first = await startAssessmentSealServer(value, firstStore);
  let second = await startAssessmentSealServer(value, secondStore);
  let restarted = null;
  const endpoint = (running) => `${running.baseURL}/v1/issues/${value.target.issueId}/assessments/codex?project_id=${value.target.projectId}&submission_id=${value.target.submissionId}`;
  try {
    const responses = await Promise.all([
      fetch(endpoint(first), { method: "POST", headers: first.headers, body: JSON.stringify(codexAssessment) }),
      fetch(endpoint(second), { method: "POST", headers: second.headers, body: JSON.stringify(codexAssessment) }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(responses.map((response) => response.status), [200, 200], JSON.stringify(bodies));
    assert.deepEqual(bodies[0].assessment_receipt, bodies[1].assessment_receipt);
    assert.equal(bodies.filter((body) => body.idempotent_replay === false).length, 1);
    assert.equal(bodies.filter((body) => body.idempotent_replay === true).length, 1);
    const persisted = first.service.requireIssue(value.target.issueId);
    assert.equal(persisted.entity_version, value.target.entityVersion + 1);
    assert.equal(first.store.events(value.target.issueId).length, value.target.issueEventCount + 1);
    const sealedHealth = await fetch(`${first.baseURL}/healthz`);
    assert.equal(sealedHealth.status, 200);
    const sealedHealthBody = await sealedHealth.json();
    assert.equal(sealedHealthBody.current_seal_state, "CODEX_SEALED_SUCCESSOR");
    assert.equal(sealedHealthBody.frozen_scope_logical_snapshot_sha256, value.binding.logicalSnapshotSha256);
    assert.equal(sealedHealthBody.pristine_state_snapshot_sha256, value.binding.stateSnapshotSha256);
    assert.notEqual(sealedHealthBody.current_scope_logical_snapshot_sha256, value.binding.logicalSnapshotSha256);
    assert.notEqual(sealedHealthBody.current_state_snapshot_sha256, value.binding.stateSnapshotSha256);

    const replay = await fetch(endpoint(first), { method: "POST", headers: first.headers, body: JSON.stringify(codexAssessment) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent_replay, true);
    const version = first.service.requireIssue(value.target.issueId).entity_version;
    const eventCount = first.store.events(value.target.issueId).length;
    const conflict = await fetch(endpoint(second), { method: "POST", headers: second.headers, body: JSON.stringify({ ...codexAssessment, rollback: ["different"] }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "ASSESSMENT_FROZEN_CONFLICT");
    assert.equal(first.service.requireIssue(value.target.issueId).entity_version, version);
    assert.equal(first.store.events(value.target.issueId).length, eventCount);
    assert.equal(first.store.verifyEventChain(value.target.issueId), true);

    await Promise.all([
      new Promise((resolvePromise) => first.server.close(resolvePromise)),
      new Promise((resolvePromise) => second.server.close(resolvePromise)),
    ]);
    first.store.close();
    second.store.close();
    first = null;
    second = null;

    const successorProbe = prepareReviewBusSealBinding(value.databasePath, value.target);
    assert.equal(successorProbe.sealState, "CODEX_SEALED_SUCCESSOR");
    assert.equal(successorProbe.walPresent, false);
    assert.notEqual(createHash("sha256").update(readFileSync(value.databasePath)).digest("hex"), value.binding.sha256);
    const restartedStore = new ReviewBusStore(value.databasePath, {
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
      sealBinding: value.binding,
      sealTarget: value.target,
    });
    restarted = await startAssessmentSealServer(value, restartedStore);
    const restartedReplay = await fetch(endpoint(restarted), { method: "POST", headers: restarted.headers, body: JSON.stringify(codexAssessment) });
    assert.equal(restartedReplay.status, 200);
    const restartedBody = await restartedReplay.json();
    assert.equal(restartedBody.idempotent_replay, true);
    assert.deepEqual(restartedBody.assessment_receipt, bodies[0].assessment_receipt);
    const restartedConflict = await fetch(endpoint(restarted), { method: "POST", headers: restarted.headers, body: JSON.stringify({ ...codexAssessment, rollback: ["restart-different"] }) });
    assert.equal(restartedConflict.status, 409);
    assert.equal((await restartedConflict.json()).code, "ASSESSMENT_FROZEN_CONFLICT");
    assert.equal(restarted.service.requireIssue(value.target.issueId).entity_version, version);
    assert.equal(restarted.store.events(value.target.issueId).length, eventCount);
    assert.equal(restarted.store.verifyEventChain(value.target.issueId), true);
  } finally {
    const running = [first, second, restarted].filter(Boolean);
    await Promise.all(running.map((item) => new Promise((resolvePromise) => item.server.close(resolvePromise))));
    for (const item of running) item.store.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("assessment-seal recovers a lost response after an abrupt process termination with changed WAL", async () => {
  const value = assessmentSealFixture("80808080-8080-4808-8808-808080808080");
  let restarted = null;
  try {
    const crash = await runCrashedSealWrite(value);
    assert.notEqual(crash.code, 0);
    assert.equal(existsSync(`${value.databasePath}-wal`), true);
    const changedWalHash = createHash("sha256").update(readFileSync(`${value.databasePath}-wal`)).digest("hex");
    assert.notEqual(changedWalHash, value.binding.walSha256);

    const successorProbe = prepareReviewBusSealBinding(value.databasePath, value.target);
    assert.equal(successorProbe.sealState, "CODEX_SEALED_SUCCESSOR");
    assert.equal(successorProbe.walPresent, true);
    assert.equal(successorProbe.walSha256, changedWalHash);
    const restartedStore = new ReviewBusStore(value.databasePath, {
      runtimeMode: REVIEW_BUS_RUNTIME_MODE_ASSESSMENT_SEAL,
      sealBinding: value.binding,
      sealTarget: value.target,
    });
    restarted = await startAssessmentSealServer(value, restartedStore);
    assert.equal(restarted.store.sealSnapshot.sealState, "CODEX_SEALED_SUCCESSOR");
    const endpoint = `${restarted.baseURL}/v1/issues/${value.target.issueId}/assessments/codex?project_id=${value.target.projectId}&submission_id=${value.target.submissionId}`;
    const before = restarted.service.requireIssue(value.target.issueId);
    const originalReceipt = structuredClone(before.assessment_receipts.codex);
    const beforeEventCount = restarted.store.events(value.target.issueId).length;
    const replayResponse = await fetch(endpoint, { method: "POST", headers: restarted.headers, body: JSON.stringify(codexAssessment) });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(replay.assessment_receipt, originalReceipt);
    const conflictResponse = await fetch(endpoint, { method: "POST", headers: restarted.headers, body: JSON.stringify({ ...codexAssessment, rollback: ["crash-different"] }) });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, "ASSESSMENT_FROZEN_CONFLICT");
    const after = restarted.service.requireIssue(value.target.issueId);
    assert.equal(after.entity_version, before.entity_version);
    assert.equal(after.content_hash, before.content_hash);
    assert.equal(restarted.store.events(value.target.issueId).length, beforeEventCount);
    assert.equal(restarted.store.verifyEventChain(value.target.issueId), true);
  } finally {
    if (restarted) {
      await new Promise((resolvePromise) => restarted.server.close(resolvePromise));
      restarted.store.close();
    }
    try { value.normalStore.close(); } catch {}
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("Installed SourceIdentity cross-checks Bundle runtime, repository locator, and real Git objects", () => {
  const value = installedIdentityFixture();
  try {
    const identity = value.load();
    assert.equal(identity.schema_version, "filmos.installed-source-identity.v1");
    assert.equal(identity.commit, value.sourceCommit);
    assert.equal(identity.tree, value.sourceTree);
    assert.equal(identity.build_id, value.buildID);
    assert.match(identity.content_hash, /^[a-f0-9]{64}$/);

    execFileSync("git", ["-C", value.repository, "remote", "set-url", "origin", "https://github.com/maiyadiu/filmos-studio"]);
    execFileSync("git", ["-C", value.repository, "remote", "set-url", "--push", "origin", "git@github.com:maiyadiu/filmos-studio"]);
    assert.equal(value.load().content_hash, identity.content_hash);

    execFileSync("git", ["-C", value.repository, "remote", "set-url", "origin", "https://github.com/maiyadiu/filmos-studio.evil.example"]);
    assert.throws(() => value.load(), (error) => error.code === "INSTALLED_SOURCE_IDENTITY_MISMATCH");
    execFileSync("git", ["-C", value.repository, "remote", "set-url", "origin", "https://github.com/maiyadiu/filmos-studio.git"]);
    execFileSync("git", ["-C", value.repository, "remote", "set-url", "--push", "origin", "git@github.com:maiyadiu/filmos-studio.git"]);

    writeFileSync(value.runtimePath, JSON.stringify({ ...value.runtime, build_id: "candidate-mismatch" }));
    assert.throws(() => value.load(), (error) => error.code === "APP_RUNTIME_IDENTITY_MISMATCH");
    writeFileSync(value.runtimePath, JSON.stringify(value.runtime));

    const absentCommit = "0".repeat(40);
    writeFileSync(value.sourcePath, JSON.stringify({ ...value.source, git_commit_sha: absentCommit }));
    writeFileSync(value.runtimePath, JSON.stringify({ ...value.runtime, source_commit: absentCommit }));
    writeFileSync(value.locatorPath, JSON.stringify({ ...value.locator, source_commit: absentCommit }));
    assert.throws(() => value.load(), (error) => error.code === "SOURCE_COMMIT_NOT_FOUND");

    const wrongTree = "1".repeat(40);
    writeFileSync(value.sourcePath, JSON.stringify({ ...value.source, git_tree_sha: wrongTree }));
    writeFileSync(value.runtimePath, JSON.stringify({ ...value.runtime, source_tree: wrongTree }));
    writeFileSync(value.locatorPath, JSON.stringify({ ...value.locator, source_tree: wrongTree }));
    assert.throws(() => value.load(), (error) => error.code === "SOURCE_TREE_MISMATCH");
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("new Intake binds the verified Installed App identity and starts Architecture v2 at Genesis", async () => {
  const value = installedIdentityFixture();
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store, { taskPackageContentHash: taskHash });
  const installedSourceIdentity = value.load();
  const { server, baseURL, headers } = await startReviewServer(service, store, { installedSourceIdentity });
  const submissionId = "FILMOS-SUBMISSION-33333333-3333-4333-8333-333333333333";
  const body = stageABody({
    submission_id: submissionId,
    app_build_id: installedSourceIdentity.build_id,
    app_tree: installedSourceIdentity.tree,
  });
  try {
    const health = await (await fetch(`${baseURL}/healthz`)).json();
    assert.equal(health.installed_source_identity.status, "VERIFIED");
    assert.equal(health.installed_source_identity.content_hash, installedSourceIdentity.content_hash);
    const stagedResponse = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(stagedResponse.status, 201);
    const staged = await stagedResponse.json();
    const finalizedResponse = await fetch(`${baseURL}/v1/submissions/${submissionId}/finalize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: projectId, capture_hash: staged.capture_hash }),
    });
    const finalized = await finalizedResponse.json();
    assert.equal(finalizedResponse.status, 201, JSON.stringify(finalized));
    assert.equal(finalized.receipt.formal_issue_id, "FILMOS-ARCH-33333333-3333-4333-8333-333333333333");
    assert.equal(finalized.receipt.source_identity_hash, installedSourceIdentity.content_hash);
    assert.equal("bootstrap_receipt_hash" in finalized.receipt, false);
    const issue = service.requireIssue(finalized.receipt.formal_issue_id);
    assert.equal(issue.base_commit, installedSourceIdentity.commit);
    assert.equal(issue.architecture_protocol_version, "filmos.architecture-protocol.v2");
    assert.equal(issue.state, "REQUIREMENT_OBSERVED");
    assert.equal(issue.requirement_delta, undefined);
    assert.match(issue.intake_evidence_receipt?.receipt_hash ?? "", /^[a-f0-9]{64}$/);
    assert.match(issue.evidence?.manifest?.contentHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "architecture.intake_evidence.recorded").length, 1);
    assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM review_bootstrap_receipts").get().count, 0);

    const requirement = service.freezeRequirementDelta(issue.issue_id, architectureDelta, "user", new Date("2026-09-02T01:00:00.000Z"));
    assert.equal(requirement.state, "REQUIREMENT_DELTA_FROZEN");
    const evidence = service.freezeEvidence(issue.issue_id, {
      source_commit: installedSourceIdentity.commit,
      items: issue.evidence.local_items,
    }, "codex", new Date("2026-09-02T01:01:00.000Z"));
    assert.equal(evidence.state, "ARCHITECTURE_EVIDENCE_FROZEN");
    assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "evidence.frozen").length, 1);
    assert.equal(store.verifyEventChain(issue.issue_id), true);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("new Intake fails closed without Installed SourceIdentity while legacy base and history remain unchanged", async () => {
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  const legacy = service.createIssue({ issue_id: "FILMOS-ARCH-source-history", project_id: projectId, what_happened: "legacy", expected_result: "anchor only", location: "review bus", blocks_work: false, lane: "architecture" }, "user", new Date(), { architectureProtocolVersion: null });
  const { server, baseURL, headers } = await startReviewServer(service, store, { sourceIdentityErrorCode: "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE" });
  try {
    const body = stageABody({ submission_id: "FILMOS-SUBMISSION-44444444-4444-4444-8444-444444444444" });
    const response = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 503, code: "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", message: "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", retryable: true });
    assert.equal(service.requireIssue(legacy.issue_id).base_commit, commit);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
  }
});

test("verified startup appends one v2 Anchor without changing a legacy Issue base commit", async () => {
  const value = installedIdentityFixture();
  const store = new ReviewBusStore(":memory:");
  const service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  const legacy = service.createIssue({ issue_id: "FILMOS-ARCH-startup-anchor", project_id: projectId, what_happened: "legacy", expected_result: "v2 anchor", location: "review bus", blocks_work: false, lane: "architecture" }, "user", new Date(), { architectureProtocolVersion: null });
  const { server } = await startReviewServer(service, store, { installedSourceIdentity: value.load() });
  try {
    const anchored = service.requireIssue(legacy.issue_id);
    assert.equal(anchored.base_commit, commit);
    assert.equal(anchored.protocol_v2_anchor.migration_commit, value.sourceCommit);
    assert.equal(store.events(legacy.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 1);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    store.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("Stage A intake finalizes one canonical Architecture Issue and recovers a lost receipt idempotently", async () => {
  const { service, store } = fixture();
  const { server, baseURL, headers } = await startReviewServer(service, store);
  const body = stageABody();
  try {
    const stagedResponse = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(stagedResponse.status, 201);
    const staged = await stagedResponse.json();
    assert.match(staged.capture_hash, /^[a-f0-9]{64}$/);
    const finalizeBody = { project_id: projectId, capture_hash: staged.capture_hash };
    const lostReceipt = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers, body: JSON.stringify(finalizeBody) });
    assert.equal(lostReceipt.status, 201);
    // Deliberately do not consume the first response body: the server succeeded but the client lost its receipt.
    const replay = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers, body: JSON.stringify(finalizeBody) });
    assert.equal(replay.status, 200);
    const result = await replay.json();
    assert.equal(result.idempotent_replay, true);
    assert.equal(result.receipt.formal_issue_id, "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b");
    assert.equal(result.receipt.submission_id, stageASubmissionId);
    assert.equal(result.receipt.project_id, projectId);
    assert.equal(result.receipt.capture_hash, staged.capture_hash);
    assert.equal(result.receipt.state, "ARCHITECTURE_EVIDENCE_FROZEN");
    const projection = service.requireIssue(result.receipt.formal_issue_id);
    assert.ok(projection.evidence.manifest.contentHash);
    assert.equal(projection.evidence.manifest.completeness.reproduction, true);
    assert.equal(projection.evidence.manifest.completeness.logs, true);
    assert.equal(projection.report.captured_at, body.captured_at);
    assert.equal(projection.report.blocks_work, false);
    assert.equal(store.events(projection.issue_id).filter((event) => event.event_type === "issue.observed").length, 1);
    assert.equal(store.list().filter((item) => item.issue_id === projection.issue_id).length, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM review_submission_receipts").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM review_bootstrap_receipts").get().count, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("Stage A intake rejects the legacy one-shot endpoint and exposes a safe non-retryable contract", async () => {
  const { service, store } = fixture();
  const { server, baseURL, headers } = await startReviewServer(service, store);
  try {
    const response = await fetch(`${baseURL}/v1/issues`, { method: "POST", headers, body: JSON.stringify({ project_id: projectId }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: 409, code: "INTAKE_PROTOCOL_UPGRADE_REQUIRED", message: "INTAKE_PROTOCOL_UPGRADE_REQUIRED", retryable: false });
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("legacy Architecture history receives exactly one v2 Anchor without rewriting its prefix", () => {
  const { service, store } = fixture();
  const issue = service.createIssue({ issue_id: "FILMOS-ARCH-anchor", project_id: projectId, what_happened: "legacy architecture issue", expected_result: "v2 transition authority", location: "review bus", blocks_work: false, lane: "architecture" }, "user", new Date("2026-09-01T10:00:00.000Z"), { architectureProtocolVersion: null });
  service.freezeEvidence(issue.issue_id, { source_commit: commit, items: architectureEvidence }, "codex", new Date("2026-09-01T10:01:00.000Z"));
  const legacy = service.requireIssue(issue.issue_id);
  const legacyEvents = store.events(issue.issue_id);
  const legacyDocuments = legacyEvents.map((event) => JSON.stringify(event));
  const migrationCommit = "b".repeat(40);

  const anchored = service.anchorLegacyArchitecture(issue.issue_id, migrationCommit, new Date("2026-09-02T10:00:00.000Z"));

  assert.equal(anchored.idempotent_replay, false);
  assert.equal(anchored.issue.architecture_protocol_version, "filmos.architecture-protocol.v2");
  assert.equal(anchored.issue.protocol_v2_anchor.legacy_projection_hash, legacy.content_hash);
  assert.equal(anchored.issue.protocol_v2_anchor.legacy_entity_version, legacy.entity_version);
  assert.equal(anchored.issue.protocol_v2_anchor.legacy_last_event_hash, legacyEvents.at(-1).event_hash);
  assert.equal(anchored.issue.protocol_v2_anchor.migration_commit, migrationCommit);
  assert.equal(anchored.verification.legacy_result, "LEGACY_HASH_CHAIN_VALID");
  assert.equal(anchored.verification.v2_result, "V2_SEMANTIC_CHAIN_VALID_FROM_ANCHOR");
  assert.equal(anchored.verification.full_history_semantic_pass, false);
  assert.deepEqual(store.events(issue.issue_id).slice(0, legacyEvents.length).map((event) => JSON.stringify(event)), legacyDocuments);
  assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 1);

  const replay = service.anchorLegacyArchitecture(issue.issue_id, migrationCommit, new Date("2026-09-02T10:01:00.000Z"));
  assert.equal(replay.idempotent_replay, true);
  assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 1);
  assert.throws(() => service.anchorLegacyArchitecture(issue.issue_id, "c".repeat(40)), /ARCHITECTURE_V2_ANCHOR_CONFLICT/);
  store.close();
});

test("Codex coordination result is immutable, idempotent, and restart-readable by coordination key", () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "coordination-result");
  const summary = service.pendingAll().find((item) => item.issue_id === issue.issue_id);
  assert.equal("codex_coordination" in service.pending(projectId).find((item) => item.issue_id === issue.issue_id), false);
  const attemptId = "review-attempt-11111111-1111-4111-8111-111111111111";
  service.recordCodexCoordination(issue.issue_id, {
    status: "RUNNING",
    session_id: "brain-session-coordination",
    last_action: "LOCAL_ASSESSMENT",
    last_error_code: null,
    coordination_key: summary.coordination_key,
    attempt_id: attemptId,
    retry_count: 0,
    next_retry_at: null,
    stop_reason: null,
  });
  const result = { coordination_attempt_id: attemptId, reproduced: true, root_cause: "persistent result" };
  const first = service.recordCodexCoordinationResult(issue.issue_id, { coordination_key: summary.coordination_key, attempt_id: attemptId, action: "LOCAL_ASSESSMENT", result });
  const replay = service.recordCodexCoordinationResult(issue.issue_id, { coordination_key: summary.coordination_key, attempt_id: attemptId, action: "LOCAL_ASSESSMENT", result });

  assert.equal(first.idempotent_replay, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(service.pendingAll().find((item) => item.issue_id === issue.issue_id).codex_coordination.result_available, true);
  assert.deepEqual(service.readCodexCoordinationResult(issue.issue_id, projectId, summary.coordination_key).result, result);
  assert.equal(store.events(issue.issue_id).filter((event) => event.event_type === "codex.coordination.result-ready").length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM review_codex_coordination_results").get().count, 1);
  assert.throws(() => service.recordCodexCoordinationResult(issue.issue_id, { coordination_key: summary.coordination_key, attempt_id: attemptId, action: "LOCAL_ASSESSMENT", result: { ...result, root_cause: "changed" } }), /CODEX_COORDINATION_RESULT_CONFLICT/);
  assert.throws(() => store.db.prepare("UPDATE review_codex_coordination_results SET action = 'changed'").run(), /CODEX_COORDINATION_RESULT_IMMUTABLE/);
  store.close();
});

test("v2 Anchor fails closed when the legacy hash chain is invalid and is never added to a v2 Genesis issue", () => {
  const { service, store } = fixture();
  const legacy = service.createIssue({ issue_id: "FILMOS-ARCH-broken-anchor", project_id: projectId, what_happened: "legacy issue", expected_result: "valid chain", location: "review bus", blocks_work: false, lane: "architecture" }, "user", new Date(), { architectureProtocolVersion: null });
  store.db.prepare("INSERT INTO review_events(event_id,issue_id,event_type,actor,payload_json,previous_hash,event_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("review-event-forged", legacy.issue_id, "forged", "system", "{}", "wrong-previous-hash", "f".repeat(64), new Date().toISOString());
  assert.throws(() => service.anchorLegacyArchitecture(legacy.issue_id, "b".repeat(40)), /LEGACY_HASH_CHAIN_INVALID/);
  assert.equal(store.events(legacy.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 0);

  const v2 = service.createIssue({ issue_id: "FILMOS-ARCH-v2-genesis", project_id: projectId, what_happened: "new issue", expected_result: "native v2", location: "review bus", blocks_work: false, lane: "architecture" });
  assert.throws(() => service.anchorLegacyArchitecture(v2.issue_id, "b".repeat(40)), /ARCHITECTURE_LEGACY_ANCHOR_NOT_REQUIRED/);
  assert.equal(store.events(v2.issue_id).filter((event) => event.event_type === "protocol.v2.anchored").length, 0);
  store.close();
});

test("Stage A attachment staging is immutable and Finalize fails closed until every declared byte is verified", async () => {
  const { service, store } = fixture();
  const { server, baseURL, headers } = await startReviewServer(service, store);
  const bytes = Buffer.from("stage-a-screenshot-bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const attachment = {
    attachment_id: "attachment-stage-a-1",
    media_type: "image/png",
    original_name: "反馈截图.png",
    size_bytes: bytes.length,
    sha256: digest,
    captured_at: "2026-09-01T16:16:00.955Z",
  };
  try {
    const stagedResponse = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(stageABody({ attachment_manifest: [attachment] })) });
    const staged = await stagedResponse.json();
    const finalize = () => fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers, body: JSON.stringify({ project_id: projectId, capture_hash: staged.capture_hash }) });
    const missing = await finalize();
    assert.equal(missing.status, 422);
    assert.equal((await missing.json()).code, "SUBMISSION_ATTACHMENT_MISSING");
    assert.equal(store.list().length, 0);

    const uploadBody = { ...attachment, base64: bytes.toString("base64") };
    const uploaded = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/attachments`, { method: "POST", headers, body: JSON.stringify(uploadBody) });
    assert.equal(uploaded.status, 201);
    const uploadReceipt = await uploaded.json();
    assert.equal(uploadReceipt.receipt.sha256, digest);
    const replay = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/attachments`, { method: "POST", headers, body: JSON.stringify(uploadBody) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).receipt.receipt_hash, uploadReceipt.receipt.receipt_hash);

    const changedBytes = Buffer.from("different-stage-a-screenshot");
    const conflict = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/attachments`, { method: "POST", headers, body: JSON.stringify({ ...uploadBody, size_bytes: changedBytes.length, sha256: createHash("sha256").update(changedBytes).digest("hex"), base64: changedBytes.toString("base64") }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "ATTACHMENT_ID_CONFLICT");

    const accepted = await finalize();
    assert.equal(accepted.status, 201);
    const receipt = (await accepted.json()).receipt;
    const issue = service.requireIssue(receipt.formal_issue_id);
    assert.equal(issue.attachments.length, 1);
    assert.equal(issue.attachments[0].sha256, digest);
    assert.equal(issue.evidence.local_items.some((item) => item.content?.attachment_id === attachment.attachment_id), true);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("Stage A preserves project scope and submission identity across conflicts and concurrent windows", async () => {
  const { service, store } = fixture();
  const legacy = createCoreIssue(service, "legacy-v8-preserved");
  const { server, baseURL, headers } = await startReviewServer(service, store);
  const legacyEvents = store.events(legacy.issue_id).map((event) => event.event_hash);
  const legacyProjectionHash = store.get(legacy.issue_id).content_hash;
  try {
    const stagedResponse = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(stageABody()) });
    const staged = await stagedResponse.json();
    const conflictingStage = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(stageABody({ what_happened: "changed after the stable local draft" })) });
    assert.equal(conflictingStage.status, 409);
    assert.equal((await conflictingStage.json()).code, "SUBMISSION_IDEMPOTENCY_CONFLICT");
    const wrongProject = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers, body: JSON.stringify({ project_id: "22222222-2222-4222-8222-222222222222", capture_hash: staged.capture_hash }) });
    assert.equal(wrongProject.status, 409);
    assert.equal((await wrongProject.json()).code, "SUBMISSION_PROJECT_SCOPE_CONFLICT");
    assert.equal(store.submissionStatus(stageASubmissionId).state, "STAGED");

    const requests = [1, 2].map(() => fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers, body: JSON.stringify({ project_id: projectId, capture_hash: staged.capture_hash }) }));
    const results = await Promise.all(requests);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 201]);
    const receipts = await Promise.all(results.map((response) => response.json()));
    assert.equal(receipts[0].receipt.receipt_hash, receipts[1].receipt.receipt_hash);
    const issueId = receipts[0].receipt.formal_issue_id;
    assert.equal(store.events(issueId).filter((event) => event.event_type === "issue.observed").length, 1);
    assert.equal(store.list().filter((item) => item.issue_id === issueId).length, 1);
    assert.deepEqual(store.events(legacy.issue_id).map((event) => event.event_hash), legacyEvents);
    assert.equal(store.get(legacy.issue_id).content_hash, legacyProjectionHash);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("Stage A resumes a staged Submission and returns the immutable Receipt after process restart", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-stage-a-restart-"));
  const databasePath = resolve(directory, "review-bus.sqlite");
  let store = new ReviewBusStore(databasePath);
  let service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
  let running = await startReviewServer(service, store);
  try {
    const stagedResponse = await fetch(`${running.baseURL}/v1/submissions`, { method: "POST", headers: running.headers, body: JSON.stringify(stageABody()) });
    const staged = await stagedResponse.json();
    await new Promise((resolvePromise) => running.server.close(resolvePromise));
    store.close();

    store = new ReviewBusStore(databasePath);
    service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
    running = await startReviewServer(service, store);
    const accepted = await fetch(`${running.baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers: running.headers, body: JSON.stringify({ project_id: projectId, capture_hash: staged.capture_hash }) });
    assert.equal(accepted.status, 201);
    const original = (await accepted.json()).receipt;
    await new Promise((resolvePromise) => running.server.close(resolvePromise));
    store.close();

    store = new ReviewBusStore(databasePath);
    service = new ReviewBusService(store, { baseCommit: commit, taskPackageContentHash: taskHash });
    running = await startReviewServer(service, store);
    const replay = await fetch(`${running.baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers: running.headers, body: JSON.stringify({ project_id: projectId, capture_hash: staged.capture_hash }) });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).receipt, original);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM review_submission_receipts").get().count, 1);
  } finally {
    if (running.server.listening) await new Promise((resolvePromise) => running.server.close(resolvePromise));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Stage A readback requires the actual MCP handler and rejects the wrong Project Grant", async () => {
  const { service, store } = fixture();
  const { server, baseURL, headers } = await startReviewServer(service, store);
  try {
    const stagedResponse = await fetch(`${baseURL}/v1/submissions`, { method: "POST", headers, body: JSON.stringify(stageABody()) });
    const staged = await stagedResponse.json();
    const accepted = await fetch(`${baseURL}/v1/submissions/${stageASubmissionId}/finalize`, { method: "POST", headers, body: JSON.stringify({ project_id: projectId, capture_hash: staged.capture_hash }) });
    const receipt = (await accepted.json()).receipt;
    service.recordRuntimeObservation(receipt.formal_issue_id, "runtime-after-intake-receipt");
    assert.notEqual(service.requireIssue(receipt.formal_issue_id).content_hash, receipt.projection_content_hash);
    const mcpHeaders = { ...headers, "x-filmos-read-consumer": "chatgpt-mcp" };
    const wrongProject = await fetch(`${baseURL}/v1/review/issues/${receipt.formal_issue_id}/evidence?project_id=wrong-project`, { headers: mcpHeaders });
    assert.equal(wrongProject.status, 403);
    assert.equal((await wrongProject.json()).code, "PROJECT_SCOPE_DENIED");
    const pending = await fetch(`${baseURL}/v1/review/pending?project_id=${projectId}`, { headers: mcpHeaders });
    assert.equal(pending.status, 200);
    const pendingBody = await pending.json();
    const pendingIssue = pendingBody.issues.find((item) => item.issue_id === receipt.formal_issue_id);
    assert.ok(pendingIssue);
    assert.equal(pendingIssue.submission_id, stageASubmissionId);
    const evidence = await fetch(`${baseURL}/v1/review/issues/${receipt.formal_issue_id}/evidence?project_id=${projectId}`, { headers: mcpHeaders });
    assert.equal(evidence.status, 200);
    const evidenceBody = await evidence.json();
    assert.equal(evidenceBody.submission_id, stageASubmissionId);
    assert.equal(evidenceBody.formal_issue_id, receipt.formal_issue_id);
    assert.equal(evidenceBody.capture_hash, staged.capture_hash);
    assert.equal(evidenceBody.receipt_hash, receipt.receipt_hash);
    assert.equal(evidenceBody.evidence_manifest_hash, receipt.evidence_manifest_hash);
    assert.equal(evidenceBody.current_evidence_manifest_hash, service.requireIssue(receipt.formal_issue_id).evidence.manifest.contentHash);
    const confirmation = await fetch(`${baseURL}/v1/review/internal/issues/${receipt.formal_issue_id}/intake-confirmation?project_id=${projectId}`, { headers });
    assert.equal(confirmation.status, 200);
    const value = await confirmation.json();
    assert.equal(value.pending_read, true);
    assert.equal(value.evidence_read, true);
    assert.equal(value.submission_id, stageASubmissionId);
    assert.equal(value.capture_hash, staged.capture_hash);
    assert.equal(value.receipt_hash, receipt.receipt_hash);
    assert.equal(value.projection_content_hash, receipt.projection_content_hash);
    assert.equal(value.current_projection_content_hash, service.requireIssue(receipt.formal_issue_id).content_hash);
    assert.equal(value.evidence_manifest_hash, receipt.evidence_manifest_hash);
    assert.equal(value.current_evidence_manifest_hash, service.requireIssue(receipt.formal_issue_id).evidence.manifest.contentHash);
    const pendingReceipt = value.receipts.find((item) => item.tool_name === "issue_list_pending");
    const evidenceReceipt = value.receipts.find((item) => item.tool_name === "issue_get_evidence");
    for (const readReceipt of [pendingReceipt, evidenceReceipt]) {
      assert.equal(readReceipt.project_id, projectId);
      assert.equal(readReceipt.projection_content_hash, value.current_projection_content_hash);
      assert.equal(readReceipt.evidence_manifest_hash, value.current_evidence_manifest_hash);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("Chrome pairing revoke invalidates the bridge token and every unused challenge", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "revoke");
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const bridgeToken = "bridge-token-1234567890-abcdefghijkl";
  const server = createReviewBusHttp({ service, store, busToken: "bus-token-1234567890-abcdefghijkl", bridgeToken, constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  try {
    const challenge = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(challenge.status, 201);
    const revoke = await fetch(`http://127.0.0.1:${port}/v1/bridge/revoke`, { method: "POST", headers, body: "{}" });
    assert.equal(revoke.status, 200);
    assert.ok((await revoke.json()).outstanding_challenges_revoked >= 1);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, "LOCAL_PAIRING_REQUIRED");
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("six-digit pairing codes are one-time and issue revocable per-client session tokens", async () => {
  const { service, store } = fixture();
  const issue = createCoreIssue(service, "pair-client");
  const constitution = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../governance/FILMOS_CONSTITUTION.json"), "utf8"));
  const server = createReviewBusHttp({ service, store, busToken: "bus-token-1234567890-abcdefghijkl", bridgeToken: "legacy-bridge-token-1234567890-abcdef", constitution });
  server.listen(0, "127.0.0.1"); await new Promise((resolvePromise) => server.once("listening", resolvePromise));
  const port = server.address().port;
  try {
    const pairing = store.createPairingCode();
    const pair = await fetch(`http://127.0.0.1:${port}/v1/bridge/pair`, { method: "POST", headers: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" }, body: JSON.stringify({ pairing_code: pairing.pairing_code, client_name: "Acceptance Chrome" }) });
    assert.equal(pair.status, 201);
    const session = await pair.json();
    assert.match(session.bridge_session_token, /^bridge-session-/);
    const replay = await fetch(`http://127.0.0.1:${port}/v1/bridge/pair`, { method: "POST", headers: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" }, body: JSON.stringify({ pairing_code: pairing.pairing_code, client_name: "Replay" }) });
    assert.equal(replay.status, 401);
    const headers = { authorization: `Bearer ${session.bridge_session_token}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
    const challenge = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(challenge.status, 201);
    const revoked = await fetch(`http://127.0.0.1:${port}/v1/bridge/revoke`, { method: "POST", headers, body: "{}" });
    assert.equal(revoked.status, 200);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: "CHATGPT_ASSESSMENT", issue_id: issue.issue_id, candidate_id: null, candidate_commit: null }) });
    assert.equal(denied.status, 401);
    assert.equal(store.listBridgeClients()[0].revoked_at !== null, true);
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); store.close(); }
});

test("external-read real startup binds the frozen Task Package and performs exactly six atomic receipt upserts", async () => {
  const frozenProjectId = "ca40511be3ae12112101cc1de6059b95";
  const value = assessmentSealFixture("b3274782-30a0-44a1-a05e-01730678da8b", frozenProjectId);
  const source = sealSourceIdentityFixture();
  const busToken = "external-read-bus-token-1234567890-abcdef";
  let running = null;
  try {
    value.normalService.submitAssessment(value.target.issueId, "codex", codexAssessment, new Date("2026-09-04T04:00:00.000Z"));
    const current = value.normalService.requireIssue(value.target.issueId);
    const events = value.normalStore.events(value.target.issueId);
    const pendingIssues = [
      { issueId: current.issue_id, state: current.state, entityVersion: current.entity_version, contentHash: current.content_hash },
      { issueId: "FILMOS-ISSUE-final-build-id-binding-v8-20260901", state: "DUAL_APPROVED", entityVersion: 152, contentHash: "5278980ffb26addeedb2edbb4e57b556ff52e26427a15b0cfb41754347f68e14" },
      { issueId: "FILMOS-ISSUE-final-candidate-intake-v7-20260901", state: "DUAL_APPROVED", entityVersion: 155, contentHash: "febda7810c50c617d707ac2cc2c9d389a4b2ffe13655737ed7ebb6e9245b98c1" },
      { issueId: "FILMOS-ISSUE-final-project-scope-v5-20260901", state: "EVIDENCE_FROZEN", entityVersion: 144, contentHash: "a3e5bba0f239209e2ed6755685a7797af886300ad4a1f74272de05fe9a93a4a8" },
      { issueId: "FILMOS-ISSUE-final-project-scope-v6-20260901", state: "TASK_PACKAGE_FROZEN", entityVersion: 1504, contentHash: "e48be830be33c0662a094a99b38903d0db793798ebd99b6ff5ebb13aa43d14b6" },
    ].sort((left, right) => left.issueId.localeCompare(right.issueId));
    const insertProjection = value.normalStore.db.prepare(`INSERT INTO review_projections(issue_id,project_id,state,lane,entity_version,document_json,content_hash,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const pending of pendingIssues.filter((issue) => issue.issueId !== current.issue_id)) {
      const document = structuredClone(current);
      document.issue_id = pending.issueId;
      document.submission_id = null;
      document.state = pending.state;
      document.lane = "core";
      document.entity_version = pending.entityVersion;
      document.content_hash = pending.contentHash;
      document.updated_at = "2026-09-04T04:01:00.000Z";
      document.build_lineage_task_package_hash = taskHash;
      document.issue_task_package = pending.state === "TASK_PACKAGE_FROZEN" ? { contentHash: taskHash } : null;
      document.task_package_content_hash = pending.state === "TASK_PACKAGE_FROZEN" ? taskHash : null;
      insertProjection.run(
        pending.issueId,
        frozenProjectId,
        pending.state,
        document.lane,
        pending.entityVersion,
        JSON.stringify(document),
        pending.contentHash,
        document.updated_at,
      );
    }
    const receiptRows = [
      ...pendingIssues.map((issue) => ({ issueId: issue.issueId, toolName: "issue_list_pending", projectionContentHash: issue.contentHash })),
      { issueId: current.issue_id, toolName: "issue_get_evidence", projectionContentHash: current.content_hash },
    ];
    const evidenceHash = current.evidence.manifest.contentHash;
    const insertReceipt = value.normalStore.db.prepare(`INSERT INTO review_read_receipts(issue_id,project_id,consumer,tool_name,projection_content_hash,evidence_manifest_hash,read_at)
      VALUES(?,?,?,?,?,?,?)`);
    for (const receipt of receiptRows) insertReceipt.run(
      receipt.issueId,
      frozenProjectId,
      "chatgpt-mcp",
      receipt.toolName,
      receipt.projectionContentHash,
      evidenceHash,
      "2026-09-04T03:59:00.000Z",
    );
    const receiptKeyLines = receiptRows
      .map((receipt) => `${receipt.issueId}|chatgpt-mcp|${receipt.toolName}`)
      .sort()
      .join("\n") + "\n";
    const pendingLines = pendingIssues.map((issue) => `${issue.issueId}|${issue.state}|${issue.entityVersion}|${issue.contentHash}`).join("\n") + "\n";
    const projectionsBefore = value.normalStore.db.prepare("SELECT issue_id,state,entity_version,content_hash,document_json FROM review_projections ORDER BY issue_id").all();
    const eventsBefore = value.normalStore.db.prepare("SELECT sequence,event_id,issue_id,event_hash,payload_json FROM review_events ORDER BY sequence").all();
    const receiptsBefore = value.normalStore.db.prepare("SELECT * FROM review_read_receipts ORDER BY issue_id,consumer,tool_name").all();
    const physical = prepareReviewBusSealBinding(value.databasePath, value.target);
    const policy = {
      projectId: frozenProjectId,
      targetIssueId: current.issue_id,
      targetEntityVersion: current.entity_version,
      targetProjectionHash: current.content_hash,
      targetIssueEventCount: events.length,
      targetLastEventSequence: events.at(-1).sequence,
      targetLastEventHash: events.at(-1).event_hash,
      pendingSummarySha256: createHash("sha256").update(pendingLines).digest("hex"),
      pendingIssues,
      readReceiptRowCount: 6,
      readReceiptKeysSha256: createHash("sha256").update(receiptKeyLines).digest("hex"),
      databaseIdentity: {
        device: physical.device,
        inode: physical.inode,
        size: physical.size,
        sha256: physical.sha256,
        wal: { device: physical.walDevice, inode: physical.walInode, size: physical.walSize, sha256: physical.walSha256 },
        shm: { device: physical.shmDevice, inode: physical.shmInode, size: physical.shmSize, sha256: physical.shmSha256 },
      },
    };
    writeFileSync(resolve(value.directory, "review-bus.token"), `${busToken}\n`, { mode: 0o600 });
    const env = {
      FILMOS_REVIEW_BUS_RUNTIME_MODE: REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ,
      FILMOS_REVIEW_BUS_LOCAL_DIR: value.directory,
      FILMOS_REVIEW_BUS_HOST: "127.0.0.1",
      FILMOS_REVIEW_BUS_PORT: "0",
      ...source.env,
    };
    running = startFromEnvironment(env, {
      externalReadTestOnly: {
        enabled: true,
        canonicalDatabase: value.databasePath,
        expectedSourceRoot: source.repository,
        sealTarget: value.target,
        sealBinding: value.binding,
        externalReadPolicy: policy,
        port: 0,
      },
    });
    await new Promise((resolvePromise, reject) => {
      running.server.once("listening", resolvePromise);
      running.server.once("error", reject);
    });
    assert.equal(running.runtimeMode, REVIEW_BUS_RUNTIME_MODE_EXTERNAL_READ);
    assert.equal(running.service.taskPackageContentHash, taskHash);
    assert.equal(running.service.requireIssue("FILMOS-ISSUE-final-project-scope-v6-20260901").task_package_content_hash, taskHash);
    const baseURL = `http://127.0.0.1:${running.server.address().port}`;
    const headers = { authorization: `Bearer ${busToken}`, "x-filmos-read-consumer": "chatgpt-mcp" };
    const health = await (await fetch(`${baseURL}/healthz`)).json();
    assert.equal(health.read_receipt_operation_count, 0);
    assert.equal(health.read_receipt_row_count, 6);
    assert.equal(health.read_receipt_keys_sha256, policy.readReceiptKeysSha256);

    const first = pendingIssues[0];
    assert.throws(() => running.store.recordReadReceipts([
      {
        issueId: first.issueId,
        projectId: frozenProjectId,
        consumer: "chatgpt-mcp",
        toolName: "issue_list_pending",
        projectionContentHash: first.contentHash,
        now: new Date("2026-09-04T04:02:00.000Z"),
      },
      {
        issueId: pendingIssues[1].issueId,
        projectId: frozenProjectId,
        consumer: "chatgpt-mcp",
        toolName: "issue_list_pending",
        projectionContentHash: "0".repeat(64),
        now: new Date("2026-09-04T04:02:00.000Z"),
      },
    ]), (error) => error.code === "EXTERNAL_READ_RUNTIME_WRITE_DENIED");
    assert.deepEqual(running.store.db.prepare("SELECT * FROM review_read_receipts ORDER BY issue_id,consumer,tool_name").all(), receiptsBefore);
    assert.equal(running.store.externalReadOperationCount(), 0);

    const pending = await fetch(`${baseURL}/v1/review/pending?project_id=${frozenProjectId}`, { headers });
    assert.equal(pending.status, 200);
    assert.deepEqual((await pending.json()).issues.map((issue) => issue.issue_id).sort(), pendingIssues.map((issue) => issue.issueId));
    assert.equal(running.store.externalReadOperationCount(), 5);
    const blind = await fetch(`${baseURL}/v1/review/issues/${current.issue_id}/codex-assessment-blind?project_id=${frozenProjectId}`, { headers });
    assert.equal(blind.status, 200);
    assert.equal((await blind.json()).counterpart_sealed, true);
    const evidence = await fetch(`${baseURL}/v1/review/issues/${current.issue_id}/evidence?project_id=${frozenProjectId}`, { headers });
    assert.equal(evidence.status, 200);
    const constitutionRead = await fetch(`${baseURL}/v1/review/constitution?project_id=${frozenProjectId}`, { headers });
    assert.equal(constitutionRead.status, 200);
    assert.equal(running.store.externalReadOperationCount(), 6);
    assert.equal(running.store.externalReadReceiptState().rowCount, 6);
    assert.equal(running.store.db.prepare("SELECT COUNT(*) AS count FROM review_read_receipts").get().count, 6);
    const receiptsAfter = running.store.db.prepare("SELECT * FROM review_read_receipts ORDER BY issue_id,consumer,tool_name").all();
    assert.equal(receiptsAfter.length, 6);
    for (const issue of pendingIssues) {
      const receipt = receiptsAfter.find((row) => row.issue_id === issue.issueId && row.tool_name === "issue_list_pending");
      assert.equal(receipt.projection_content_hash, issue.contentHash);
      assert.notEqual(receipt.read_at, "2026-09-04T03:59:00.000Z");
    }
    const evidenceReceipt = receiptsAfter.find((row) => row.issue_id === current.issue_id && row.tool_name === "issue_get_evidence");
    assert.equal(evidenceReceipt.projection_content_hash, current.content_hash);
    assert.equal(evidenceReceipt.evidence_manifest_hash, evidenceHash);
    assert.notEqual(evidenceReceipt.read_at, "2026-09-04T03:59:00.000Z");
    assert.deepEqual(running.store.db.prepare("SELECT issue_id,state,entity_version,content_hash,document_json FROM review_projections ORDER BY issue_id").all(), projectionsBefore);
    assert.deepEqual(running.store.db.prepare("SELECT sequence,event_id,issue_id,event_hash,payload_json FROM review_events ORDER BY sequence").all(), eventsBefore);

    const duplicate = await fetch(`${baseURL}/v1/review/pending?project_id=${frozenProjectId}`, { headers });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, "EXTERNAL_READ_RUNTIME_WRITE_BUDGET_EXCEEDED");
    const finalHealth = await (await fetch(`${baseURL}/healthz`)).json();
    assert.equal(finalHealth.read_receipt_operation_count, 6);
    assert.equal(finalHealth.read_receipt_row_count, 6);
    const denied = await fetch(`${baseURL}/v1/review/pending`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{" });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).code, "EXTERNAL_READ_RUNTIME_ROUTE_DENIED");
    assert.throws(() => running.store.db.prepare("UPDATE review_projections SET state = state").run(), /not authorized/i);
  } finally {
    if (running) {
      await new Promise((resolvePromise) => running.server.close(resolvePromise));
      running.store.close();
    }
    value.normalStore.close();
    rmSync(value.directory, { recursive: true, force: true });
    rmSync(source.directory, { recursive: true, force: true });
  }
});

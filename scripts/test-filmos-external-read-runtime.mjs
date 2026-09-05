import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  EXTERNAL_TOOL_ORDER,
  FIXED_REVIEW_CONVERSATION_ID,
  PHASE7,
  RUNNER_DIRECT_TRANSIENT_ORDER,
  SOURCE_ROOT,
  TRANSIENT_PROCESS_BUDGET,
  WIDGET_PREBUILD_LINK_NAMES,
  assertProductionPreserved,
  assertReviewBusFailurePreserved,
  assertReviewBusHealth,
  cleanupOwned,
  assertSourceIndependentPath,
  bindLiveContext,
  bindPhase6Package,
  canonicalJSON,
  canonicalize,
  failureReceipt,
  isExecutedAsMain,
  issueGrantWithStore,
  liveContextReceipt,
  parsePreferencePlistXML,
  parseRpcBody,
  prepareExternalResponse,
  scanRuntimeSecrets,
  sha256,
  transientExecutableSpec,
  validateAuditRecords,
  validateExternalResponse,
  validateExternalConversationBinding,
  deriveNestedProcessBudget,
  validatePreferenceSnapshot,
  validateTransientRecords,
  verifyPostCleanupProcessBoundary,
  verifyTunnelPayloadDirectory,
} from "./filmos-external-read-runtime.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-09-05T01:02:03.000Z";

const REVIEW_BUS_BOUNDARY_PROJECTIONS = [
  { issue_id: PHASE7.issueId, state: "ARCHITECTURE_ASSESSMENTS_PENDING", entity_version: 125, content_hash: "ba7b958f555d723bc0c4a679f3b5d104435015af4f5b53c0833aa1c180f04cae", evidence_manifest_hash: "cca8331baaf96741f1faff37d739393919996c04379b1ca83ff090375abe0d76", last_event_sequence: 12988, last_event_hash: "8650686aced0251fa8452164ed0cd5e649a17549a7cb2f73f13bdfda27aa47e7" },
  { issue_id: "FILMOS-ISSUE-final-build-id-binding-v8-20260901", state: "DUAL_APPROVED", entity_version: 152, content_hash: "5278980ffb26addeedb2edbb4e57b556ff52e26427a15b0cfb41754347f68e14", evidence_manifest_hash: "77159c792ad1044a6d8d94d4e25cc5f791667f67d5f05759864f792e43468fa9", last_event_sequence: 12978, last_event_hash: HASH_A },
  { issue_id: "FILMOS-ISSUE-final-candidate-intake-v7-20260901", state: "DUAL_APPROVED", entity_version: 155, content_hash: "febda7810c50c617d707ac2cc2c9d389a4b2ffe13655737ed7ebb6e9245b98c1", evidence_manifest_hash: "fb5ec1f15d6b176504cdbad065b0de58a7ebdecbe993ea28ae338ddcd6d1bf0d", last_event_sequence: 12981, last_event_hash: HASH_A },
  { issue_id: "FILMOS-ISSUE-final-project-scope-v5-20260901", state: "EVIDENCE_FROZEN", entity_version: 144, content_hash: "a3e5bba0f239209e2ed6755685a7797af886300ad4a1f74272de05fe9a93a4a8", evidence_manifest_hash: "474ec9d2191fb008095d63b8ad4dd842851d38a91a3f59934d2d28b7c63f171e", last_event_sequence: 12977, last_event_hash: HASH_A },
  { issue_id: "FILMOS-ISSUE-final-project-scope-v6-20260901", state: "TASK_PACKAGE_FROZEN", entity_version: 1504, content_hash: "e48be830be33c0662a094a99b38903d0db793798ebd99b6ff5ebb13aa43d14b6", evidence_manifest_hash: "d3d881b47d37da77253af29b5921af8d78c3c54da42338e62d21f09613765cbc", last_event_sequence: 12980, last_event_hash: HASH_A },
];

function validReviewBusFailureBoundary() {
  const projections = REVIEW_BUS_BOUNDARY_PROJECTIONS.map((item) => ({
    issue_id: item.issue_id,
    project_id: PHASE7.projectId,
    state: item.state,
    lane: item.issue_id === PHASE7.issueId ? "architecture" : "core",
    entity_version: item.entity_version,
    content_hash: item.content_hash,
    document_sha256: HASH_A,
    document_content_hash: item.content_hash,
    evidence_manifest_hash: item.evidence_manifest_hash,
    codex_slot: item.issue_id === PHASE7.issueId ? "SEALED" : null,
    chatgpt_slot: item.issue_id === PHASE7.issueId ? "EMPTY" : null,
  }));
  const events = REVIEW_BUS_BOUNDARY_PROJECTIONS.map((item) => ({
    issue_id: item.issue_id,
    event_count: item.entity_version,
    last_event_sequence: item.last_event_sequence,
    last_event_hash: item.last_event_hash,
  }));
  const receipts = [
    ...REVIEW_BUS_BOUNDARY_PROJECTIONS.map((item) => ({
      issue_id: item.issue_id,
      project_id: PHASE7.projectId,
      consumer: "chatgpt-mcp",
      tool_name: "issue_list_pending",
      projection_content_hash: item.content_hash,
      evidence_manifest_hash: item.evidence_manifest_hash,
      read_at: NOW,
    })),
    {
      issue_id: PHASE7.issueId,
      project_id: PHASE7.projectId,
      consumer: "chatgpt-mcp",
      tool_name: "issue_get_evidence",
      projection_content_hash: REVIEW_BUS_BOUNDARY_PROJECTIONS[0].content_hash,
      evidence_manifest_hash: REVIEW_BUS_BOUNDARY_PROJECTIONS[0].evidence_manifest_hash,
      read_at: NOW,
    },
  ].sort((left, right) => `${left.issue_id}|${left.consumer}|${left.tool_name}`.localeCompare(`${right.issue_id}|${right.consumer}|${right.tool_name}`));
  const receiptKeyLines = receipts.map((row) => `${row.issue_id}|${row.consumer}|${row.tool_name}`).join("\n") + "\n";
  return {
    schema_version: "filmos.phase7.review-bus-failure-boundary.v1",
    project_id: PHASE7.projectId,
    non_receipt_tables_sha256: HASH_A,
    non_receipt_table_row_counts: { review_events: events.reduce((sum, item) => sum + item.event_count, 0), review_projections: 5 },
    projection_rows_sha256: HASH_A,
    event_rows_sha256: HASH_A,
    project_projection_count: 5,
    project_event_count: events.reduce((sum, item) => sum + item.event_count, 0),
    projection_summaries: projections,
    event_summaries: events,
    read_receipt_row_count: 6,
    read_receipt_keys_sha256: sha256(receiptKeyLines),
    read_receipt_rows: receipts,
  };
}

function processBoundary(survivorPids = [], { cloudflared = false } = {}) {
  return {
    schema_version: "filmos.phase7.post-cleanup-process-boundary.v1",
    audit_complete: true,
    boundary_verified: survivorPids.length === 0,
    tracked_pid_count: 4,
    tracked_pid_survivors: survivorPids,
    conditional_cloudflared_survivor_pids: cloudflared ? survivorPids : [],
    runtime_root_reference_pids: survivorPids,
    runtime_root_or_reserved_port_open_pids: survivorPids,
    survivor_pids: survivorPids,
  };
}

function successfulCleanupResult(attempt) {
  return {
    attempt,
    boundary_verified: true,
    error_codes: [],
    authorization_header_absent: true,
    grant_revoked: true,
    survivor_pids: [],
    purged_secret_paths: [],
    residual_secret_paths: [],
  };
}

function sourceIdentity() {
  return {
    schema_version: "1.0.0",
    build_id: "development-12345678-abcdef12",
    git_commit_sha: "1".repeat(40),
    git_tree_sha: "2".repeat(40),
    source_fingerprint_sha256: "3".repeat(64),
    source_clean: true,
    release_channel: "development",
    source_file_count: 42,
  };
}

function binding() {
  return {
    project_id: PHASE7.projectId,
    project_grant_id: "grant_phase7_test",
    project_grant_issued_at: "2026-09-05T01:00:00.000Z",
    project_grant_expires_at: "2026-09-05T02:00:00.000Z",
    challenge_id: "live_phase7_test_challenge",
    context_receipt_id: "filmos-live:" + HASH_A,
    live_context_expires_at: "2026-09-05T01:05:00.000Z",
    content_unit_id: PHASE7.contentUnitId,
    canvas_id: PHASE7.canvasId,
    canvas_state_hash: PHASE7.canvasStateHash,
  };
}

function validExternalResponse() {
  const hosts = [
    "chatgpt_subscription_image_host",
    "google_ai_studio_subscription_image_host",
    "gemini_subscription_image_host",
  ];
  const option = (name) => ({
    option: name,
    summary: `Evidence-backed option ${name}`,
    reused_authorities: ["Canonical Production Tool Broker"],
    minimal_new_components: ["Subscription Host Adapter"],
    source_layers: ["Generation provider adapter layer"],
    new_service_count: 0,
    new_storage_count: 0,
    new_authority_count: 0,
    security_and_compliance_risks: ["Host session expiry"],
    idempotency_and_recovery: ["Output hash prevents duplicate return"],
    test_method: ["One controlled vertical canary"],
    replaced_or_deleted_duplicate_logic: ["Reuse the canonical broker"],
    single_production_chain_preserved: true,
  });
  return {
    product_goal_fit: true,
    root_cause: "Subscription hosts are not yet represented by a canonical adapter.",
    root_cause_explains_symptom: true,
    authority_risk: false,
    resolution_layer: "Provider adapter boundary",
    workflow_impact: "Adds a hosted execution route without changing candidate authority.",
    acceptance_gates: ["Future user-authorized controlled canary"],
    scope_drift: false,
    problem_statement: "Reuse subscriptions while preserving the existing production chain.",
    existing_authorities: ["Canonical Production Tool Broker"],
    current_architecture_map: ["Canvas to Composer to Broker to Candidate"],
    host_capability_matrix: hosts.map((host) => ({
      host,
      model_catalog: "REQUIRES_CONTROLLED_CANARY",
      text_to_image: "REQUIRES_CONTROLLED_CANARY",
      reference_image_or_edit: "REQUIRES_CONTROLLED_CANARY",
      result_return: "REQUIRES_CONTROLLED_CANARY",
      maximum_supported_silence_level: "REQUIRES_CONTROLLED_CANARY",
      security_and_compliance_risks: ["Session and account boundary"],
    })),
    architecture_options: [option("A"), option("B")],
    recommended_option: "A",
    recommended_first_vertical_canary: {
      host: hosts[0],
      scope: [
        "1 Project", "1 ContentUnit", "1 Canvas", "1 Image Node", "1 Subscription Host", "1 explicit model",
        "1 generation request", "1 candidate result set", "Asset Version", "Formal Candidate", "QC Pending", "Canvas refresh",
      ],
      requires_future_user_generation_authorization: true,
      reason: "It is the narrowest observable first path.",
    },
    security_and_compliance: ["Never persist subscription credentials in FilmOS"],
    state_machine: ["Prepared to submitted to returned to QC pending"],
    idempotency_and_recovery: ["Bind request and output hashes"],
    result_return_contract: ["Stage immutable output before Asset Version"],
    candidate_and_qc_contract: ["Provider success remains QC Pending"],
    source_impact_map: ["Adapter registry and orchestration only"],
    new_service_count: 0,
    new_storage_count: 0,
    new_authority_count: 0,
    reuse_and_deletion_plan: ["Delete duplicate host-specific return logic"],
    evidence_gaps: ["Host silence level needs a controlled canary"],
    open_questions: [],
    explicit_non_goals: ["Gemini as agent brain"],
  };
}

function validBlockedResponse() {
  return {
    assessment_status: "BLOCKED",
    blocker_code: "LIVE_CONTEXT_EXPIRED",
    failed_or_unobservable_call: "filmos_get_live_workbench_context",
    completed_filmos_call_count: 5,
    platform_schema_discovery_call_count: 1,
    blindness_preserved: true,
    assessment_generated: false,
  };
}

function transientRecords(parentPid = 4321) {
  return RUNNER_DIRECT_TRANSIENT_ORDER.flatMap((label, offset) => {
    const index = offset + 1;
    const sensitive = label === "keychain-secret-once";
    const executable = transientExecutableSpec(label);
    return [{
      schema_version: "filmos.phase7.transient-process.v1",
      phase: "start",
      invocation_index: index,
      parent_pid: parentPid,
      label,
      started_at: NOW,
      executable: executable.path,
      executable_sha256: executable.sha256,
      argv: [],
      cwd: "/tmp",
      sensitive_output: sensitive,
    }, {
      schema_version: "filmos.phase7.transient-process.v1",
      phase: "exit",
      invocation_index: index,
      parent_pid: parentPid,
      label,
      exited_at: NOW,
      pid: 5000 + index,
      status: label.startsWith("lsof-") ? 1 : 0,
      signal: null,
      timed_out: false,
      stdout_bytes: sensitive ? "SUPPRESSED" : 0,
      stderr_bytes: sensitive ? "SUPPRESSED" : 0,
      stdout_sha256: sensitive ? null : sha256(Buffer.alloc(0)),
      stderr_sha256: sensitive ? null : sha256(Buffer.alloc(0)),
    }];
  });
}

test("isolated Widget prebuild links close ext-apps, SDK and zod before bundling", async () => {
  assert.deepEqual(WIDGET_PREBUILD_LINK_NAMES, ["esbuild", "@modelcontextprotocol", "zod"]);

  const runnerSource = await readFile(resolve(SOURCE_ROOT, "scripts/filmos-external-read-runtime.mjs"), "utf8");
  const prebuildLoop = runnerSource.indexOf("for (const name of WIDGET_PREBUILD_LINK_NAMES)");
  const widgetBuild = runnerSource.indexOf('label: "widget-generated-input"');
  const postbuildLinks = runnerSource.indexOf("const sourceLinks = [", widgetBuild);
  const linkCountGuard = runnerSource.indexOf("invariant(compileLinks.length === 6", postbuildLinks);
  assert.ok(prebuildLoop >= 0 && prebuildLoop < widgetBuild);
  assert.ok(widgetBuild < postbuildLinks && postbuildLinks < linkCountGuard);

  const prebuildBlock = runnerSource.slice(prebuildLoop, widgetBuild);
  assert.match(prebuildBlock, /resolve\(chatSource, "node_modules", name\)/);
  assert.match(prebuildBlock, /resolve\(sourceNodeModules, name\)/);
  const postbuildBlock = runnerSource.slice(postbuildLinks, linkCountGuard);
  assert.match(postbuildBlock, /\["@filmos\/tool-contracts", contractOutput\]/);
  assert.match(postbuildBlock, /\["express", resolve\(sourceNodeModules, "express"\)\]/);
  assert.match(postbuildBlock, /\["@types", resolve\(sourceNodeModules, "@types"\)\]/);
  assert.doesNotMatch(postbuildBlock, /"@modelcontextprotocol"|"zod"/);

  const sourceNodeModules = resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules");
  const packageVersion = async (...segments) => JSON.parse(
    await readFile(resolve(sourceNodeModules, ...segments, "package.json"), "utf8"),
  ).version;
  assert.equal(await packageVersion("esbuild"), "0.25.10");
  assert.equal(await packageVersion("@modelcontextprotocol", "ext-apps"), "1.7.5");
  assert.equal(await packageVersion("@modelcontextprotocol", "sdk"), "1.30.0");
  assert.equal(await packageVersion("zod"), "3.25.76");
  for (const path of ["v3/index.js", "v4/index.js", "v4-mini/index.js"]) {
    assert.equal(await realpath(resolve(sourceNodeModules, "zod", path)), resolve(sourceNodeModules, "zod", path));
  }

  const widgetSource = await readFile(resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/src/widget-runtime.ts"), "utf8");
  const extAppsSource = await readFile(resolve(sourceNodeModules, "@modelcontextprotocol/ext-apps/dist/src/app.js"), "utf8");
  const sdkTypesSource = await readFile(resolve(sourceNodeModules, "@modelcontextprotocol/sdk/dist/esm/types.js"), "utf8");
  assert.match(widgetSource, /from "@modelcontextprotocol\/ext-apps"/);
  assert.match(extAppsSource, /@modelcontextprotocol\/sdk\/shared\/protocol\.js/);
  assert.match(extAppsSource, /from"zod\/v4"/);
  assert.match(sdkTypesSource, /from 'zod\/v4'/);
});

test("canonical JSON and live receipt use stable sorted-key hashing", () => {
  assert.deepEqual(canonicalize({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 2, a: 1 }] }), {
    a: { x: 3, y: 2 }, list: [{ a: 1, b: 2 }], z: 1,
  });
  assert.equal(canonicalJSON({ b: 2, a: 1 }), '{"a":1,"b":2}');
  const raw = { project_id: PHASE7.projectId, context_receipt_id: "ignored", content_unit_kind: "ignored", z: 1, a: 2 };
  assert.equal(liveContextReceipt(raw), "filmos-live:" + sha256('{"a":2,"project_id":"ca40511be3ae12112101cc1de6059b95","z":1}'));
});

test("live context binds exact saved canvas, current Film Core ref and current source", () => {
  const saved = {
    project_id: PHASE7.projectId,
    content_unit_id: PHASE7.contentUnitId,
    content_unit_kind: "scene",
    canvas_id: PHASE7.canvasId,
    canvas_state_hash: PHASE7.canvasStateHash,
  };
  const source = sourceIdentity();
  const value = bindLiveContext(saved, source, { film_project: { ref: { version: 7, content_hash: HASH_B } } });
  assert.equal(value.film_expected_version, 7);
  assert.equal(value.film_content_hash, HASH_B);
  assert.deepEqual(value.source_identity, source);
  assert.equal(value.context_receipt_id, liveContextReceipt(value));
  assert.equal("content_unit_kind" in value, false);
  assert.equal(saved.content_unit_kind, "scene");
  assert.throws(() => bindLiveContext({ ...saved, canvas_id: "wrong" }, source, { film_project: { ref: { version: 7, content_hash: HASH_B } } }), /LIVE_CONTEXT_SAVED_BINDING_DRIFT/);
});

test("preference plist parser decodes all three saved bindings and rejects drift", () => {
  const connection = { autoConnect: true, tunnelID: PHASE7.tunnelId, connectionID: PHASE7.connectionId };
  const session = { projectID: PHASE7.projectId, canvasID: PHASE7.canvasId };
  const context = { project_id: PHASE7.projectId, content_unit_id: PHASE7.contentUnitId, canvas_id: PHASE7.canvasId, canvas_state_hash: PHASE7.canvasStateHash };
  const saved = { projectID: PHASE7.projectId, context: Buffer.from(JSON.stringify(context)).toString("base64") };
  const entry = (key, value) => `<key>${key}</key><data>${Buffer.from(JSON.stringify(value)).toString("base64")}</data>`;
  const xml = `<plist><dict>${entry("filmos.chatgpt.host.connection.v2", connection)}${entry("filmos.chatgpt.host.project-session.v2", session)}${entry("filmos.chatgpt.host.workbench-context.v1", saved)}</dict></plist>`;
  const parsed = parsePreferencePlistXML(xml);
  assert.deepEqual(validatePreferenceSnapshot(parsed), { connection, session, context });
  parsed["filmos.chatgpt.host.project-session.v2"].canvasID = "wrong";
  assert.throws(() => validatePreferenceSnapshot(parsed), /SAVED_PROJECT_SESSION_DRIFT/);
});

test("Phase 6 binding replaces exactly twelve JIT tokens and four current-source constants without changing the template", async () => {
  const template = await readFile(PHASE7.templatePath, "utf8");
  assert.equal(sha256(template), PHASE7.templateSha256);
  const source = sourceIdentity();
  const result = bindPhase6Package(template, binding(), source);
  assert.equal(Object.keys(result.placeholderValues).length, 12);
  assert.equal(result.sourceReplacements.length, 4);
  assert.equal(result.sourceReplacements.reduce((sum, item) => sum + item.occurrence_count, 0), 5);
  assert.doesNotMatch(result.output, /<JIT_[A-Z0-9_]+>/);
  for (const oldValue of Object.values(PHASE7.legacySource)) assert.equal(result.output.includes(oldValue), false);
  assert.match(result.output, new RegExp(source.git_commit_sha));
  assert.match(result.output, /ee8aac7d044fce067487b18a82b4eaf9c7b4c9f5/);
  assert.match(result.output, /964f590a52c75c40b878a869742b5f37631efeb2/);
  assert.equal(await readFile(PHASE7.templatePath, "utf8"), template);
  assert.throws(() => bindPhase6Package(template.replace("<JIT_CANVAS_ID>", "missing"), binding(), source), /PHASE6_PLACEHOLDER_COUNT_MISMATCH:JIT_CANVAS_ID/);
});

test("RPC parser accepts strict JSON and SSE data while rejecting malformed input", () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":1}'), { jsonrpc: "2.0", id: 1 });
  assert.deepEqual(parseRpcBody('event: message\ndata: {"first":1}\n\ndata: {"last":2}\n'), { last: 2 });
  assert.equal(parseRpcBody("  \n"), null);
  assert.throws(() => parseRpcBody("not-json"), /RPC_BODY_UNRECOGNIZED/);
});

test("external response validator enforces the complete success and BLOCKED contracts", () => {
  const value = validExternalResponse();
  assert.equal(validateExternalResponse(JSON.stringify(value)).kind, "SUCCESS");
  assert.throws(() => validateExternalResponse({ ...value, extra: true }), /SUCCESS_RESPONSE_SCHEMA_MISMATCH/);
  assert.throws(() => validateExternalResponse({ ...value, root_cause: "EVIDENCE_DERIVED_STRING" }), /ASSESSMENT_TEMPLATE_TOKEN_REMAINS/);
  assert.throws(() => validateExternalResponse({ ...value, recommended_option: "C" }), /RECOMMENDED_OPTION_NOT_DECLARED/);
  const blocked = validBlockedResponse();
  assert.equal(validateExternalResponse(blocked).kind, "BLOCKED");
  assert.throws(() => validateExternalResponse({ ...blocked, completed_filmos_call_count: 8 }), /BLOCKED_FILMOS_CALL_COUNT_INVALID/);
});

test("external completion must use a conversation distinct from the fixed review conversation", () => {
  assert.throws(
    () => validateExternalConversationBinding({
      external_conversation_id: FIXED_REVIEW_CONVERSATION_ID,
      external_message_count: 1,
    }),
    /EXTERNAL_CONVERSATION_MUST_DIFFER_FROM_FIXED_REVIEW/,
  );
  assert.equal(
    validateExternalConversationBinding({
      external_conversation_id: "phase7-external-assessment-01",
      external_message_count: 1,
    }),
    "phase7-external-assessment-01",
  );
});

test("Review Bus health validator freezes the complete Phase 7 target and receipt identity", () => {
  const source = { branch: "integration", head: "1".repeat(40), tree: "2".repeat(40) };
  const identity = {
    schema_version: "1.0.0",
    build_id: "development-11111111-33333333",
    release_channel: "development",
    repository: "maiyadiu/filmos-studio",
    git_commit_sha: source.head,
    git_tree_sha: source.tree,
    source_fingerprint_sha256: "3".repeat(64),
    source_file_count: 42,
    source_clean: true,
    external_paid_submit_enabled: false,
  };
  const installedIdentityHash = sha256(canonicalJSON({
    schema_version: "filmos.installed-source-identity.v1",
    source_identity_schema: identity.schema_version,
    internal_runtime_schema: 4,
    build_id: identity.build_id,
    release_channel: identity.release_channel,
    repository: identity.repository,
    commit: identity.git_commit_sha,
    tree: identity.git_tree_sha,
    source_fingerprint_sha256: identity.source_fingerprint_sha256,
    source_file_count: identity.source_file_count,
    source_clean: identity.source_clean,
    external_paid_submit_enabled: identity.external_paid_submit_enabled,
  }));
  const health = {
    runtime_mode: "external-read",
    constitution_version: "1.1.0",
    constitution_content_hash: "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41",
    source_identity: {
      status: "VERIFIED",
      source_root: SOURCE_ROOT,
      branch: source.branch,
      commit: source.head,
      tree: source.tree,
      source_fingerprint_sha256: identity.source_fingerprint_sha256,
      content_hash: installedIdentityHash,
    },
    target: {
      project_id: PHASE7.projectId,
      issue_id: PHASE7.issueId,
      state: "ARCHITECTURE_ASSESSMENTS_PENDING",
      entity_version: 125,
      projection_content_hash: "ba7b958f555d723bc0c4a679f3b5d104435015af4f5b53c0833aa1c180f04cae",
      issue_event_count: 125,
      last_event_sequence: 12988,
      last_event_hash: "8650686aced0251fa8452164ed0cd5e649a17549a7cb2f73f13bdfda27aa47e7",
      codex_slot: "SEALED",
      chatgpt_slot: "EMPTY",
    },
    pending_issue_count: 5,
    pending_summary_sha256: "d6ac890757b44e57e93f093506a819f6ade90d1ee7f9af91057f8b58f7d29361",
    read_receipt_operation_count: 0,
    read_receipt_operation_limit: 6,
    read_receipt_row_count: 6,
    read_receipt_keys_sha256: "46a037f9500d7fb637dac87050f5bb611b693ab9ca136e16362e47980d335efc",
    current_seal_state: "CODEX_SEALED_SUCCESSOR",
  };
  assert.equal(assertReviewBusHealth(health, source, identity, 0), health);
  assert.throws(
    () => assertReviewBusHealth({ ...health, read_receipt_row_count: 7 }, source, identity, 0),
    /REVIEW_BUS_RECEIPT_OR_SEAL_DRIFT/,
  );
});

test("Grant cleanup ownership is installed before validation and header-write failures", async () => {
  const buildCase = async ({ invalidRecords = false, headerFailure = false, afterHeaderFailure = false }) => {
    const issued = {
      token: "fg_phase7_test_secret_1234567890",
      grant: {
        grant_id: "grant-phase7-test",
        token_hash: sha256("fg_phase7_test_secret_1234567890"),
        revoked_at: null,
      },
    };
    const records = [{ ...issued.grant }];
    const store = {
      async issue() { return structuredClone(issued); },
      async revoke() { records[0].revoked_at = NOW; },
    };
    const state = {
      children: [],
      grant: null,
      secrets: { runtimeKey: "runtime-secret", proof: "proof-secret", grantToken: "" },
    };
    let headerPresent = false;
    await assert.rejects(
      () => issueGrantWithStore({
        store,
        state,
        grantsPath: "/tmp/grants.json",
        headerPath: "/tmp/mcp-authorization.header",
        readRecords: async () => invalidRecords ? [{ ...records[0], token_hash: HASH_A }] : records,
        writeAuthorizationHeader: async () => {
          if (headerFailure) throw new Error("HEADER_CREATE_FAILED");
          headerPresent = true;
        },
        hooks: {
          afterHeader: async () => {
            if (afterHeaderFailure) throw new Error("POST_HEADER_INTERRUPTED");
          },
        },
      }),
      invalidRecords
        ? /ISOLATED_GRANT_STORE_MISMATCH/
        : (headerFailure ? /HEADER_CREATE_FAILED/ : /POST_HEADER_INTERRUPTED/),
    );
    assert.equal(state.grant.issued.grant.grant_id, issued.grant.grant_id);
    assert.equal(state.secrets.grantToken, issued.token);
    const cleanup = await cleanupOwned(state, {
      operations: {
        revokeGrant: async (grant) => { await store.revoke(grant.issued.grant.grant_id); grant.revoked = true; },
        removeExact: async (path) => { if (path.endsWith("/mcp-authorization.header")) headerPresent = false; },
        removeTree: async () => {},
        scanRuntimeSecrets: async () => ({ matches: [], errors: [] }),
        headerAbsent: async () => !headerPresent,
        grantIsRevoked: async () => typeof records[0].revoked_at === "string",
      },
    });
    assert.equal(cleanup.boundary_verified, true);
    assert.equal(state.secrets.grantToken, "");
    assert.equal(state.grant.issued.token, "");
  };
  await buildCase({ invalidRecords: true });
  await buildCase({ headerFailure: true });
  await buildCase({ afterHeaderFailure: true });
});

test("cleanup retains secrets after injected boundary failure and safely retries", async () => {
  const state = {
    children: [],
    grant: {
      issued: { token: "fg_retained_secret", grant: { grant_id: "grant-retained" } },
      revoked: false,
    },
    secrets: { runtimeKey: "runtime-retained", proof: "proof-retained", grantToken: "fg_retained_secret" },
  };
  const failed = await cleanupOwned(state, {
    operations: {
      revokeGrant: async () => { throw new Error("REVOCATION_FAILED"); },
      removeExact: async () => { throw new Error("HEADER_DELETE_FAILED"); },
      removeTree: async () => {},
      scanRuntimeSecrets: async () => ({ matches: ["mcp-authorization.header"], errors: [] }),
      headerAbsent: async () => false,
      grantIsRevoked: async () => false,
    },
  });
  assert.equal(failed.boundary_verified, false);
  assert.equal(state.secrets.grantToken, "fg_retained_secret");
  assert.equal(state.grant.issued.token, "fg_retained_secret");
  const recovered = await cleanupOwned(state, {
    operations: {
      revokeGrant: async (grant) => { grant.revoked = true; },
      removeExact: async () => {},
      removeTree: async () => {},
      scanRuntimeSecrets: async () => ({ matches: [], errors: [] }),
      headerAbsent: async () => true,
      grantIsRevoked: async () => true,
    },
  });
  assert.equal(recovered.boundary_verified, true);
  assert.equal(recovered.attempt, 2);
  assert.equal(state.secrets.grantToken, "");
});

test("cleanup terminates an owned long-lived process before verifying the boundary", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const owned = {
    label: "cleanup-test-child",
    child,
    pid: child.pid,
    exited: false,
  };
  child.once("exit", () => { owned.exited = true; });
  const state = {
    children: [owned],
    grant: null,
    secrets: { runtimeKey: "", proof: "", grantToken: "" },
  };
  try {
    const result = await cleanupOwned(state, {
      operations: {
        revokeGrant: async () => {},
        removeExact: async () => {},
        removeTree: async () => {},
        scanRuntimeSecrets: async () => ({ matches: [], errors: [] }),
        headerAbsent: async () => true,
        grantIsRevoked: async () => true,
      },
    });
    assert.equal(result.boundary_verified, true);
    assert.equal(owned.exited, true);
    assert.deepEqual(result.survivor_pids, []);
  } finally {
    if (!owned.exited) child.kill("SIGKILL");
  }
});

test("runtime secret scan rejects and purges retained secret-bearing files", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "filmos-phase7-secret-test-")));
  const secretPath = resolve(root, "mcp-authorization.header");
  try {
    await writeFile(secretPath, "Bearer fg_secret_must_not_survive\n", { mode: 0o600 });
    const secrets = { runtimeKey: "", proof: "", grantToken: "fg_secret_must_not_survive" };
    assert.deepEqual((await scanRuntimeSecrets(root, secrets)).matches, ["mcp-authorization.header"]);
    const purged = await scanRuntimeSecrets(root, secrets, { purge: true });
    assert.deepEqual(purged.matches, ["mcp-authorization.header"]);
    assert.deepEqual((await scanRuntimeSecrets(root, secrets)).matches, []);
    await assert.rejects(() => readFile(secretPath), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-cleanup OS boundary detects tracked, cloudflared, runtime-root and reserved-port survivors", () => {
  const runtimeRoot = "/tmp/filmos-phase7-process-boundary";
  const state = {
    children: [{ pid: 101, label: "review-bus" }],
    processInventory: {
      processes: [
        { pid: 900, label: "runner" },
        { pid: 101, label: "review-bus" },
        { pid: 202, label: "cloudflared" },
      ],
    },
  };
  const result = verifyPostCleanupProcessBoundary(state, {
    runtimeRoot,
    runnerPid: 900,
    psRows: [
      { pid: 101, ppid: 900, command: "/opt/node review-bus" },
      { pid: 202, ppid: 1, command: `${runtimeRoot}/Tunnel/cloudflared tunnel run` },
      { pid: 303, ppid: 1, command: `/opt/node ${runtimeRoot}/orphan.mjs` },
    ],
    lsofText: "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 404 apple 10u IPv4 0 0t0 TCP 127.0.0.1:17840 (LISTEN)\n",
  });
  assert.equal(result.boundary_verified, false);
  assert.deepEqual(result.tracked_pid_survivors, [101, 202]);
  assert.deepEqual(result.conditional_cloudflared_survivor_pids, [202]);
  assert.deepEqual(result.runtime_root_reference_pids, [202, 303]);
  assert.deepEqual(result.runtime_root_or_reserved_port_open_pids, [404]);
  assert.deepEqual(result.survivor_pids, [101, 202, 303, 404]);
  assert.equal(verifyPostCleanupProcessBoundary({ children: [] }, {
    runtimeRoot,
    runnerPid: 900,
    psRows: [],
    lsofText: "",
  }).boundary_verified, true);
});

test("failureReceipt retries the combined cleanup boundary and recovers before exhaustion", async () => {
  const reviewBoundary = validReviewBusFailureBoundary();
  const writes = [];
  const state = {
    rootReady: true,
    children: [],
    grant: { issued: { token: "fg_failure_retry", grant: { grant_id: "grant-failure-retry" } } },
    secrets: { runtimeKey: "runtime-failure-retry", proof: "proof-failure-retry", grantToken: "fg_failure_retry" },
    productionBefore: { marker: "before" },
    reviewBusBoundaryBefore: reviewBoundary,
  };
  let cleanupCalls = 0;
  let processAuditCalls = 0;
  const receipt = await failureReceipt(state, new Error("INJECTED_FAILURE"), {
    root: "/tmp/phase7-failure-retry",
    operations: {
      cleanupOwned: async () => successfulCleanupResult(++cleanupCalls),
      auditPostCleanupProcesses: async () => (++processAuditCalls === 1
        ? processBoundary([8123], { cloudflared: true })
        : processBoundary()),
      removeExact: async () => {},
      productionSnapshot: async () => ({ marker: "after" }),
      assertProductionPreserved: () => {},
      reviewBusFailureBoundarySnapshot: async () => structuredClone(reviewBoundary),
      scanRuntimeSecrets: async () => ({ matches: [], errors: [] }),
      writeJSON: async (path, value) => { writes.push({ path, value }); },
      scanForSecrets: async () => {},
    },
  });
  assert.equal(cleanupCalls, 2);
  assert.equal(processAuditCalls, 2);
  assert.equal(receipt.cleanup_attempt_count, 2);
  assert.equal(receipt.automatic_retry_count, 1);
  assert.equal(receipt.cleanup_results[0].local_boundary_verified, true);
  assert.equal(receipt.cleanup_results[0].boundary_verified, false);
  assert.deepEqual(receipt.cleanup_results[0].os_process_boundary.conditional_cloudflared_survivor_pids, [8123]);
  assert.equal(receipt.cleanup_boundary_verified, true);
  assert.equal(receipt.final_process_boundary_verified, true);
  assert.equal(receipt.production_preservation_verified, true);
  assert.equal(receipt.review_bus_preservation_verified, true);
  assert.equal(state.secrets.runtimeKey, "");
  assert.equal(state.grant.issued.token, "");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path.endsWith("/lifecycle-receipt.json"), true);
});

test("failureReceipt exhausts exactly three attempts and retains secrets while a vendor process survives", async () => {
  const reviewBoundary = validReviewBusFailureBoundary();
  const state = {
    rootReady: true,
    children: [],
    grant: { issued: { token: "fg_failure_exhaust", grant: { grant_id: "grant-failure-exhaust" } } },
    secrets: { runtimeKey: "runtime-failure-exhaust", proof: "proof-failure-exhaust", grantToken: "fg_failure_exhaust" },
    productionBefore: { marker: "before" },
    reviewBusBoundaryBefore: reviewBoundary,
  };
  let cleanupCalls = 0;
  let processAuditCalls = 0;
  const receipt = await failureReceipt(state, new Error("INJECTED_FAILURE"), {
    root: "/tmp/phase7-failure-exhaust",
    operations: {
      cleanupOwned: async () => successfulCleanupResult(++cleanupCalls),
      auditPostCleanupProcesses: async () => {
        processAuditCalls += 1;
        return processBoundary([9123], { cloudflared: true });
      },
      removeExact: async () => {},
      productionSnapshot: async () => ({ marker: "after" }),
      assertProductionPreserved: () => {},
      reviewBusFailureBoundarySnapshot: async () => structuredClone(reviewBoundary),
      scanRuntimeSecrets: async () => ({ matches: [], errors: [] }),
      writeJSON: async () => {},
      scanForSecrets: async () => {},
    },
  });
  assert.equal(cleanupCalls, 3);
  assert.equal(processAuditCalls, 3);
  assert.equal(receipt.cleanup_attempt_count, 3);
  assert.equal(receipt.automatic_retry_count, 2);
  assert.equal(receipt.cleanup_boundary_verified, false);
  assert.equal(receipt.final_process_boundary_verified, false);
  assert.deepEqual(receipt.final_conditional_cloudflared_survivor_pids, [9123]);
  assert.deepEqual(receipt.final_owned_process_survivor_pids, [9123]);
  assert.equal(state.secrets.runtimeKey, "runtime-failure-exhaust");
  assert.equal(state.secrets.grantToken, "fg_failure_exhaust");
  assert.equal(state.grant.issued.token, "fg_failure_exhaust");
});

test("Review Bus failure boundary permits only canonical receipt upserts and rejects all other Production drift", () => {
  const before = validReviewBusFailureBoundary();
  const unchanged = structuredClone(before);
  assert.equal(assertReviewBusFailurePreserved(before, unchanged).changed_read_receipt_row_count, 0);

  const permitted = structuredClone(before);
  permitted.read_receipt_rows[0].read_at = "2026-09-05T01:03:03.000Z";
  assert.equal(assertReviewBusFailurePreserved(before, permitted).changed_read_receipt_row_count, 1);

  const projectionDrift = structuredClone(before);
  projectionDrift.projection_summaries[0].entity_version += 1;
  assert.throws(() => assertReviewBusFailurePreserved(before, projectionDrift), /REVIEW_BUS_FAILURE_PROJECTION_VERSION_DRIFT/);

  const eventDrift = structuredClone(before);
  eventDrift.event_rows_sha256 = HASH_B;
  assert.throws(() => assertReviewBusFailurePreserved(before, eventDrift), /REVIEW_BUS_FAILURE_EVENT_BYTES_DRIFT/);

  const receiptBudgetDrift = structuredClone(before);
  receiptBudgetDrift.read_receipt_row_count += 1;
  receiptBudgetDrift.read_receipt_rows.push({ ...receiptBudgetDrift.read_receipt_rows[0], tool_name: "unexpected" });
  assert.throws(() => assertReviewBusFailurePreserved(before, receiptBudgetDrift), /REVIEW_BUS_FAILURE_RECEIPT_ROW_COUNT_DRIFT/);

  const receiptValueDrift = structuredClone(before);
  receiptValueDrift.read_receipt_rows[0].read_at = "2026-09-05T01:03:03.000Z";
  receiptValueDrift.read_receipt_rows[0].evidence_manifest_hash = HASH_B;
  assert.throws(() => assertReviewBusFailurePreserved(before, receiptValueDrift), /REVIEW_BUS_FAILURE_RECEIPT_VALUE_DRIFT/);
});

test("failureReceipt refuses a Production-preserved claim when Review Bus state drifts", async () => {
  const reviewBoundary = validReviewBusFailureBoundary();
  const drifted = structuredClone(reviewBoundary);
  drifted.non_receipt_tables_sha256 = HASH_B;
  const state = {
    rootReady: true,
    children: [],
    grant: null,
    secrets: { runtimeKey: "", proof: "", grantToken: "" },
    productionBefore: { marker: "before" },
    reviewBusBoundaryBefore: reviewBoundary,
  };
  const receipt = await failureReceipt(state, new Error("INJECTED_FAILURE"), {
    root: "/tmp/phase7-failure-review-drift",
    operations: {
      cleanupOwned: async () => successfulCleanupResult(1),
      auditPostCleanupProcesses: async () => processBoundary(),
      removeExact: async () => {},
      productionSnapshot: async () => ({ marker: "after" }),
      assertProductionPreserved: () => {},
      reviewBusFailureBoundarySnapshot: async () => drifted,
      scanRuntimeSecrets: async () => ({ matches: [], errors: [] }),
      writeJSON: async () => {},
      scanForSecrets: async () => {},
    },
  });
  assert.equal(receipt.cleanup_boundary_verified, true);
  assert.equal(receipt.immutable_and_film_core_preservation_verified, true);
  assert.equal(receipt.review_bus_preservation_verified, false);
  assert.equal(receipt.production_preservation_verified, false);
  assert.equal(receipt.cleanup_error_codes.includes("REVIEW_BUS_FAILURE_NON_RECEIPT_TABLE_DRIFT"), true);
});

test("BLOCKED completion persists sanitized evidence and records zero Assessment submissions", async () => {
  const writes = [];
  const command = {
    external_conversation_id: "phase7-external-assessment-02",
    external_message_count: 1,
    platform_schema_discovery_call_count: 1,
  };
  command.external_response = validBlockedResponse();
  let evidence;
  await assert.rejects(() => prepareExternalResponse(command, {
    root: "/tmp/phase7-blocked-test",
    now: () => new Date(NOW),
    readPartialAudit: async () => [{ action: "filmos_get_live_workbench_context", outcome: "ERROR" }],
    writeJSON: async (path, value) => {
      writes.push({ path, value });
      if (path.endsWith("/blocked-evidence.json")) evidence = value;
    },
  }), /EXTERNAL_ASSESSMENT_BLOCKED:LIVE_CONTEXT_EXPIRED/);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path.endsWith("/external-response.json"), true);
  assert.equal(writes[0].value.assessment_status, "BLOCKED");
  assert.equal(writes[1].path.endsWith("/blocked-evidence.json"), true);
  assert.equal(writes[1].value.review_bus_assessment_submission_count, 0);
  assert.equal(writes[1].value.assessment_generated, false);
  assert.equal(evidence.blindness_preserved, true);
  assert.equal(evidence.observed_audit_row_count, 1);
  await assert.rejects(() => prepareExternalResponse(
    { ...command, platform_schema_discovery_call_count: 2 },
    { writeJSON: async () => {}, readPartialAudit: async () => [] },
  ), /BLOCKED_SCHEMA_DISCOVERY_COUNT_MISMATCH/);
});

test("MCP audit validator binds all ten tool rows to the same challenge and request metadata", () => {
  const bound = binding();
  const actions = [
    "handoff.live_context.publish",
    "filmos_get_live_workbench_context",
    "filmos_get_blockers",
    "filmos_get_live_workbench_context",
    ...EXTERNAL_TOOL_ORDER,
  ];
  const records = actions.map((action, index) => {
    const correlation = `request-${index}`;
    const outputHash = index === 0 ? PHASE7.canvasStateHash : sha256(action + index);
    return {
      event_id: `event-${index}`,
      recorded_at: NOW,
      correlation_id: correlation,
      action,
      grant_id: bound.project_grant_id,
      project_id: PHASE7.projectId,
      outcome: "ALLOW",
      result_size: 1,
      output_hash: outputHash,
      challenge_id: bound.challenge_id,
      ...(index === 0 ? { context_receipt_id: bound.context_receipt_id } : {
        request_id: correlation,
        tool_name: action,
        timestamp: NOW,
        result_hash: outputHash,
      }),
    };
  });
  const summary = validateAuditRecords(records, bound);
  assert.equal(summary.row_count, 11);
  assert.equal(summary.independent_action_count, 7);
  const tampered = structuredClone(records);
  tampered[4].request_id = "different";
  assert.throws(() => validateAuditRecords(tampered, bound), /MCP_AUDIT_REQUEST_ID_MISMATCH/);
});

test("transient audit validator enforces all 26 ordered parent-bound start/exit pairs", () => {
  const records = transientRecords();
  const summary = validateTransientRecords(records, 4321);
  assert.equal(summary.runner_direct_invocation_count, 26);
  assert.equal(summary.runner_direct_record_count, 52);
  assert.equal(summary.total_transient_process_invocations, "52..53");
  const reordered = structuredClone(records);
  [reordered[0], reordered[2]] = [reordered[2], reordered[0]];
  assert.throws(() => validateTransientRecords(reordered, 4321), /TRANSIENT_PHASE_PAIR_MISMATCH|TRANSIENT_LABEL_ORDER_MISMATCH/);
  const leaked = structuredClone(records);
  const secretExit = RUNNER_DIRECT_TRANSIENT_ORDER.indexOf("keychain-secret-once") * 2 + 1;
  leaked[secretExit].stdout_sha256 = HASH_A;
  assert.throws(() => validateTransientRecords(leaked, 4321), /TRANSIENT_SECRET_HASH_EXPOSED/);
  const wrongExecutable = structuredClone(records);
  wrongExecutable[0].executable = "/usr/bin/true";
  assert.throws(() => validateTransientRecords(wrongExecutable, 4321), /TRANSIENT_EXECUTABLE_PATH_MISMATCH/);
});

test("production preservation covers Film Core siblings and permits only SHM content-byte drift", () => {
  const file = (path) => ({ present: true, path, device: 1, inode: 2, size: 3, sha256: HASH_A });
  const before = {
    chatgpt_connection_other: { digest: HASH_A },
    film_core: {
      main: file("/tmp/film-core.sqlite"),
      wal: file("/tmp/film-core.sqlite-wal"),
      shm: file("/tmp/film-core.sqlite-shm"),
    },
  };
  const after = structuredClone(before);
  after.film_core.shm.sha256 = HASH_B;
  assert.doesNotThrow(() => assertProductionPreserved(before, after));
  after.film_core.shm.size += 1;
  assert.throws(() => assertProductionPreserved(before, after), /FILM_CORE_SHM_SIZE_DRIFT/);
  const siblingDrift = structuredClone(before);
  siblingDrift.chatgpt_connection_other.digest = HASH_B;
  assert.throws(() => assertProductionPreserved(before, siblingDrift), /IMMUTABLE_PRODUCTION_SNAPSHOT_DRIFT/);
});

test("nested process derivation proves the corrected 52..53, three-fingerprint and 31-Git totals", async () => {
  const files = {
    metadataSource: "scripts/source-runtime-metadata.mjs",
    fingerprintSource: "desktop/macos/scripts/source-fingerprint",
    widgetSource: "services/filmos-chatgpt-app/scripts/build-widget.mjs",
    reviewBusSource: "services/filmos-review-bus/src/server.mjs",
    installedSource: "services/filmos-review-bus/src/installed-source-identity.mjs",
  };
  const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(resolve(SOURCE_ROOT, path), "utf8")])));
  const result = deriveNestedProcessBudget(sources);
  assert.equal(result.evidence_standard, "STATIC_SOURCE_DERIVATION_ONLY");
  assert.throws(() => deriveNestedProcessBudget({ ...sources, metadataSource: "" }), /SOURCE_METADATA_FINGERPRINT_PROCESS_COUNT_DRIFT/);
  assert.equal(result.review_bus.total_transient_subtree_invocations, 14);
  assert.equal(result.total_transient_process_invocations, "52..53");
  assert.equal(result.total_source_fingerprint_invocations, 3);
  assert.equal(result.total_git_invocations, 31);
  assert.deepEqual(TRANSIENT_PROCESS_BUDGET, {
    runner_direct: 26,
    source_metadata_fingerprint: 1,
    source_fingerprint_nested_git: 10,
    widget_esbuild: 1,
    review_bus_startup_subtree: 14,
    tunnel_doctor_cloudflared_min: 0,
    tunnel_doctor_cloudflared_max: 1,
    total_min: 52,
    total_max: 53,
    source_fingerprint_total: 3,
    git_total: 31,
  });
});

test("tunnel payload verification accepts only the exact regular-file set and executable modes", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "filmos-phase7-tunnel-test-")));
  try {
    const specs = {
      runner: { sha256: sha256("runner"), executable: true },
      NOTICE: { sha256: sha256("notice"), executable: false },
    };
    await writeFile(resolve(root, "runner"), "runner", { mode: 0o700 });
    await chmod(resolve(root, "runner"), 0o700);
    await writeFile(resolve(root, "NOTICE"), "notice", { mode: 0o600 });
    const result = await verifyTunnelPayloadDirectory(root, specs);
    assert.deepEqual(result.map((item) => item.name), ["NOTICE", "runner"]);
    await writeFile(resolve(root, "extra"), "extra", { mode: 0o600 });
    await assert.rejects(() => verifyTunnelPayloadDirectory(root, specs), /TUNNEL_PAYLOAD_SET_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-independent path and main-module guards fail closed", () => {
  assert.equal(assertSourceIndependentPath("/tmp/filmos-phase7-safe"), "/tmp/filmos-phase7-safe");
  assert.throws(() => assertSourceIndependentPath("/Users/apple/Applications/FilmOS Studio.app/Contents/MacOS/FilmOS Studio"), /APP_PATH_FORBIDDEN/);
  assert.throws(() => assertSourceIndependentPath(resolve(import.meta.dirname, "../.local/source-host/server")), /SOURCE_HOST_PATH_FORBIDDEN/);
  assert.equal(isExecutedAsMain(pathToFileURL("/tmp/a.mjs").href, "/tmp/a.mjs"), true);
  assert.equal(isExecutedAsMain(pathToFileURL("/tmp/a.mjs").href, "/tmp/b.mjs"), false);
  assert.equal(isExecutedAsMain(pathToFileURL("/tmp/a.mjs").href, undefined), false);
});

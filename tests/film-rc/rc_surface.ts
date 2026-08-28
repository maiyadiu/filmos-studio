import { createHash } from "node:crypto";

import { MemoryFilmAgentAuditSink } from "../../canvas-agent/src/film/audit.js";
import {
  FilmAgentGateway,
  FilmAgentGatewayError,
  type FilmCanvasObservationSource,
  type FilmCoreTransport,
} from "../../canvas-agent/src/film/gateway.js";
import { resolveFilmAgentProfile } from "../../canvas-agent/src/film/profile.js";
import {
  buildRemotePublishPreview,
  type RemotePublishPlanInput,
} from "../../web/src/film/sync/publish-plan";
import {
  confirmRemoteSyncPreviewLocally,
  createMemoryRemoteSyncSessionStore,
  recoverLatestRemoteSyncSession,
} from "../../web/src/film/sync/local-session";

const NOW = "2026-08-28T08:00:00.000Z";
const ENTITY_ID = "10000000-0000-4000-8000-000000000006";
const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);
const CANVAS_HASH = "c".repeat(16);

const entity = {
  ref: {
    film_entity_id: ENTITY_ID,
    entity_type: "film_project_extension",
    version: 1,
    content_hash: HASH_V1,
  },
  host: { host_project_id: "rc-host-project" },
  states: {
    creative_stage: "draft",
    execution_state: "not_started",
    review_state: "not_reviewed",
    lock_state: "unlocked",
    delivery_state: "not_ready",
    stale_state: "fresh",
  },
};

const command = {
  command_type: "entity.set_states" as const,
  target_id: ENTITY_ID,
  expected_version: 1,
  payload: {
    states: { ...entity.states, creative_stage: "authored" },
  },
};

class RecoveryTransport implements FilmCoreTransport {
  previewCalls = 0;
  applyCalls = 0;

  async getProjectContext() {
    return { host_project_id: "rc-host-project", film_project: entity };
  }

  async getEntity() {
    return structuredClone(entity);
  }

  async getAuditEvents() {
    return [];
  }

  async previewCommand() {
    this.previewCalls += 1;
    return {
      mode: "preview" as const,
      command_type: command.command_type,
      target_id: ENTITY_ID,
      current_version: 1,
      resulting_version: 2,
      content_hash: HASH_V2,
      changes: ["states"],
    };
  }

  async applyCommand() {
    this.applyCalls += 1;
    throw new Error("RC fail-closed drill must never dispatch Apply");
  }
}

class RecoveryCanvas implements FilmCanvasObservationSource {
  async current() {
    return { revision: 11, stateHash: CANVAS_HASH };
  }
}

export async function runRcSurface() {
  const fixtureUrl = new URL(
    "../../web/test/fixtures/film-remote-plan.json",
    import.meta.url,
  );
  const featureFlagsUrl = new URL(
    "../../implementation/FEATURE_FLAGS.yaml",
    import.meta.url,
  );
  const fixtureBytesBefore = await Bun.file(fixtureUrl).bytes();
  const fixtureSha256 = sha256(fixtureBytesBefore);
  const plan = JSON.parse(
    new TextDecoder().decode(fixtureBytesBefore),
  ) as RemotePublishPlanInput;
  const flags = await Bun.file(featureFlagsUrl).text();
  const configuredFlags = [
    ...flags.matchAll(/^\s{2}(film\.[a-z_]+):\s+(true|false)$/gm),
  ];
  if (
    !configuredFlags.length ||
    configuredFlags.some((match) => match[2] !== "false")
  ) {
    throw new Error(
      "RC rollback requires every declared Film feature flag to default false",
    );
  }
  if (
    !flags.includes(
      "disabling_any_flag_must_leave_original_yingce_flow_available",
    )
  ) {
    throw new Error("Feature Flag rollback rule is missing");
  }

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("RC local recovery drill forbids network access");
  }) as typeof fetch;

  try {
    const disabledPreview = await buildRemotePublishPreview(plan);
    const policy = {
      enabled: true,
      authority_mode: "LOCAL_AUTHORITY" as const,
    };
    const preview = await buildRemotePublishPreview(plan, policy);
    if (
      preview.blockers.length ||
      !preview.publishable_after_explicit_execution
    ) {
      throw new Error("Remote fixture is not locally previewable");
    }
    const store = createMemoryRemoteSyncSessionStore();
    const input = {
      userScope: "rc-user-synthetic",
      hostProjectId: plan.host_project_id,
      plan,
      policy,
      humanConfirmed: true,
      confirmationId: "rc-confirmation-0001",
      expectedManifestVersion: preview.manifest_version,
      expectedManifestHash: preview.manifest_hash,
    } as const;
    const receipt = await confirmRemoteSyncPreviewLocally(input, {
      store,
      now: () => NOW,
      createId: () => "rc-remote-receipt-0001",
    });
    const repeated = await confirmRemoteSyncPreviewLocally(input, {
      store,
      now: () => NOW,
      createId: () => "must-not-be-used",
    });
    const recovered = await recoverLatestRemoteSyncSession(
      input.userScope,
      plan.host_project_id,
      store,
    );
    if (recovered.state !== "RECOVERED") {
      throw new Error(`Remote receipt did not recover: ${recovered.state}`);
    }
    if (receipt.receipt.receipt_id !== repeated.receipt.receipt_id) {
      throw new Error(
        "Remote confirmation replay produced a different receipt",
      );
    }

    const agent = await runAgentFailClosed();
    const fixtureBytesAfter = await Bun.file(fixtureUrl).bytes();
    const fixtureAfterSha256 = sha256(fixtureBytesAfter);
    if (fixtureAfterSha256 !== fixtureSha256) {
      throw new Error("Remote source fixture changed during RC recovery drill");
    }
    if (networkCalls !== 0) {
      throw new Error("RC local recovery drill attempted network access");
    }
    return {
      status: "PASSED_LOCAL_RC_SURFACE_RECOVERY",
      remote: {
        source_sha256: fixtureSha256,
        source_unchanged: true,
        manifest_version: preview.manifest_version,
        manifest_sha256: preview.manifest_hash,
        receipt_id: receipt.receipt.receipt_id,
        recovered_receipt_id: recovered.session.receipt.receipt_id,
        replayed_same_receipt:
          receipt.receipt.receipt_id === repeated.receipt.receipt_id,
        execution_state: receipt.receipt.execution_state,
        inbound_result_policy: receipt.receipt.inbound_result_policy,
        network_executed: receipt.receipt.network_executed,
        uploaded_asset_ids: receipt.receipt.uploaded_asset_ids,
        publication_receipts: receipt.receipt.publication_receipts,
      },
      feature_flag_rollback: {
        declared_flags: configuredFlags.length,
        all_default_false: true,
        remote_disabled_blocker: disabledPreview.blockers.some(
          (blocker) => blocker.code === "FEATURE_DISABLED",
        ),
        rollback_rule_present: true,
      },
      agent,
      network_calls: networkCalls,
      external_provider_calls: 0,
      formal_apply_calls: 0,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runAgentFailClosed() {
  const transport = new RecoveryTransport();
  const canvas = new RecoveryCanvas();
  const agentAudit = new MemoryFilmAgentAuditSink();
  let uuidCounter = 100;
  const deepseekProfile = resolveFilmAgentProfile({
    FILMOS_AGENT_PROFILE: "deepseek_compatible",
    FILMOS_AGENT_ACTOR_ID: "rc-deepseek-synthetic",
  });
  const agentGateway = new FilmAgentGateway({
    identity: deepseekProfile.identity,
    transport,
    canvas,
    audit: agentAudit,
    now: () => new Date(NOW),
    randomUUID: () => uuid(uuidCounter++),
  });
  const agentRead = await readEntity(agentGateway);
  const agentGuards = guardsFrom(agentRead);
  const agentPreview = (await agentGateway.callTool("film_command_preview", {
    command,
    guards: agentGuards,
  })) as { preview_receipt: string };
  let agentApplyError = "";
  try {
    await agentGateway.callTool("film_command_apply", {
      command,
      guards: agentGuards,
      preview_receipt: agentPreview.preview_receipt,
      human_confirmation: {
        confirmed_by: "forged-human",
        confirmed_at: NOW,
        reason: "must not elevate an Agent",
      },
    });
  } catch (error) {
    if (!(error instanceof FilmAgentGatewayError)) throw error;
    agentApplyError = error.code;
  }
  if (agentApplyError !== "human_apply_required") {
    throw new Error(`Agent Apply did not fail closed: ${agentApplyError}`);
  }

  const humanProfile = resolveFilmAgentProfile({
    FILMOS_AGENT_PROFILE: "human_only",
    FILMOS_AGENT_ACTOR_ID: "rc-human-synthetic",
  });
  const firstSession = new FilmAgentGateway({
    identity: humanProfile.identity,
    transport,
    canvas,
    audit: new MemoryFilmAgentAuditSink(),
    now: () => new Date(NOW),
    randomUUID: () => uuid(uuidCounter++),
  });
  const humanRead = await readEntity(firstSession);
  const humanGuards = guardsFrom(humanRead);
  const humanPreview = (await firstSession.callTool("film_command_preview", {
    command,
    guards: humanGuards,
  })) as { preview_receipt: string };

  const recoveredSessionAudit = new MemoryFilmAgentAuditSink();
  const recoveredSession = new FilmAgentGateway({
    identity: humanProfile.identity,
    transport,
    canvas,
    audit: recoveredSessionAudit,
    now: () => new Date(NOW),
    randomUUID: () => uuid(uuidCounter++),
  });
  let sessionLossError = "";
  try {
    await recoveredSession.callTool("film_command_apply", {
      command,
      guards: humanGuards,
      preview_receipt: humanPreview.preview_receipt,
      human_confirmation: {
        confirmed_by: "rc-human-synthetic",
        confirmed_at: NOW,
        reason: "session recovery fail-closed probe",
      },
    });
  } catch (error) {
    if (!(error instanceof FilmAgentGatewayError)) throw error;
    sessionLossError = error.code;
  }
  if (sessionLossError !== "read_required") {
    throw new Error(
      `Lost Agent session did not require a fresh read: ${sessionLossError}`,
    );
  }
  if (transport.applyCalls !== 0) {
    throw new Error(
      "Agent/session fail-closed drill dispatched Film Core Apply",
    );
  }
  return {
    deepseek_apply_error: agentApplyError,
    session_loss_error: sessionLossError,
    preview_calls: transport.previewCalls,
    apply_calls: transport.applyCalls,
    agent_denial_audited:
      agentAudit.records.at(-1)?.outcome === "denied" &&
      agentAudit.records.at(-1)?.error_code === "human_apply_required",
    session_denial_audited:
      recoveredSessionAudit.records.at(-1)?.outcome === "denied" &&
      recoveredSessionAudit.records.at(-1)?.error_code === "read_required",
  };
}

async function readEntity(gateway: FilmAgentGateway) {
  return (await gateway.callTool("film_entity_get", {
    film_entity_id: ENTITY_ID,
  })) as {
    observation: {
      read_receipt: string;
      expected_content_hash: string;
      expected_canvas_revision: number;
      expected_canvas_state_hash: string;
    };
  };
}

function guardsFrom(read: Awaited<ReturnType<typeof readEntity>>) {
  return {
    read_receipt: read.observation.read_receipt,
    expected_content_hash: read.observation.expected_content_hash,
    expected_canvas_revision: read.observation.expected_canvas_revision,
    expected_canvas_state_hash: read.observation.expected_canvas_state_hash,
  };
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

if (import.meta.main) {
  console.log(JSON.stringify(await runRcSurface(), null, 2));
}

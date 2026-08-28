import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  type FormalFilmReference,
  type RemotePublishPlanInput,
} from "../../web/src/film/sync/publish-plan";

type Metric = {
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  samples: number;
  errors: number;
};

const SPEC_URL = new URL("./beta-performance.json", import.meta.url);
const ENTITY_ID = uuid(90_001);
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
  host: { host_project_id: "beta-agent-project" },
  states: {
    creative_stage: "draft",
    execution_state: "not_started",
    review_state: "not_reviewed",
    lock_state: "unlocked",
    delivery_state: "not_ready",
    stale_state: "fresh",
  },
};

class PerformanceTransport implements FilmCoreTransport {
  previewCalls = 0;
  applyCalls = 0;

  async getProjectContext() {
    return { host_project_id: "beta-agent-project", film_project: entity };
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
      command_type: "entity.set_states",
      target_id: ENTITY_ID,
      current_version: 1,
      resulting_version: 2,
      content_hash: HASH_V2,
      changes: ["states"],
    };
  }

  async applyCommand() {
    this.applyCalls += 1;
    throw new Error("Agent performance path must never dispatch Apply");
  }
}

class PerformanceCanvas implements FilmCanvasObservationSource {
  async current() {
    return { revision: 7, stateHash: CANVAS_HASH };
  }
}

export async function runSurfacePerformance() {
  const spec = JSON.parse(await readFile(SPEC_URL, "utf8")) as {
    dataset: Record<string, number>;
    budgets_ms: Record<string, number>;
  };
  const remotePlan = buildRemotePlan(spec.dataset);
  const remote = await measureAsync(async () => {
    const preview = await buildRemotePublishPreview(remotePlan, {
      enabled: true,
      authority_mode: "LOCAL_AUTHORITY",
    });
    if (
      preview.blockers.length !== 0 ||
      !preview.publishable_after_explicit_execution ||
      preview.network.executed ||
      preview.network.actions.length !== 0 ||
      preview.network.uploaded_asset_ids.length !== 0 ||
      preview.inbound_results.some(
        (result) => result.import_state !== "CANDIDATE_ONLY",
      )
    ) {
      throw new Error("Remote preview boundary drifted");
    }
  }, spec.dataset.samples);

  let agentPreviewCalls = 0;
  let agentApplyCalls = 0;
  const agent = await measureAsync(async (sample) => {
    const transport = new PerformanceTransport();
    const audit = new MemoryFilmAgentAuditSink();
    let receipt = 100_000 + sample * 10;
    const profile = resolveFilmAgentProfile({
      FILMOS_AGENT_PROFILE: "deepseek_compatible",
      FILMOS_AGENT_ACTOR_ID: "deepseek-beta-performance",
    });
    const gateway = new FilmAgentGateway({
      identity: profile.identity,
      transport,
      canvas: new PerformanceCanvas(),
      audit,
      now: () => new Date("2026-08-28T08:00:00.000Z"),
      randomUUID: () => uuid(receipt++),
    });
    const read = (await gateway.callTool("film_entity_get", {
      film_entity_id: ENTITY_ID,
    })) as {
      observation: {
        read_receipt: string;
        expected_content_hash: string;
        expected_canvas_revision: number;
        expected_canvas_state_hash: string;
      };
    };
    const guards = {
      read_receipt: read.observation.read_receipt,
      expected_content_hash: read.observation.expected_content_hash,
      expected_canvas_revision: read.observation.expected_canvas_revision,
      expected_canvas_state_hash: read.observation.expected_canvas_state_hash,
    };
    const command = {
      command_type: "entity.set_states",
      target_id: ENTITY_ID,
      expected_version: 1,
      payload: { states: { ...entity.states, creative_stage: "authored" } },
    };
    const preview = (await gateway.callTool("film_command_preview", {
      command,
      guards,
    })) as {
      preview_receipt: string;
    };
    try {
      await gateway.callTool("film_command_apply", {
        command,
        guards,
        preview_receipt: preview.preview_receipt,
        human_confirmation: {
          confirmed_by: "forged-human",
          confirmed_at: "2026-08-28T08:00:00.000Z",
          reason: "performance boundary probe",
        },
      });
      throw new Error("DeepSeek-compatible Apply unexpectedly succeeded");
    } catch (error) {
      if (
        !(error instanceof FilmAgentGatewayError) ||
        error.code !== "human_apply_required"
      )
        throw error;
    }
    if (audit.records.at(-1)?.outcome !== "denied")
      throw new Error("Agent denial audit is missing");
    agentPreviewCalls += transport.previewCalls;
    agentApplyCalls += transport.applyCalls;
  }, spec.dataset.agent_samples);

  const checks = {
    remote_preview_p95: remote.p95_ms <= spec.budgets_ms.remote_preview_p95,
    agent_read_preview_deny_p95:
      agent.p95_ms <= spec.budgets_ms.agent_read_preview_deny_p95,
    zero_errors: remote.errors === 0 && agent.errors === 0,
    zero_agent_apply: agentApplyCalls === 0,
  };
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    test_status: failures.length ? "FAILED" : "PASSED",
    dataset: spec.dataset,
    budgets_ms: {
      remote_preview_p95: spec.budgets_ms.remote_preview_p95,
      agent_read_preview_deny_p95: spec.budgets_ms.agent_read_preview_deny_p95,
    },
    metrics: { remote_preview: remote, agent_read_preview_apply_denied: agent },
    counts: {
      agent_preview_calls: agentPreviewCalls,
      agent_apply_calls: agentApplyCalls,
    },
    checks,
    failures,
    network_actions: 0,
    uploaded_assets: 0,
    external_provider_calls: 0,
  };
}

async function measureAsync(
  call: (sample: number) => Promise<void>,
  samples: number,
): Promise<Metric> {
  const durations: number[] = [];
  let errors = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    try {
      await call(sample);
    } catch (error) {
      errors += 1;
      throw error;
    } finally {
      durations.push(performance.now() - started);
    }
  }
  const ordered = durations.toSorted((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.max(0, Math.ceil(ordered.length * value) - 1)];
  return {
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    max_ms: round(Math.max(...durations)),
    samples,
    errors,
  };
}

function buildRemotePlan(
  dataset: Record<string, number>,
): RemotePublishPlanInput {
  const contentUnits = Array.from(
    { length: dataset.remote_content_units },
    (_, index) => ({
      local: reference(index + 1, "content_unit_extension", "project_unit"),
    }),
  );
  const assets = Array.from({ length: dataset.remote_assets }, (_, index) => ({
    availability: "LOCAL_PROXY_READY" as const,
    local: reference(10_000 + index, "asset_version", "asset_version"),
    proxy_ref: reference(20_000 + index, "review_proxy", "resource"),
  }));
  const remoteResults = Array.from(
    { length: dataset.remote_results },
    (_, index) => ({
      candidate_ref: reference(30_000 + index, "candidate", "resource"),
      target_ref: contentUnits[index % contentUnits.length].local,
    }),
  );
  return {
    plan_id: uuid(99_999),
    host_project_id: "beta-remote-project",
    generated_at: "2026-08-28T08:00:00.000Z",
    content_units: contentUnits,
    assets,
    remote_results: remoteResults,
  };
}

function reference(
  index: number,
  entityType: string,
  objectKind: string,
): FormalFilmReference {
  return {
    film_entity_id: uuid(index),
    entity_type: entityType,
    version: 1,
    content_hash: index.toString(16).padStart(64, "0"),
    host_ref: {
      object_kind: objectKind,
      opaque_id: `${objectKind}:beta-${index}`,
    },
  };
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function round(value: number) {
  return Number(value.toFixed(3));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runSurfacePerformance();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.test_status === "PASSED" ? 0 : 1;
}

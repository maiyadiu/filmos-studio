import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFilmAgentAuditSink } from "../src/film/audit.js";
import { filmToolNames, type FilmCommand } from "../src/film/contracts.js";
import {
  FilmAgentGateway,
  FilmAgentGatewayError,
  type FilmCanvasObservationSource,
  type FilmCoreTransport,
} from "../src/film/gateway.js";
import { registerFilmAgentMcp } from "../src/film/mcp.js";
import {
  filmAgentAdapterKinds,
  resolveFilmAgentProfile,
} from "../src/film/profile.js";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);
const CANVAS_HASH = "c".repeat(16);
const NOW = "2026-08-28T08:00:00.000Z";

const entity = {
  ref: {
    film_entity_id: ENTITY_ID,
    entity_type: "film_project_extension",
    version: 1,
    content_hash: HASH_V1,
  },
  host: { host_project_id: "host-project-profile" },
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

class ProfileTransport implements FilmCoreTransport {
  previewCalls = 0;
  applyCalls = 0;

  async getProjectContext() {
    return { host_project_id: "host-project-profile", film_project: entity };
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
      mode: "preview",
      command_type: command.command_type,
      target_id: command.target_id,
      current_version: 1,
      resulting_version: 2,
      content_hash: HASH_V2,
      changes: ["states"],
    };
  }

  async applyCommand(appliedCommand: FilmCommand) {
    this.applyCalls += 1;
    return {
      mode: "applied",
      entity: {
        ...entity,
        ref: { ...entity.ref, version: 2, content_hash: HASH_V2 },
        states: structuredClone(appliedCommand.payload.states),
      },
      audit_event: {
        event_id: "22222222-2222-4222-8222-222222222222",
        actor_kind: appliedCommand.actor_kind,
        action: appliedCommand.command_type,
        target_id: ENTITY_ID,
        recorded_at: NOW,
      },
    };
  }
}

class ProfileCanvas implements FilmCanvasObservationSource {
  async current() {
    return { revision: 7, stateHash: CANVAS_HASH };
  }
}

test("Film Agent profiles map every supported adapter to one provider-neutral MCP capability surface", () => {
  const expectedActors = {
    codex_app_server: "codex",
    deepseek_compatible: "deepseek",
    claude_code: "claude",
    local_model: "local_model",
    system: "system",
    human_only: "human",
  } as const;

  for (const adapterKind of filmAgentAdapterKinds) {
    const profile = resolveFilmAgentProfile({
      FILMOS_AGENT_PROFILE: adapterKind,
      FILMOS_AGENT_ACTOR_ID: `${adapterKind}-fixture`,
    });
    assert.equal(profile.adapter_kind, adapterKind);
    assert.equal(profile.actor_kind, expectedActors[adapterKind]);
    assert.deepEqual(profile.capabilities.tools, filmToolNames);
    assert.equal(profile.capabilities.tool_surface, "production_canvas_film_mcp");
    assert.equal(profile.capabilities.read, "allowed");
    assert.equal(profile.capabilities.preview, "allowed");
    assert.equal(profile.capabilities.external_execution, "disabled");
    if (adapterKind === "human_only") {
      assert.equal(profile.capabilities.formal_apply, "human_confirmed");
      assert.equal(profile.capabilities.approval, "human_confirmed");
    } else {
      assert.equal(profile.capabilities.formal_apply, "human_only");
      assert.equal(profile.capabilities.approval, "denied");
    }
  }
});

test("DeepSeek-compatible profile declaration is offline metadata and never retains endpoint or secret fields", () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network must remain closed");
  }) as typeof fetch;
  try {
    const profile = resolveFilmAgentProfile({
      FILMOS_AGENT_PROFILE: "deepseek_compatible",
      FILMOS_AGENT_ACTOR_ID: "deepseek-offline-fixture",
      DEEPSEEK_API_KEY: "must-not-be-retained",
      DEEPSEEK_BASE_URL: "https://example.invalid/v1",
    });
    assert.equal(profile.actor_kind, "deepseek");
    assert.equal(networkCalls, 0);
    const serialized = JSON.stringify(profile);
    assert.equal(serialized.includes("must-not-be-retained"), false);
    assert.equal(serialized.includes("example.invalid"), false);
    assert.equal("api_key" in profile, false);
    assert.equal("base_url" in profile, false);
    const registered: string[] = [];
    const registration = registerFilmAgentMcp(
      {
        registerTool(name: string) {
          registered.push(name);
        },
      } as never,
      { url: "http://127.0.0.1:17371", token: "fixture" },
      {
        enabled: true,
        env: {
          FILMOS_AGENT_PROFILE: "deepseek_compatible",
          FILMOS_AGENT_ACTOR_ID: "deepseek-offline-fixture",
          DEEPSEEK_API_KEY: "must-not-be-retained",
          DEEPSEEK_BASE_URL: "https://example.invalid/v1",
        },
      },
    );
    assert.deepEqual(registration.registered, filmToolNames);
    assert.deepEqual(registered, filmToolNames);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit unknown profiles fail closed instead of silently becoming Codex", () => {
  assert.throws(
    () => resolveFilmAgentProfile({ FILMOS_AGENT_PROFILE: "unknown-agent" }),
    /Unsupported FILMOS_AGENT_PROFILE/,
  );
  assert.throws(
    () =>
      resolveFilmAgentProfile({
        FILMOS_AGENT_ACTOR_KIND: "unknown-actor",
      }),
    /Unsupported FILMOS_AGENT_ACTOR_KIND/,
  );
  assert.throws(
    () =>
      resolveFilmAgentProfile({
        FILMOS_AGENT_PROFILE: "deepseek_compatible",
        FILMOS_AGENT_ACTOR_KIND: "codex",
      }),
    /conflicts with FILMOS_AGENT_ACTOR_KIND/,
  );
  assert.throws(
    () => resolveFilmAgentProfile({ FILMOS_AGENT_MODE: "autonomous" }),
    /Unsupported FILMOS_AGENT_MODE/,
  );
});

test("a DeepSeek-compatible Agent can read and Preview but formal Apply is denied and audited", async () => {
  const profile = resolveFilmAgentProfile({
    FILMOS_AGENT_PROFILE: "deepseek_compatible",
    FILMOS_AGENT_ACTOR_ID: "deepseek-gateway-fixture",
  });
  const transport = new ProfileTransport();
  const audit = new MemoryFilmAgentAuditSink();
  let uuidCounter = 700;
  const gateway = new FilmAgentGateway({
    identity: profile.identity,
    transport,
    canvas: new ProfileCanvas(),
    audit,
    now: () => new Date(NOW),
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
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
  const preview = (await gateway.callTool("film_command_preview", {
    command,
    guards,
  })) as { preview_receipt: string };

  await assert.rejects(
    gateway.callTool("film_command_apply", {
      command,
      guards,
      preview_receipt: preview.preview_receipt,
      human_confirmation: {
        confirmed_by: "forged-human",
        confirmed_at: NOW,
        reason: "Agent cannot elevate itself with untrusted input",
      },
    }),
    (error: unknown) =>
      error instanceof FilmAgentGatewayError &&
      error.code === "human_apply_required",
  );
  assert.equal(transport.previewCalls, 1);
  assert.equal(transport.applyCalls, 0);
  assert.equal(audit.records.at(-1)?.actor_kind, "deepseek");
  assert.equal(audit.records.at(-1)?.outcome, "denied");
  assert.equal(audit.records.at(-1)?.error_code, "human_apply_required");
});

test("Human Only formal Apply requires a fresh matching confirmation even when the command is not Approval", async () => {
  const profile = resolveFilmAgentProfile({
    FILMOS_AGENT_PROFILE: "human_only",
    FILMOS_AGENT_ACTOR_ID: "human-profile-fixture",
  });
  const transport = new ProfileTransport();
  let uuidCounter = 900;
  const gateway = new FilmAgentGateway({
    identity: profile.identity,
    transport,
    canvas: new ProfileCanvas(),
    audit: new MemoryFilmAgentAuditSink(),
    now: () => new Date(NOW),
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
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
  const preview = (await gateway.callTool("film_command_preview", {
    command,
    guards,
  })) as { preview_receipt: string };
  await assert.rejects(
    gateway.callTool("film_command_apply", {
      command,
      guards,
      preview_receipt: preview.preview_receipt,
    }),
    (error: unknown) =>
      error instanceof FilmAgentGatewayError &&
      error.code === "human_confirmation_required",
  );
  assert.equal(transport.applyCalls, 0);

  const applied = (await gateway.callTool("film_command_apply", {
    command,
    guards,
    preview_receipt: preview.preview_receipt,
    human_confirmation: {
      confirmed_by: "human-profile-fixture",
      confirmed_at: NOW,
      reason: "Human reviewed the preview receipt",
    },
  })) as { data: { mode: string } };
  assert.equal(applied.data.mode, "applied");
  assert.equal(transport.applyCalls, 1);
});

test("profile selection never registers Film tools while the gateway flag is closed", () => {
  const registered: string[] = [];
  const result = registerFilmAgentMcp(
    {
      registerTool(name: string) {
        registered.push(name);
      },
    } as never,
    { url: "http://127.0.0.1:17371", token: "fixture" },
    {
      env: {
        FILMOS_AGENT_PROFILE: "deepseek_compatible",
        FILMOS_AGENT_ACTOR_ID: "deepseek-disabled-fixture",
      },
    },
  );
  assert.deepEqual(result, { enabled: false, registered: [] });
  assert.deepEqual(registered, []);
});

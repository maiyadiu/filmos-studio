import {
  filmToolNames,
  type FilmActorKind,
  type FilmToolName,
} from "./contracts.js";
import type { FilmAgentGatewayIdentity } from "./gateway.js";

export const filmAgentAdapterKinds = [
  "codex_app_server",
  "deepseek_compatible",
  "claude_code",
  "local_model",
  "system",
  "human_only",
] as const;

export type FilmAgentAdapterKind = (typeof filmAgentAdapterKinds)[number];

export type FilmAgentCapabilities = {
  tool_surface: "production_canvas_film_mcp";
  tools: readonly FilmToolName[];
  read: "allowed";
  preview: "allowed";
  formal_apply: "human_only" | "human_confirmed";
  approval: "denied" | "human_confirmed";
  external_execution: "disabled";
};

export type FilmAgentProfile = {
  schema_version: 1;
  adapter_kind: FilmAgentAdapterKind;
  actor_kind: FilmActorKind;
  actor_id: string;
  mode: "agent" | "human_only";
  capabilities: FilmAgentCapabilities;
  identity: FilmAgentGatewayIdentity;
};

const ADAPTER_ACTORS: Record<
  Exclude<FilmAgentAdapterKind, "human_only">,
  Exclude<FilmActorKind, "human">
> = {
  codex_app_server: "codex",
  deepseek_compatible: "deepseek",
  claude_code: "claude",
  local_model: "local_model",
  system: "system",
};

const LEGACY_ACTOR_ADAPTERS: Partial<
  Record<FilmActorKind, FilmAgentAdapterKind>
> = {
  human: "human_only",
  codex: "codex_app_server",
  deepseek: "deepseek_compatible",
  claude: "claude_code",
  local_model: "local_model",
  system: "system",
};

export function resolveFilmAgentProfile(
  env: NodeJS.ProcessEnv = process.env,
): FilmAgentProfile {
  const adapterKind = resolveAdapterKind(env);
  const humanOnly = adapterKind === "human_only";
  const actorKind: FilmActorKind = humanOnly
    ? "human"
    : ADAPTER_ACTORS[adapterKind];
  const actorId = resolveActorId(env.FILMOS_AGENT_ACTOR_ID, actorKind);
  const mode = humanOnly ? ("human_only" as const) : ("agent" as const);
  const capabilities: FilmAgentCapabilities = {
    tool_surface: "production_canvas_film_mcp",
    tools: [...filmToolNames],
    read: "allowed",
    preview: "allowed",
    formal_apply: humanOnly ? "human_confirmed" : "human_only",
    approval: humanOnly ? "human_confirmed" : "denied",
    external_execution: "disabled",
  };
  return {
    schema_version: 1,
    adapter_kind: adapterKind,
    actor_kind: actorKind,
    actor_id: actorId,
    mode,
    capabilities,
    identity: {
      actorKind,
      actorId,
      mode,
      formalApplyPolicy: "human_only",
    },
  };
}

function resolveAdapterKind(env: NodeJS.ProcessEnv): FilmAgentAdapterKind {
  const legacyMode = env.FILMOS_AGENT_MODE?.trim();
  if (legacyMode && legacyMode !== "agent" && legacyMode !== "human_only") {
    throw new Error(`Unsupported FILMOS_AGENT_MODE: ${legacyMode}`);
  }
  const explicit = env.FILMOS_AGENT_PROFILE?.trim();
  if (explicit) {
    if (filmAgentAdapterKinds.includes(explicit as FilmAgentAdapterKind)) {
      const adapter = explicit as FilmAgentAdapterKind;
      assertLegacySelectionDoesNotConflict(env, adapter);
      return adapter;
    }
    throw new Error(`Unsupported FILMOS_AGENT_PROFILE: ${explicit}`);
  }

  if (legacyMode === "human_only") return "human_only";
  const legacyActor = env.FILMOS_AGENT_ACTOR_KIND?.trim();
  if (!legacyActor) return "codex_app_server";
  const adapter = LEGACY_ACTOR_ADAPTERS[legacyActor as FilmActorKind];
  if (!adapter || legacyActor === "human") {
    throw new Error(`Unsupported FILMOS_AGENT_ACTOR_KIND: ${legacyActor}`);
  }
  return adapter;
}

function assertLegacySelectionDoesNotConflict(
  env: NodeJS.ProcessEnv,
  adapter: FilmAgentAdapterKind,
) {
  if (
    env.FILMOS_AGENT_MODE?.trim() === "human_only" &&
    adapter !== "human_only"
  ) {
    throw new Error("FILMOS_AGENT_PROFILE conflicts with FILMOS_AGENT_MODE");
  }
  const legacyActor = env.FILMOS_AGENT_ACTOR_KIND?.trim();
  if (!legacyActor) return;
  const legacyAdapter = LEGACY_ACTOR_ADAPTERS[legacyActor as FilmActorKind];
  if (!legacyAdapter || legacyAdapter !== adapter) {
    throw new Error(
      "FILMOS_AGENT_PROFILE conflicts with FILMOS_AGENT_ACTOR_KIND",
    );
  }
}

function resolveActorId(value: string | undefined, actorKind: FilmActorKind) {
  const actorId = (value || `${actorKind}-mcp`).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(actorId)) {
    throw new Error("FILMOS_AGENT_ACTOR_ID is invalid");
  }
  return actorId;
}

import { problem, sha256 } from "./canonical.mjs";
import {
  ARCHITECTURE_PROTOCOL_VERSION,
  ARCHITECTURE_STATE_MAPPING_VERSION,
  ARCHITECTURE_TRANSITION_CONTRACT_HASH,
  architectureSemanticProjection,
  assertArchitectureTransition,
  normalizeLegacyArchitectureState,
} from "./architecture-protocol.mjs";

const ANCHOR_EVENT_TYPE = "protocol.v2.anchored";

export function anchorLegacyArchitectureIssue({ store, current, migrationCommit, now = new Date() }) {
  if (current?.lane !== "architecture") throw problem("ARCHITECTURE_LANE_REQUIRED");
  if (!/^[0-9a-f]{40}$/.test(String(migrationCommit ?? ""))) throw problem("INVALID_ARCHITECTURE_MIGRATION_COMMIT");
  if (current.protocol_v2_anchor) {
    if (current.protocol_v2_anchor.migration_commit !== migrationCommit) throw problem("ARCHITECTURE_V2_ANCHOR_CONFLICT", "ARCHITECTURE_V2_ANCHOR_CONFLICT", 409);
    return { issue: structuredClone(current), verification: verifyArchitectureProtocol({ store, current }), idempotent_replay: true };
  }
  if (current.architecture_protocol_version === ARCHITECTURE_PROTOCOL_VERSION) throw problem("ARCHITECTURE_LEGACY_ANCHOR_NOT_REQUIRED");
  if (!verifyHashChain(store.events(current.issue_id))) throw problem("LEGACY_HASH_CHAIN_INVALID", "LEGACY_HASH_CHAIN_INVALID", 409);

  const legacyEvents = store.events(current.issue_id);
  const lastEvent = legacyEvents.at(-1);
  if (!lastEvent) throw problem("LEGACY_EVENT_CHAIN_REQUIRED");
  const normalizedV2ProjectionHash = sha256(architectureSemanticProjection(current));
  const anchorBase = {
    schema_version: "filmos.architecture-transition-anchor.v2",
    issue_id: current.issue_id,
    legacy_last_event_hash: lastEvent.event_hash,
    legacy_projection_hash: current.content_hash,
    legacy_entity_version: current.entity_version,
    normalized_v2_projection_hash: normalizedV2ProjectionHash,
    state_mapping_version: ARCHITECTURE_STATE_MAPPING_VERSION,
    transition_contract_hash: ARCHITECTURE_TRANSITION_CONTRACT_HASH,
    migration_commit: migrationCommit,
    anchored_at: now.toISOString(),
  };
  const anchor = { ...anchorBase, anchor_hash: sha256(anchorBase) };
  const issue = store.append({
    issueId: current.issue_id,
    projectId: current.project_id,
    lane: current.lane,
    eventType: ANCHOR_EVENT_TYPE,
    actor: "system",
    payload: { anchor },
    now,
    transitionAction: "protocol.v2.anchor",
    mutate: (next) => {
      next.state = normalizeLegacyArchitectureState(next.state);
      next.architecture_protocol_version = ARCHITECTURE_PROTOCOL_VERSION;
      next.architecture_state_mapping_version = ARCHITECTURE_STATE_MAPPING_VERSION;
      next.architecture_transition_contract_hash = ARCHITECTURE_TRANSITION_CONTRACT_HASH;
      next.freeze_receipts ??= {};
      next.protocol_v2_anchor = anchor;
      return next;
    },
  });
  return { issue, verification: verifyArchitectureProtocol({ store, current: issue }), idempotent_replay: false };
}

export function verifyArchitectureProtocol({ store, current }) {
  if (current?.lane !== "architecture") throw problem("ARCHITECTURE_LANE_REQUIRED");
  const events = store.events(current.issue_id);
  const anchors = events.filter((event) => event.event_type === ANCHOR_EVENT_TYPE);
  if (anchors.length !== 1 || !current.protocol_v2_anchor) {
    return {
      legacy_hash_chain: verifyHashChain(events),
      legacy_result: verifyHashChain(events) ? "LEGACY_HASH_CHAIN_VALID" : "LEGACY_HASH_CHAIN_INVALID",
      v2_semantic_chain_from_anchor: false,
      v2_result: "V2_ANCHOR_REQUIRED",
      full_history_semantic_pass: false,
    };
  }
  const anchorIndex = events.findIndex((event) => event.event_id === anchors[0].event_id);
  const legacyEvents = events.slice(0, anchorIndex);
  const v2Events = events.slice(anchorIndex);
  const legacyValid = verifyHashChain(legacyEvents)
    && anchors[0].previous_hash === (legacyEvents.at(-1)?.event_hash ?? null)
    && anchors[0].payload?.anchor?.legacy_last_event_hash === (legacyEvents.at(-1)?.event_hash ?? null);
  const semanticValid = legacyValid && verifyV2Transitions(v2Events, current);
  return {
    legacy_hash_chain: legacyValid,
    legacy_result: legacyValid ? "LEGACY_HASH_CHAIN_VALID" : "LEGACY_HASH_CHAIN_INVALID",
    v2_semantic_chain_from_anchor: semanticValid,
    v2_result: semanticValid ? "V2_SEMANTIC_CHAIN_VALID_FROM_ANCHOR" : "V2_SEMANTIC_CHAIN_INVALID_FROM_ANCHOR",
    anchor_event_id: anchors[0].event_id,
    anchor_hash: current.protocol_v2_anchor.anchor_hash,
    full_history_semantic_pass: false,
  };
}

function verifyV2Transitions(events, current) {
  let previousPostHash = null;
  for (const [index, event] of events.entries()) {
    const transition = event.payload?.transition;
    if (!transition
      || transition.transition_contract_version !== ARCHITECTURE_PROTOCOL_VERSION
      || transition.transition_contract_hash !== ARCHITECTURE_TRANSITION_CONTRACT_HASH) return false;
    if (index === 0) {
      if (transition.action !== "protocol.v2.anchor") return false;
      if (transition.pre_projection_hash !== event.payload?.anchor?.normalized_v2_projection_hash) return false;
    } else if (transition.pre_projection_hash !== previousPostHash) return false;
    try {
      assertArchitectureTransition({
        current: { lane: "architecture", state: transition.from_state },
        action: transition.action,
        actor: event.actor,
        nextState: transition.to_state,
      });
    } catch {
      return false;
    }
    previousPostHash = transition.post_projection_hash;
  }
  return previousPostHash === sha256(architectureSemanticProjection(current));
}

function verifyHashChain(events) {
  let previousHash = null;
  for (const event of events) {
    if (event.previous_hash !== previousHash) return false;
    const eventBase = {
      event_id: event.event_id,
      issue_id: event.issue_id,
      event_type: event.event_type,
      actor: event.actor,
      payload: event.payload,
      previous_hash: event.previous_hash,
      created_at: event.created_at,
    };
    if (sha256(eventBase) !== event.event_hash) return false;
    previousHash = event.event_hash;
  }
  return true;
}

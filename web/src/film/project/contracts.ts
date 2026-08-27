export const FILM_CONTENT_UNIT_KINDS = ["chapter", "episode", "special", "trailer", "extra", "film", "season", "arc", "volume"] as const;

export const FILM_CREATIVE_STAGES = ["draft", "authored", "reviewed", "locked"] as const;
export const FILM_EXECUTION_STATES = ["not_started", "ready", "queued", "running", "succeeded", "failed", "cancelled"] as const;
export const FILM_REVIEW_STATES = ["not_reviewed", "pending", "in_review", "changes_requested", "rejected", "passed", "approved"] as const;
export const FILM_LOCK_STATES = ["unlocked", "soft_locked", "locked"] as const;
export const FILM_DELIVERY_STATES = ["not_ready", "ready", "packaged", "delivered", "superseded"] as const;
export const FILM_STALE_STATES = ["fresh", "stale", "blocked"] as const;

export type FilmContentUnitKind = (typeof FILM_CONTENT_UNIT_KINDS)[number];
export type FilmCreativeStage = (typeof FILM_CREATIVE_STAGES)[number];
export type FilmExecutionState = (typeof FILM_EXECUTION_STATES)[number];
export type FilmReviewState = (typeof FILM_REVIEW_STATES)[number];
export type FilmLockState = (typeof FILM_LOCK_STATES)[number];
export type FilmDeliveryState = (typeof FILM_DELIVERY_STATES)[number];
export type FilmStaleState = (typeof FILM_STALE_STATES)[number];

// Shape is intentionally identical to film-contracts/schemas/core.schema.json.
// This Track owns only the adapter; the shared schema remains the contract source.
export type FilmFormalStateAxes = {
    creative_stage: FilmCreativeStage;
    execution_state: FilmExecutionState;
    review_state: FilmReviewState;
    lock_state: FilmLockState;
    delivery_state: FilmDeliveryState;
    stale_state: FilmStaleState;
};

export type FilmContentUnitExtension = {
    ref: {
        film_entity_id: string;
        entity_type: "content_unit_extension";
        version: number;
        content_hash: string;
    };
    host: {
        host_project_id: string;
        host_unit_id: string;
    };
    states: FilmFormalStateAxes;
    unit_kind: FilmContentUnitKind;
};

const contentUnitKindSet = new Set<string>(FILM_CONTENT_UNIT_KINDS);
const creativeStageSet = new Set<string>(FILM_CREATIVE_STAGES);
const executionStateSet = new Set<string>(FILM_EXECUTION_STATES);
const reviewStateSet = new Set<string>(FILM_REVIEW_STATES);
const lockStateSet = new Set<string>(FILM_LOCK_STATES);
const deliveryStateSet = new Set<string>(FILM_DELIVERY_STATES);
const staleStateSet = new Set<string>(FILM_STALE_STATES);
const filmEntityIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const contentHashPattern = /^[0-9a-f]{64}$/;

export function isFilmContentUnitKind(value: unknown): value is FilmContentUnitKind {
    return typeof value === "string" && contentUnitKindSet.has(value);
}

export function isFilmContentUnitExtension(value: unknown): value is FilmContentUnitExtension {
    if (!isRecord(value) || !isRecord(value.ref) || !isRecord(value.host) || !isRecord(value.states)) return false;
    return (
        typeof value.ref.film_entity_id === "string" &&
        filmEntityIdPattern.test(value.ref.film_entity_id) &&
        value.ref.entity_type === "content_unit_extension" &&
        Number.isInteger(value.ref.version) &&
        Number(value.ref.version) >= 1 &&
        typeof value.ref.content_hash === "string" &&
        contentHashPattern.test(value.ref.content_hash) &&
        typeof value.host.host_unit_id === "string" &&
        value.host.host_unit_id.trim().length > 0 &&
        typeof value.host.host_project_id === "string" &&
        value.host.host_project_id.trim().length > 0 &&
        isFilmContentUnitKind(value.unit_kind) &&
        creativeStageSet.has(String(value.states.creative_stage)) &&
        executionStateSet.has(String(value.states.execution_state)) &&
        reviewStateSet.has(String(value.states.review_state)) &&
        lockStateSet.has(String(value.states.lock_state)) &&
        deliveryStateSet.has(String(value.states.delivery_state)) &&
        staleStateSet.has(String(value.states.stale_state))
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

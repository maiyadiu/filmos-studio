export const FILM_PRODUCTION_CANVAS_ROLE = "production" as const;
export const FILM_PRODUCTION_CANVAS_DEFAULT_ENABLED = false;

export const FILM_PRODUCTION_CANVAS_LANES = ["scene", "director_unit", "shot_coverage", "candidate_approved", "task_review"] as const;

export type FilmProductionCanvasLane = (typeof FILM_PRODUCTION_CANVAS_LANES)[number];

export type FilmProductionCanvasNodeKind = "scene" | "director_unit" | "shot" | "coverage_link" | "asset_binding" | "previs" | "prompt_draft" | "candidate" | "approved" | "review";

export type FilmProductionEntity = {
    id: string;
    kind: FilmProductionCanvasNodeKind;
    position?: number;
};

export type FilmProductionRelation = {
    id: string;
    fromEntityId: string;
    toEntityId: string;
    kind: "contains" | "directs" | "coverage" | "binds" | "derives" | "reviews";
};

export type FilmProductionCanvasSnapshot = {
    hostProjectId: string;
    hostUnitId: string;
    filmCoreVersion: number;
    contentHash: string;
    entities: FilmProductionEntity[];
    relations: FilmProductionRelation[];
};

export type FilmProductionCanvasLayout = {
    x: number;
    y: number;
};

export type FilmProductionCanvasNode = {
    id: string;
    entityId: string;
    kind: FilmProductionCanvasNodeKind;
    lane: FilmProductionCanvasLane;
    layout: FilmProductionCanvasLayout;
};

export type FilmProductionCanvasEdge = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    kind: FilmProductionRelation["kind"];
};

export type FilmProductionCanvasProjection = {
    schemaVersion: 1;
    scope: {
        role: typeof FILM_PRODUCTION_CANVAS_ROLE;
        hostProjectId: string;
        hostUnitId: string;
    };
    source: {
        filmCoreVersion: number;
        contentHash: string;
    };
    nodes: FilmProductionCanvasNode[];
    edges: FilmProductionCanvasEdge[];
};

export type FilmCanvasUnitLink = {
    canvasId: string;
    unitId: string;
    role: string;
};

export type FilmCanvasSummary = {
    id: string;
};

export type ProductionCanvasNavigation = { state: "disabled" } | { state: "create_required"; unitId: string } | { state: "reuse"; canvasId: string; href: string } | { state: "conflict"; canvasIds: string[]; reason: string };

export type CreateProductionCanvasCommand = {
    type: "film.production_canvas.create";
    role: typeof FILM_PRODUCTION_CANVAS_ROLE;
    hostProjectId: string;
    hostUnitId: string;
    expectedRevision: number;
    expectedContentHash: string;
};

export type GeneratedCandidate = {
    id: string;
    kind: "candidate";
    providerResultId: string;
};

const LANE_X: Record<FilmProductionCanvasLane, number> = {
    scene: 0,
    director_unit: 420,
    shot_coverage: 840,
    candidate_approved: 1260,
    task_review: 1680,
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function isFilmProductionCanvasEnabled(explicit?: boolean) {
    return explicit ?? FILM_PRODUCTION_CANVAS_DEFAULT_ENABLED;
}

export function resolveProductionCanvasNavigation(input: { enabled?: boolean; unitId: string; links: FilmCanvasUnitLink[]; canvases: FilmCanvasSummary[] }): ProductionCanvasNavigation {
    if (!isFilmProductionCanvasEnabled(input.enabled)) return { state: "disabled" };
    const unitId = requiredId(input.unitId, "unitId");
    const knownCanvasIds = new Set(input.canvases.map((canvas) => canvas.id));
    const productionCanvasIds = Array.from(new Set(input.links.filter((link) => link.unitId === unitId && link.role === FILM_PRODUCTION_CANVAS_ROLE && knownCanvasIds.has(link.canvasId)).map((link) => link.canvasId))).sort();

    if (!productionCanvasIds.length) return { state: "create_required", unitId };
    if (productionCanvasIds.length > 1) {
        return {
            state: "conflict",
            canvasIds: productionCanvasIds,
            reason: "同一 ContentUnit 存在多个 production 画布，需先由正式数据层裁决，禁止静默选择。",
        };
    }
    const canvasId = productionCanvasIds[0];
    return { state: "reuse", canvasId, href: `/canvas/${encodeURIComponent(canvasId)}` };
}

export function buildCreateProductionCanvasCommand(input: { hostProjectId: string; hostUnitId: string; expectedRevision: number; expectedContentHash: string }): CreateProductionCanvasCommand {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error("expectedRevision 必须是非负安全整数");
    }
    if (!HASH_PATTERN.test(input.expectedContentHash)) {
        throw new Error("expectedContentHash 必须是小写 SHA-256");
    }
    return {
        type: "film.production_canvas.create",
        role: FILM_PRODUCTION_CANVAS_ROLE,
        hostProjectId: requiredId(input.hostProjectId, "hostProjectId"),
        hostUnitId: requiredId(input.hostUnitId, "hostUnitId"),
        expectedRevision: input.expectedRevision,
        expectedContentHash: input.expectedContentHash,
    };
}

export function candidateFromGeneratedResult(input: { id: string; providerResultId: string }): GeneratedCandidate {
    return {
        id: requiredId(input.id, "candidateId"),
        kind: "candidate",
        providerResultId: requiredId(input.providerResultId, "providerResultId"),
    };
}

export function projectProductionCanvas(snapshot: FilmProductionCanvasSnapshot, existingLayout: Readonly<Record<string, FilmProductionCanvasLayout>> = {}): FilmProductionCanvasProjection {
    validateSnapshot(snapshot);
    const entityIds = new Set(snapshot.entities.map((entity) => entity.id));
    const nodes = snapshot.entities
        .slice()
        .sort(compareEntities)
        .map((entity, index, ordered) => {
            const id = productionCanvasNodeId(entity);
            return {
                id,
                entityId: entity.id,
                kind: entity.kind,
                lane: laneForKind(entity.kind),
                layout: existingLayout[id] ?? defaultLayout(entity, index, ordered),
            };
        });
    const nodeByEntityId = new Map(nodes.map((node) => [node.entityId, node.id]));
    const edges = snapshot.relations
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((relation) => {
            if (!entityIds.has(relation.fromEntityId) || !entityIds.has(relation.toEntityId)) {
                throw new Error(`关系 ${relation.id} 引用了不在正式快照中的实体`);
            }
            return {
                id: `film:relation:${relation.id}`,
                fromNodeId: nodeByEntityId.get(relation.fromEntityId)!,
                toNodeId: nodeByEntityId.get(relation.toEntityId)!,
                kind: relation.kind,
            };
        });

    return {
        schemaVersion: 1,
        scope: {
            role: FILM_PRODUCTION_CANVAS_ROLE,
            hostProjectId: snapshot.hostProjectId,
            hostUnitId: snapshot.hostUnitId,
        },
        source: {
            filmCoreVersion: snapshot.filmCoreVersion,
            contentHash: snapshot.contentHash,
        },
        nodes,
        edges,
    };
}

function validateSnapshot(snapshot: FilmProductionCanvasSnapshot) {
    requiredId(snapshot.hostProjectId, "hostProjectId");
    requiredId(snapshot.hostUnitId, "hostUnitId");
    if (!Number.isSafeInteger(snapshot.filmCoreVersion) || snapshot.filmCoreVersion < 0) {
        throw new Error("filmCoreVersion 必须是非负安全整数");
    }
    if (!HASH_PATTERN.test(snapshot.contentHash)) throw new Error("contentHash 必须是小写 SHA-256");
    const ids = new Set<string>();
    for (const entity of snapshot.entities) {
        requiredId(entity.id, "entityId");
        if (ids.has(entity.id)) throw new Error(`正式快照包含重复实体 ID：${entity.id}`);
        ids.add(entity.id);
    }
}

function productionCanvasNodeId(entity: FilmProductionEntity) {
    return `film:${entity.kind}:${entity.id}`;
}

function compareEntities(left: FilmProductionEntity, right: FilmProductionEntity) {
    const laneDelta = FILM_PRODUCTION_CANVAS_LANES.indexOf(laneForKind(left.kind)) - FILM_PRODUCTION_CANVAS_LANES.indexOf(laneForKind(right.kind));
    if (laneDelta) return laneDelta;
    const positionDelta = (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
    return positionDelta || left.id.localeCompare(right.id);
}

function defaultLayout(entity: FilmProductionEntity, index: number, ordered: FilmProductionEntity[]) {
    const lane = laneForKind(entity.kind);
    const laneIndex = ordered.slice(0, index).filter((item) => laneForKind(item.kind) === lane).length;
    return { x: LANE_X[lane], y: laneIndex * 220 };
}

function laneForKind(kind: FilmProductionCanvasNodeKind): FilmProductionCanvasLane {
    if (kind === "scene") return "scene";
    if (kind === "director_unit") return "director_unit";
    if (["shot", "coverage_link", "asset_binding", "previs", "prompt_draft"].includes(kind)) return "shot_coverage";
    if (kind === "candidate" || kind === "approved") return "candidate_approved";
    return "task_review";
}

function requiredId(value: string, field: string) {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${field} 不能为空`);
    return normalized;
}

import { FILM_CONTENT_UNIT_KINDS, type FilmContentUnitKind } from "./contracts";
import { projectFilmContentUnits, type FilmContentUnitProjection, type HostProjectSnapshot } from "./host-adapter";

export const FILM_CONTENT_UNIT_KIND_LABELS: Record<FilmContentUnitKind | "unknown", string> = {
    chapter: "章",
    episode: "集",
    special: "特别篇",
    trailer: "预告",
    extra: "番外",
    film: "电影",
    season: "季",
    arc: "故事弧",
    volume: "卷",
    unknown: "未识别",
};

export type FilmProjectOverviewProjection = {
    units: FilmContentUnitProjection[];
    totalUnitCount: number;
    kindCounts: Array<{ kind: FilmContentUnitKind | "unknown"; label: string; count: number }>;
    linkedCanvasUnitCount: number;
    shotCoveredUnitCount: number;
    formalStateUnitCount: number;
    creativeLockedUnitCount: number;
    reviewAttentionUnitCount: number;
    staleUnitCount: number;
    blockedUnitCount: number;
    hasFormalStateData: boolean;
};

export function projectFilmOverview(
    detail: HostProjectSnapshot,
    extensionCandidates: readonly unknown[] = [],
): FilmProjectOverviewProjection {
    const units = projectFilmContentUnits(detail, extensionCandidates);
    const kindCountMap = new Map<FilmContentUnitKind | "unknown", number>();
    for (const unit of units) kindCountMap.set(unit.kind, (kindCountMap.get(unit.kind) || 0) + 1);
    const orderedKinds: Array<FilmContentUnitKind | "unknown"> = [...FILM_CONTENT_UNIT_KINDS, "unknown"];
    const kindCounts = orderedKinds
        .filter((kind) => kindCountMap.has(kind))
        .map((kind) => ({ kind, label: FILM_CONTENT_UNIT_KIND_LABELS[kind], count: kindCountMap.get(kind) || 0 }));
    const formalUnits = units.filter((unit) => unit.states);
    const reviewAttention = new Set(["pending", "in_review", "changes_requested", "rejected"]);
    return {
        units,
        totalUnitCount: units.length,
        kindCounts,
        linkedCanvasUnitCount: units.filter((unit) => unit.canvasIds.length > 0).length,
        shotCoveredUnitCount: units.filter((unit) => unit.shotIds.length > 0).length,
        formalStateUnitCount: formalUnits.length,
        creativeLockedUnitCount: formalUnits.filter((unit) => unit.states?.creative_stage === "locked").length,
        reviewAttentionUnitCount: formalUnits.filter((unit) => reviewAttention.has(unit.states!.review_state)).length,
        staleUnitCount: formalUnits.filter((unit) => unit.states?.stale_state === "stale").length,
        blockedUnitCount: formalUnits.filter((unit) => unit.states?.stale_state === "blocked").length,
        hasFormalStateData: formalUnits.length > 0,
    };
}

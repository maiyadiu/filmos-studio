import type { CanvasUnitLink, ProjectCanvas, ProjectDetail, ProjectShot, ProjectUnit } from "@/services/api/projects";

import {
    isFilmContentUnitExtension,
    isFilmContentUnitKind,
    type FilmContentUnitExtension,
    type FilmContentUnitKind,
    type FilmFormalStateAxes,
} from "./contracts";

export type HostProjectUnit = Pick<ProjectUnit, "id" | "projectId" | "kind" | "title" | "status" | "position" | "createdAt" | "updatedAt"> & {
    parentId?: string;
};

export type HostProjectSnapshot = {
    project: Pick<ProjectDetail["project"], "id">;
    units: HostProjectUnit[];
    canvases: Pick<ProjectCanvas, "id" | "title" | "updatedAt">[];
    canvasUnitLinks: Pick<CanvasUnitLink, "id" | "canvasId" | "unitId" | "role" | "createdAt">[];
    shots: Pick<ProjectShot, "id" | "unitId">[];
};

export type FilmCanvasNavigationTarget = {
    canvasId: string;
    title: string;
    role: string;
    href: string;
};

export type FilmContentUnitProjection = {
    hostProjectId: string;
    hostUnitId: string;
    hostKind: string;
    kind: FilmContentUnitKind | "unknown";
    parentId?: string;
    title: string;
    hostStatus: string;
    position: number;
    createdAt: string;
    updatedAt: string;
    states: FilmFormalStateAxes | null;
    extension: FilmContentUnitExtension | null;
    canvasIds: string[];
    shotIds: string[];
    productionCanvas: FilmCanvasNavigationTarget | null;
};

export function projectFilmContentUnits(
    snapshot: HostProjectSnapshot,
    extensionCandidates: readonly unknown[] = [],
): FilmContentUnitProjection[] {
    const extensions = latestExtensionsByHostUnit(snapshot.project.id, extensionCandidates);
    const canvasLinksByUnit = groupCanvasLinksByUnit(snapshot.canvasUnitLinks);
    const shotIdsByUnit = groupShotIdsByUnit(snapshot.shots);
    return [...snapshot.units]
        .sort(compareHostUnits)
        .map((unit) => {
            const extension = extensions.get(unit.id) || null;
            const canvasLinks = uniqueCanvasLinks(canvasLinksByUnit.get(unit.id) || []);
            const shotIds = shotIdsByUnit.get(unit.id) || [];
            return {
                hostProjectId: snapshot.project.id,
                hostUnitId: unit.id,
                hostKind: unit.kind,
                kind: extension?.unit_kind || (isFilmContentUnitKind(unit.kind) ? unit.kind : "unknown"),
                parentId: unit.parentId || undefined,
                title: unit.title,
                hostStatus: unit.status,
                position: unit.position,
                createdAt: unit.createdAt,
                updatedAt: unit.updatedAt,
                states: extension?.states || null,
                extension,
                canvasIds: canvasLinks.map((link) => link.canvasId),
                shotIds,
                productionCanvas: resolveProductionCanvas(canvasLinks, snapshot.canvases),
            };
        });
}

function groupCanvasLinksByUnit(links: HostProjectSnapshot["canvasUnitLinks"]) {
    const result = new Map<string, HostProjectSnapshot["canvasUnitLinks"]>();
    for (const link of links) {
        const unitLinks = result.get(link.unitId);
        if (unitLinks) unitLinks.push(link);
        else result.set(link.unitId, [link]);
    }
    return result;
}

function groupShotIdsByUnit(shots: HostProjectSnapshot["shots"]) {
    const result = new Map<string, string[]>();
    for (const shot of shots) {
        if (!shot.unitId) continue;
        const shotIds = result.get(shot.unitId);
        if (shotIds) shotIds.push(shot.id);
        else result.set(shot.unitId, [shot.id]);
    }
    return result;
}

function latestExtensionsByHostUnit(projectId: string, candidates: readonly unknown[]) {
    const result = new Map<string, FilmContentUnitExtension>();
    for (const candidate of candidates) {
        if (!isFilmContentUnitExtension(candidate)) continue;
        const hostUnitId = candidate.host.host_unit_id!.trim();
        const hostProjectId = candidate.host.host_project_id?.trim();
        if (hostProjectId && hostProjectId !== projectId) continue;
        const current = result.get(hostUnitId);
        if (!current || candidate.ref.version > current.ref.version || (candidate.ref.version === current.ref.version && candidate.ref.content_hash.localeCompare(current.ref.content_hash) > 0)) {
            result.set(hostUnitId, candidate);
        }
    }
    return result;
}

function compareHostUnits(left: HostProjectUnit, right: HostProjectUnit) {
    return left.position - right.position
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id);
}

function uniqueCanvasLinks(links: HostProjectSnapshot["canvasUnitLinks"]) {
    const result = new Map<string, HostProjectSnapshot["canvasUnitLinks"][number]>();
    for (const link of links) {
        const current = result.get(link.canvasId);
        if (!current || compareCanvasLinkPreference(link, current) < 0) result.set(link.canvasId, link);
    }
    return [...result.values()].sort(compareCanvasLinkPreference);
}

function resolveProductionCanvas(
    links: HostProjectSnapshot["canvasUnitLinks"],
    canvases: HostProjectSnapshot["canvases"],
): FilmCanvasNavigationTarget | null {
    const canvasById = new Map(canvases.map((canvas) => [canvas.id, canvas]));
    const candidates = links
        .map((link) => ({ link, canvas: canvasById.get(link.canvasId) }))
        .filter((item): item is { link: HostProjectSnapshot["canvasUnitLinks"][number]; canvas: HostProjectSnapshot["canvases"][number] } => Boolean(item.canvas))
        .sort((left, right) => rolePriority(left.link.role) - rolePriority(right.link.role)
            || right.canvas.updatedAt.localeCompare(left.canvas.updatedAt)
            || left.canvas.id.localeCompare(right.canvas.id));
    const selected = candidates[0];
    return selected ? {
        canvasId: selected.canvas.id,
        title: selected.canvas.title,
        role: selected.link.role,
        href: `/canvas/${encodeURIComponent(selected.canvas.id)}`,
    } : null;
}

function compareCanvasLinkPreference(left: HostProjectSnapshot["canvasUnitLinks"][number], right: HostProjectSnapshot["canvasUnitLinks"][number]) {
    return rolePriority(left.role) - rolePriority(right.role)
        || right.createdAt.localeCompare(left.createdAt)
        || left.id.localeCompare(right.id);
}

function rolePriority(role: string) {
    if (role === "production") return 0;
    if (role === "storyboard") return 1;
    return 2;
}

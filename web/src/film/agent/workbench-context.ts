import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type WorkbenchContextV1 = {
    schemaVersion: "1";
    projectId: string;
    domainProjectId?: string;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    canvasId: string;
    title: string;
    selectedNodeIds: string[];
    visibleNodeIds: string[];
    assetVersionIds: string[];
    filmExpectedVersion?: number;
    filmContentHash?: string;
    activePanel: string;
};

export type WorkbenchContextInput = {
    projectId: string;
    domainProjectId?: string;
    title: string;
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    filmExpectedVersion?: number;
    filmContentHash?: string;
    activePanel?: string;
};

export function buildWorkbenchContext(input: WorkbenchContextInput): WorkbenchContextV1 | undefined {
    if (!input.projectId) return undefined;
    const selected = input.nodes.filter((node) => input.selectedNodeIds.has(node.id));
    const scoped = selected.length ? selected : input.nodes;
    return {
        schemaVersion: "1",
        projectId: input.projectId,
        ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
        ...singleMetadataId(scoped, ["contentUnitId", "chapterId"], "contentUnitId"),
        ...singleMetadataId(scoped, ["sceneId"], "sceneId"),
        ...singleMetadataId(scoped, ["directorUnitId"], "directorUnitId"),
        ...singleMetadataId(scoped, ["shotId"], "shotId"),
        canvasId: input.projectId,
        title: input.title,
        selectedNodeIds: [...input.selectedNodeIds].sort(),
        visibleNodeIds: visibleNodeIds(input.nodes, input.viewport, input.viewportSize),
        assetVersionIds: assetVersionIds(scoped),
        ...(input.filmExpectedVersion !== undefined ? { filmExpectedVersion: input.filmExpectedVersion } : {}),
        ...(input.filmContentHash ? { filmContentHash: input.filmContentHash } : {}),
        activePanel: input.activePanel || "canvas",
    };
}

export function applyWorkbenchContext(snapshot: CanvasAgentSnapshot, context: WorkbenchContextV1 | undefined): CanvasAgentSnapshot {
    if (!context) return snapshot;
    return {
        ...snapshot,
        ...(context.domainProjectId ? { domainProjectId: context.domainProjectId } : {}),
        ...(context.contentUnitId ? { contentUnitId: context.contentUnitId } : {}),
        ...(context.sceneId ? { sceneId: context.sceneId } : {}),
        ...(context.directorUnitId ? { directorUnitId: context.directorUnitId } : {}),
        ...(context.shotId ? { shotId: context.shotId } : {}),
        visibleNodeIds: context.visibleNodeIds,
        assetVersionIds: context.assetVersionIds,
        ...(context.filmExpectedVersion !== undefined ? { filmExpectedVersion: context.filmExpectedVersion } : {}),
        ...(context.filmContentHash ? { filmContentHash: context.filmContentHash } : {}),
        activePanel: context.activePanel,
    };
}

export function publishWorkbenchContext(context: WorkbenchContextV1 | undefined) {
    if (typeof window === "undefined") return () => undefined;
    const getter = () => context ? structuredClone(context) : null;
    window.filmOSGetWorkbenchContext = getter;
    window.dispatchEvent(new CustomEvent("filmos:workbench-context", { detail: getter() }));
    return () => {
        if (window.filmOSGetWorkbenchContext === getter) delete window.filmOSGetWorkbenchContext;
    };
}

function singleMetadataId<K extends "contentUnitId" | "sceneId" | "directorUnitId" | "shotId">(nodes: CanvasNodeData[], keys: string[], output: K): Partial<Record<K, string>> {
    const values = new Set<string>();
    for (const node of nodes) {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        for (const key of keys) {
            const value = metadata?.[key];
            if (typeof value === "string" && value.trim()) values.add(value.trim());
        }
    }
    const value = values.size === 1 ? [...values][0] : undefined;
    return value ? { [output]: value } as Partial<Record<K, string>> : {};
}

function assetVersionIds(nodes: CanvasNodeData[]) {
    const values = new Set<string>();
    for (const node of nodes) {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        for (const key of ["assetVersionId", "characterVersionId", "primaryVersionId"]) {
            const value = metadata?.[key];
            if (typeof value === "string" && value.trim()) values.add(value.trim());
        }
        const bindings = metadata?.assetBindings;
        if (Array.isArray(bindings)) for (const binding of bindings) {
            if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
            const value = (binding as Record<string, unknown>).assetVersionId;
            if (typeof value === "string" && value.trim()) values.add(value.trim());
        }
    }
    return [...values].sort();
}

function visibleNodeIds(nodes: CanvasNodeData[], viewport: ViewportTransform, size: { width: number; height: number }) {
    if (size.width <= 0 || size.height <= 0 || viewport.k <= 0) return [];
    const left = -viewport.x / viewport.k;
    const top = -viewport.y / viewport.k;
    const right = left + size.width / viewport.k;
    const bottom = top + size.height / viewport.k;
    return nodes.filter((node) => {
        const nodeRight = node.position.x + node.width;
        const nodeBottom = node.position.y + node.height;
        return nodeRight >= left && node.position.x <= right && nodeBottom >= top && node.position.y <= bottom;
    }).map((node) => node.id).sort();
}

declare global {
    interface Window {
        filmOSGetWorkbenchContext?: () => WorkbenchContextV1 | null;
    }
}

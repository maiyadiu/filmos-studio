import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { postDesktopHostMessage } from "@/film/adapters/yingce/desktop-rpc-client";

export type WorkbenchContextV1 = {
    schemaVersion: "1";
    projectId: string;
    domainProjectId?: string;
    contentUnitId?: string;
    contentUnitKind?: "chapter" | "episode" | "special" | "trailer" | "extra" | "film" | "season" | "arc" | "volume";
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    canvasId: string;
    title: string;
    selectedNodeIds: string[];
    visibleNodeIds: string[];
    visibleNodeSummaries: Array<{ id: string; type: string; title?: string; status?: string }>;
    assetVersionIds: string[];
    canvasRevision: number;
    canvasStateHash?: string;
    contextReceiptId?: string;
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
    canvasRevision?: number;
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
        ...singleContentUnitKind(scoped),
        ...singleMetadataId(scoped, ["sceneId"], "sceneId"),
        ...singleMetadataId(scoped, ["directorUnitId"], "directorUnitId"),
        ...singleMetadataId(scoped, ["shotId"], "shotId"),
        canvasId: input.projectId,
        title: input.title,
        selectedNodeIds: [...input.selectedNodeIds].sort(),
        visibleNodeIds: visibleNodeIds(input.nodes, input.viewport, input.viewportSize),
        visibleNodeSummaries: visibleNodeSummaries(input.nodes, input.viewport, input.viewportSize),
        assetVersionIds: assetVersionIds(scoped),
        canvasRevision: Number.isSafeInteger(input.canvasRevision) && Number(input.canvasRevision) >= 0 ? Number(input.canvasRevision) : 0,
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
    let active = true;
    const published = context ? structuredClone(context) : null;
    const getter = () => published ? structuredClone(published) : null;
    window.filmOSGetWorkbenchContext = getter;
    window.dispatchEvent(new CustomEvent("filmos:workbench-context", { detail: getter() }));
    if (!context || !context.domainProjectId) postDesktopHostMessage({ action: "workbenchContextChanged", projectId: "", canvasId: context?.canvasId || "", contextReceiptId: "", context: null });
    if (context?.domainProjectId) void buildLiveWorkbenchContextDraft(context).then((liveContext) => {
        if (!active) return;
        if (published) {
            published.canvasStateHash = liveContext.canvas_state_hash;
            published.contextReceiptId = liveContext.context_receipt_id;
        }
        window.dispatchEvent(new CustomEvent("filmos:workbench-context", { detail: getter() }));
        postDesktopHostMessage({
            action: "workbenchContextChanged",
            projectId: context.domainProjectId || "",
            canvasId: context.canvasId,
            contextReceiptId: liveContext.context_receipt_id,
            context: liveContext,
        });
    });
    return () => {
        active = false;
        if (window.filmOSGetWorkbenchContext === getter) delete window.filmOSGetWorkbenchContext;
    };
}

export type LiveWorkbenchContextDraft = {
    project_id: string;
    content_unit_id: string | null;
    content_unit_kind: WorkbenchContextV1["contentUnitKind"] | null;
    scene_id: string | null;
    director_unit_id: string | null;
    shot_id: string | null;
    canvas_id: string;
    selected_node_ids: string[];
    visible_node_summaries: Array<{ id: string; type: string; title?: string; status?: string }>;
    asset_version_ids: string[];
    canvas_revision: number;
    canvas_state_hash: string;
    film_expected_version: null;
    film_content_hash: null;
    context_receipt_id: string;
};

export async function buildLiveWorkbenchContextDraft(context: WorkbenchContextV1): Promise<LiveWorkbenchContextDraft> {
    if (!context.domainProjectId) throw new Error("DOMAIN_PROJECT_REQUIRED");
    const projection = {
        schema_version: "filmos.live-workbench-context-draft/v1",
        project_id: context.domainProjectId,
        content_unit_id: context.contentUnitId ?? null,
        content_unit_kind: context.contentUnitKind ?? null,
        scene_id: context.sceneId ?? null,
        director_unit_id: context.directorUnitId ?? null,
        shot_id: context.shotId ?? null,
        canvas_id: context.canvasId,
        selected_node_ids: [...context.selectedNodeIds].sort(),
        visible_node_summaries: [...context.visibleNodeSummaries].sort((left, right) => left.id.localeCompare(right.id)),
        asset_version_ids: [...context.assetVersionIds].sort(),
        canvas_revision: context.canvasRevision,
    };
    const canvasStateHash = await sha256(JSON.stringify(projection));
    return {
        ...projection,
        canvas_state_hash: canvasStateHash,
        film_expected_version: null,
        film_content_hash: null,
        context_receipt_id: `workbench:${canvasStateHash}`,
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

function singleContentUnitKind(nodes: CanvasNodeData[]): Pick<WorkbenchContextV1, "contentUnitKind"> | Record<string, never> {
    const allowed = new Set<NonNullable<WorkbenchContextV1["contentUnitKind"]>>(["chapter", "episode", "special", "trailer", "extra", "film", "season", "arc", "volume"]);
    const values = new Set<NonNullable<WorkbenchContextV1["contentUnitKind"]>>();
    for (const node of nodes) {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        for (const key of ["contentUnitKind", "unitKind"]) {
            const value = metadata?.[key];
            if (typeof value === "string" && allowed.has(value as NonNullable<WorkbenchContextV1["contentUnitKind"]>)) values.add(value as NonNullable<WorkbenchContextV1["contentUnitKind"]>);
        }
        if (typeof metadata?.chapterId === "string" && metadata.chapterId.trim()) values.add("chapter");
    }
    return values.size === 1 ? { contentUnitKind: [...values][0] } : {};
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

function visibleNodeSummaries(nodes: CanvasNodeData[], viewport: ViewportTransform, size: { width: number; height: number }) {
    const visible = new Set(visibleNodeIds(nodes, viewport, size));
    return nodes.filter((node) => visible.has(node.id)).map((node) => {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        const status = [metadata?.status, metadata?.generationStatus, metadata?.taskStatus].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
        return {
            id: node.id,
            type: String(node.type),
            ...(node.title.trim() ? { title: node.title.trim() } : {}),
            ...(status ? { status: status.trim() } : {}),
        };
    }).sort((left, right) => left.id.localeCompare(right.id));
}

async function sha256(value: string) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

declare global {
    interface Window {
        filmOSGetWorkbenchContext?: () => WorkbenchContextV1 | null;
        filmOSChatGPTHostStatus?: FilmOSDesktopChatGPTHostStatus;
    }
}

export type FilmOSDesktopChatGPTHostStatus = {
    publishedAt: string;
    profileId: string;
    state: string;
    authorizedProjectId?: string;
    authorizedGrantId?: string;
    grantExpiresAt?: string;
    tunnelConnected: boolean;
    externalAccountConnected: boolean;
    mcpToolCount: number;
    mcpReadToolCount: number;
    mcpWriteToolCount: number;
    mcpPaidToolCount: number;
    mcpDestructiveToolCount: number;
    billingMode: string;
    lastReadAt?: string;
    lastExternalToolName?: string;
    lastExternalRequestId?: string;
    observedHandoffId?: string;
    proposalHandoffEnabled: boolean;
};

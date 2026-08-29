import crypto from "node:crypto";

import type { AgentContextPackV1, AgentContextReceipt, BrainSession, EntitySummary } from "./contracts.js";

export type WorkbenchContextSnapshot = {
    workspace?: string;
    projectId: string;
    projectTitle?: string;
    projectStatus?: string;
    domainProjectId?: string;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    canvasId: string;
    canvasRevision: number;
    canvasStateHash: string;
    nodes: EntitySummary[];
    connections: Array<{ id: string; fromNodeId: string; toNodeId: string }>;
    selectedNodeIds: string[];
    visibleNodeIds: string[];
    assets: EntitySummary[];
    activeTasks?: EntitySummary[];
    blockers?: string[];
    filmExpectedVersion?: number;
    filmContentHash?: string;
    currentUnit?: EntitySummary;
    currentScene?: EntitySummary;
    currentDirectorUnit?: EntitySummary;
    currentShot?: EntitySummary;
    activePanel?: string;
    visualContext?: AgentContextPackV1["visualContext"];
};

type StoredReceipt = { receipt: AgentContextReceipt; sessionId: string };

export class AgentContextBroker {
    private readonly receipts = new Map<string, StoredReceipt>();

    capture(session: BrainSession, snapshot: WorkbenchContextSnapshot, ttlMs = 5 * 60_000) {
        assertScope(session, snapshot);
        if (!Number.isInteger(snapshot.canvasRevision) || snapshot.canvasRevision < 0) throw new Error("Canvas revision is invalid");
        if (!snapshot.canvasStateHash.trim()) throw new Error("Canvas state hash is required");
        const createdAt = new Date();
        const receipt: AgentContextReceipt = {
            receiptId: crypto.randomUUID(),
            projectId: snapshot.projectId,
            ...(snapshot.contentUnitId ? { contentUnitId: snapshot.contentUnitId } : {}),
            ...(snapshot.sceneId ? { sceneId: snapshot.sceneId } : {}),
            ...(snapshot.directorUnitId ? { directorUnitId: snapshot.directorUnitId } : {}),
            ...(snapshot.shotId ? { shotId: snapshot.shotId } : {}),
            canvasId: snapshot.canvasId,
            selectedNodeIds: [...snapshot.selectedNodeIds],
            visibleNodeIds: [...snapshot.visibleNodeIds],
            assetVersionIds: snapshot.assets.map((asset) => asset.id),
            canvasRevision: snapshot.canvasRevision,
            canvasStateHash: snapshot.canvasStateHash,
            ...(snapshot.filmExpectedVersion !== undefined ? { filmExpectedVersion: snapshot.filmExpectedVersion } : {}),
            ...(snapshot.filmContentHash ? { filmContentHash: snapshot.filmContentHash } : {}),
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
        };
        this.receipts.set(receipt.receiptId, { receipt, sessionId: session.id });
        const selectedIds = new Set(snapshot.selectedNodeIds);
        const pack: AgentContextPackV1 = {
            schemaVersion: "1",
            contextReceiptId: receipt.receiptId,
            capturedAt: receipt.createdAt,
            route: {
                ...(snapshot.workspace ? { workspace: snapshot.workspace } : {}),
                projectId: snapshot.projectId,
                ...(snapshot.contentUnitId ? { contentUnitId: snapshot.contentUnitId, unitId: snapshot.contentUnitId } : {}),
                ...(snapshot.sceneId ? { sceneId: snapshot.sceneId } : {}),
                ...(snapshot.directorUnitId ? { directorUnitId: snapshot.directorUnitId } : {}),
                ...(snapshot.shotId ? { shotId: snapshot.shotId } : {}),
                ...(snapshot.activePanel ? { activePanel: snapshot.activePanel } : {}),
            },
            project: {
                id: snapshot.projectId,
                ...(snapshot.projectTitle ? { title: snapshot.projectTitle } : {}),
                ...(snapshot.projectStatus ? { status: snapshot.projectStatus } : {}),
                ...(snapshot.domainProjectId ? { domainProjectId: snapshot.domainProjectId } : {}),
            },
            ...(snapshot.currentUnit ? { currentUnit: structuredClone(snapshot.currentUnit) } : {}),
            ...(snapshot.currentScene ? { currentScene: structuredClone(snapshot.currentScene) } : {}),
            ...(snapshot.currentDirectorUnit ? { currentDirectorUnit: structuredClone(snapshot.currentDirectorUnit) } : {}),
            ...(snapshot.currentShot ? { currentShot: structuredClone(snapshot.currentShot) } : {}),
            canvas: {
                id: snapshot.canvasId,
                revision: snapshot.canvasRevision,
                stateHash: snapshot.canvasStateHash,
                nodeCount: snapshot.nodes.length,
                connectionCount: snapshot.connections.length,
                selectedNodeIds: [...snapshot.selectedNodeIds],
                visibleNodeIds: [...snapshot.visibleNodeIds],
                selectedSummaries: snapshot.nodes.filter((node) => selectedIds.has(node.id)).map((node) => structuredClone(node)),
            },
            assets: snapshot.assets.map((asset) => structuredClone(asset)),
            activeTasks: (snapshot.activeTasks ?? []).map((task) => structuredClone(task)),
            blockers: [...(snapshot.blockers ?? [])],
            ...(snapshot.visualContext ? { visualContext: structuredClone(snapshot.visualContext) } : {}),
            permissions: {
                readableScopes: ["project", "canvas", "selection", "assets"],
                previewableScopes: ["canvas", "film"],
                applyRequiresConfirmation: true,
            },
            receipts: {
                ...(snapshot.filmExpectedVersion !== undefined ? { filmVersion: snapshot.filmExpectedVersion } : {}),
                ...(snapshot.filmContentHash ? { contentHash: snapshot.filmContentHash } : {}),
                canvasRevision: snapshot.canvasRevision,
                canvasStateHash: snapshot.canvasStateHash,
            },
        };
        return { pack, receipt: structuredClone(receipt) };
    }

    validate(receiptId: string, session: BrainSession, current: Pick<WorkbenchContextSnapshot, "projectId" | "canvasId" | "canvasRevision" | "canvasStateHash" | "filmExpectedVersion" | "filmContentHash">, now = new Date()) {
        const stored = this.receipts.get(receiptId);
        if (!stored) throw new Error("AGENT_CONTEXT_RECEIPT_NOT_FOUND");
        if (stored.sessionId !== session.id) throw new Error("AGENT_CONTEXT_SESSION_MISMATCH");
        const receipt = stored.receipt;
        if (Date.parse(receipt.expiresAt) <= now.getTime()) throw new Error("AGENT_CONTEXT_RECEIPT_EXPIRED");
        if (receipt.projectId !== current.projectId || receipt.canvasId !== current.canvasId) throw new Error("AGENT_CONTEXT_SCOPE_MISMATCH");
        if (receipt.canvasRevision !== current.canvasRevision || receipt.canvasStateHash !== current.canvasStateHash) throw new Error("AGENT_CONTEXT_CANVAS_STALE");
        if (receipt.filmExpectedVersion !== current.filmExpectedVersion || receipt.filmContentHash !== current.filmContentHash) throw new Error("AGENT_CONTEXT_FILM_STALE");
        return structuredClone(receipt);
    }

    revokeSession(sessionId: string) {
        for (const [receiptId, stored] of this.receipts) if (stored.sessionId === sessionId) this.receipts.delete(receiptId);
    }
}

function assertScope(session: BrainSession, snapshot: WorkbenchContextSnapshot) {
    if (!snapshot.projectId || !snapshot.canvasId) throw new Error("Workbench projectId and canvasId are required");
    if (session.projectId !== snapshot.projectId || session.canvasId !== snapshot.canvasId) throw new Error("AGENT_CONTEXT_SCOPE_MISMATCH");
    if (session.domainProjectId && snapshot.domainProjectId && session.domainProjectId !== snapshot.domainProjectId) throw new Error("AGENT_CONTEXT_DOMAIN_PROJECT_MISMATCH");
}

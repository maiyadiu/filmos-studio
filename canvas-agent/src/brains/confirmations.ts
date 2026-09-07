import crypto from "node:crypto";

import type { AgentConfirmation, AgentToolRisk } from "./contracts.js";

// Canonical confirmations are emitted before the browser tool call exists.
// Project only target IDs, base versions and counts, never source/prompt bodies.
export function projectToolConfirmationDetail(name: string, input: Record<string, unknown>, scope: { domainProjectId?: string; canvasId: string }) {
    if (!["project_create_script", "project_revise_script", "project_create_or_update_shots", "project_sync_storyboard", "project_save_prompt"].includes(name)) return "";
    const id = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9:_-]{1,100}$/.test(value) ? value : "（定位待核对）";
    const version = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? `v${value}` : "（版本待核对）";
    const project = `项目：${id(scope.domainProjectId)}`;
    if (name === "project_create_script") return `${project}；项目基版 ${version(input.expectedProjectRevision)}，新增 ${Array.isArray(input.chapters) ? input.chapters.length : 0} 个章节初稿，保留已有章节；不生成媒体。`;
    if (name === "project_save_prompt") return `${project}；画布：${id(scope.canvasId)}；节点：${id(input.nodeId)}；分镜行：${id(input.rowId)}；${input.kind === "image" ? "图片" : input.kind === "video" ? "视频" : "类型待核对"}稿基版 ${version(input.expectedRevision)}。仅保存文字，不生成媒体，旧版保留。`;
    const chapter = `${project}；章节：${id(input.unitId)}`;
    if (name === "project_revise_script") return `${chapter}；正文基版 ${version(input.expectedRevision)}，${Array.isArray(input.edits) ? input.edits.length : 0} 处精确修订，原版本保留。`;
    if (name === "project_sync_storyboard") return `${chapter}；同步分镜 ${version(input.expectedShotRevision)} 到当前画布 ${id(scope.canvasId)}，保留原节点和布局，不生成媒体。`;
    const shots = Array.isArray(input.shots) ? input.shots : [];
    const existing = shots.filter(shot => shot && typeof shot === "object" && typeof shot.id === "string" && shot.id.trim()).length;
    return `${chapter}；分镜批次基版 ${version(input.expectedShotRevision)}，新增 ${shots.length - existing} 镜、修订 ${existing} 镜，未指定镜头保留。`;
}

export type CreateConfirmationInput = {
    sessionId: string;
    turnId: string;
    requestId: string;
    toolName: string;
    risk: Exclude<AgentToolRisk, "read" | "draft">;
    title: string;
    summary: string;
    impact?: string[];
    contextReceiptId: string;
    expiresInMs?: number;
    costPreview?: AgentConfirmation["costPreview"];
};

export class AgentConfirmationStore {
    private readonly confirmations = new Map<string, AgentConfirmation>();

    create(input: CreateConfirmationInput) {
        const createdAt = new Date();
        const confirmation: AgentConfirmation = {
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            turnId: input.turnId,
            requestId: input.requestId,
            toolName: input.toolName,
            risk: input.risk,
            title: input.title,
            summary: input.summary,
            impact: [...(input.impact ?? [])],
            ...(input.costPreview ? { costPreview: structuredClone(input.costPreview) } : {}),
            contextReceiptId: input.contextReceiptId,
            status: "pending",
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + (input.expiresInMs ?? 5 * 60_000)).toISOString(),
        };
        this.confirmations.set(confirmation.id, confirmation);
        return structuredClone(confirmation);
    }

    get(confirmationId: string, now = new Date()) {
        const confirmation = this.confirmations.get(confirmationId);
        if (!confirmation) return undefined;
        this.expireIfNeeded(confirmation, now);
        return structuredClone(confirmation);
    }

    pendingForSession(sessionId: string, now = new Date()) {
        return [...this.confirmations.values()].filter(confirmation => {
            if (confirmation.sessionId !== sessionId) return false;
            this.expireIfNeeded(confirmation, now);
            return confirmation.status === "pending";
        }).map(confirmation => structuredClone(confirmation));
    }

    decide(confirmationId: string, input: { sessionId: string; actorId: string; approved: boolean; now?: Date }) {
        const confirmation = this.requireOwnedPending(confirmationId, input.sessionId, input.now);
        confirmation.status = input.approved ? "approved" : "rejected";
        confirmation.decidedAt = (input.now ?? new Date()).toISOString();
        confirmation.decidedBy = input.actorId;
        return structuredClone(confirmation);
    }

    consume(confirmationId: string, input: { sessionId: string; contextReceiptId: string; now?: Date }) {
        const confirmation = this.confirmations.get(confirmationId);
        if (!confirmation) throw new Error("AGENT_CONFIRMATION_NOT_FOUND");
        this.expireIfNeeded(confirmation, input.now ?? new Date());
        if (confirmation.sessionId !== input.sessionId) throw new Error("AGENT_CONFIRMATION_SESSION_MISMATCH");
        if (confirmation.contextReceiptId !== input.contextReceiptId) throw new Error("AGENT_CONFIRMATION_CONTEXT_MISMATCH");
        if (confirmation.status !== "approved") throw new Error(`AGENT_CONFIRMATION_NOT_APPROVED:${confirmation.status}`);
        confirmation.status = "consumed";
        return structuredClone(confirmation);
    }

    cancelSession(sessionId: string) {
        for (const confirmation of this.confirmations.values()) {
            if (confirmation.sessionId === sessionId && ["pending", "approved"].includes(confirmation.status)) confirmation.status = "cancelled";
        }
    }

    cancelTurn(sessionId: string, turnId: string) {
        for (const confirmation of this.confirmations.values()) {
            if (confirmation.sessionId === sessionId && confirmation.turnId === turnId && ["pending", "approved"].includes(confirmation.status)) confirmation.status = "cancelled";
        }
    }

    private requireOwnedPending(confirmationId: string, sessionId: string, now = new Date()) {
        const confirmation = this.confirmations.get(confirmationId);
        if (!confirmation) throw new Error("AGENT_CONFIRMATION_NOT_FOUND");
        this.expireIfNeeded(confirmation, now);
        if (confirmation.sessionId !== sessionId) throw new Error("AGENT_CONFIRMATION_SESSION_MISMATCH");
        if (confirmation.status !== "pending") throw new Error(`AGENT_CONFIRMATION_ALREADY_DECIDED:${confirmation.status}`);
        return confirmation;
    }

    private expireIfNeeded(confirmation: AgentConfirmation, now: Date) {
        if (["pending", "approved"].includes(confirmation.status) && Date.parse(confirmation.expiresAt) <= now.getTime()) {
            confirmation.status = "expired";
        }
    }
}

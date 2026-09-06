import { ApiError, apiClient, compactApiParams, request } from "./request";
import { hashScriptContent } from "@/film/story/script-version";
import type { ProjectShot } from "./projects";
import type { StoryboardPromptState, StoryboardRow } from "@/types/canvas";

export type CanvasPromptKind = "image" | "video";
export type CanvasPromptTarget = { projectId: string; nodeId: string; rowId: string; kind: CanvasPromptKind };
export type CanvasPromptInput = CanvasPromptTarget & { requestId: string; expectedRevision: number; expectedContentHash: string; dependencyHash: string; prompt: string };
export type CanvasPromptDependencies = {
    project: Record<string, string>;
    source: { unitId: string; title: string; revision: number; hash: string };
    shot: ProjectShot;
    direction: Partial<StoryboardRow>;
    assets: Array<{
        origin: string; role: string; bindingStatus?: string; nodeId?: string; nodeType?: string; title?: string;
        nodeFacts?: Record<string, unknown>; assetId?: string;
        version?: { id: string; assetId: string; version: number; status: string; definitionJson: string; prompt: string; note: string; createdAt: string; updatedAt: string };
        resource?: { id: string; mimeType: string; size: number; etag: string; updatedAt: string };
        visualVerified: false;
    }>;
    guidance?: { operation: string; content: string; templateId: string; templateVersion: number; customizationId: string; customizationUpdated: string };
};
export type CanvasPromptContext = CanvasPromptTarget & {
    canvasId: string; writeToken: string; canvasUpdatedAt: string; prompt: string; state: StoryboardPromptState; managed: boolean;
    dependencies: CanvasPromptDependencies; dependencyHash: string; stale: boolean; writeBlockers: string[]; localOverrides: string[];
};
export type CanvasPromptRevision = {
    id: string; canvasId: string; nodeId: string; rowId: string; kind: CanvasPromptKind; revision: number;
    prompt: string; contentHash: string; dependencyHash: string; dependencies: CanvasPromptDependencies | null; requestId: string; createdAt: string;
};
export type CanvasPromptRevisionSummary = Pick<CanvasPromptRevision, "revision" | "contentHash" | "dependencyHash" | "requestId" | "createdAt">;
export type CanvasPromptReceipt = { id: string; canvasId: string; requestId: string; requestHash: string; snapshot: CanvasPromptRevision; createdAt: string };

const promptPath = (canvasId: string) => `/canvas-projects/${encodeURIComponent(canvasId)}/prompt-drafts`;
// Callers may pass the structurally compatible save input. Never serialize its
// full prompt or other write-only fields into a GET URL or access log.
const promptTargetParams = ({ projectId, nodeId, rowId, kind }: CanvasPromptTarget) => compactApiParams({ projectId, nodeId, rowId, kind });
export function getCanvasPrompt(canvasId: string, target: CanvasPromptTarget, signal?: AbortSignal) {
    return request<CanvasPromptContext>(apiClient.get(promptPath(canvasId), { params: promptTargetParams(target), signal }));
}
export function saveCanvasPrompt(canvasId: string, input: CanvasPromptInput) {
    return request<{ receipt: CanvasPromptReceipt; replayed: boolean }>(apiClient.post(promptPath(canvasId), input));
}
export function getCanvasPromptHistory(canvasId: string, target: CanvasPromptTarget, signal?: AbortSignal) {
    return request<CanvasPromptRevisionSummary[]>(apiClient.get(`${promptPath(canvasId)}/history`, { params: promptTargetParams(target), signal }));
}
export function getCanvasPromptRevision(canvasId: string, target: CanvasPromptTarget, revision: number, signal?: AbortSignal) {
    return request<CanvasPromptRevision>(apiClient.get(`${promptPath(canvasId)}/history/${revision}`, { params: promptTargetParams(target), signal }));
}
export function getCanvasPromptReceipt(canvasId: string, requestId: string) {
    return request<CanvasPromptReceipt>(apiClient.get(`${promptPath(canvasId)}/requests/${encodeURIComponent(requestId)}`));
}

const hexHash = /^[a-f0-9]{64}$/;
export async function verifyCanvasPromptContext(value: CanvasPromptContext, canvasId: string, target: CanvasPromptTarget) {
    if (value.canvasId !== canvasId || value.projectId !== target.projectId || value.nodeId !== target.nodeId || value.rowId !== target.rowId || value.kind !== target.kind
        || value.dependencies.project.id !== target.projectId || value.dependencies.shot.projectId !== target.projectId || `project-shot:${value.dependencies.shot.id}` !== target.rowId
        || value.dependencies.shot.unitId !== value.dependencies.source.unitId || !Number.isSafeInteger(value.state.revision) || value.state.revision < 0
        || value.managed !== (value.state.revision > 0) || value.state.contentHash !== await hashScriptContent(value.prompt)
        || !hexHash.test(value.dependencyHash) || (value.managed && (!hexHash.test(value.state.dependencyHash) || !hexHash.test(value.writeToken) || typeof value.canvasUpdatedAt !== "string" || !Number.isFinite(Date.parse(value.canvasUpdatedAt))))) {
        throw new Error("提示词回读身份、版本或正文哈希不一致，未更新本地画布");
    }
}

export async function verifyCanvasPromptRevision(value: CanvasPromptRevision, canvasId: string, target: CanvasPromptTarget, revision: number) {
    if (value.canvasId !== canvasId || value.nodeId !== target.nodeId || value.rowId !== target.rowId || value.kind !== target.kind || value.revision !== revision
        || value.contentHash !== await hashScriptContent(value.prompt) || (revision > 0 && value.dependencies?.project.id !== target.projectId)) {
        throw new Error("提示词历史身份或正文哈希不一致");
    }
}

// Match the Go request struct's field order and encoding/json HTML escaping.
// This is a request fingerprint, not a replacement JSON/API client.
export function canvasPromptRequestHash(input: CanvasPromptInput) {
    const body = JSON.stringify({ projectId: input.projectId, nodeId: input.nodeId, rowId: input.rowId, kind: input.kind,
        requestId: input.requestId, expectedRevision: input.expectedRevision, expectedContentHash: input.expectedContentHash, dependencyHash: input.dependencyHash, prompt: input.prompt });
    return hashScriptContent(body.replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

type PromptPort = { saveCanvasPrompt: typeof saveCanvasPrompt; getCanvasPrompt: typeof getCanvasPrompt; getCanvasPromptReceipt: typeof getCanvasPromptReceipt; getCanvasPromptRevision: typeof getCanvasPromptRevision };
const promptPort: PromptPort = { saveCanvasPrompt, getCanvasPrompt, getCanvasPromptReceipt, getCanvasPromptRevision };

export class CanvasPromptSaveError extends Error {
    constructor(message: string, readonly outcome: "rejected" | "unknown", options?: ErrorOptions) {
        super(message, options);
        this.name = "CanvasPromptSaveError";
    }
}

/** Shared by the native editor and Agent. A failed response only permits a read
 * of the same request receipt; never silently start another write/request ID. */
export async function saveAndVerifyCanvasPrompt(canvasId: string, input: CanvasPromptInput, port: PromptPort = promptPort) {
    if (!canvasId || !input.projectId || !input.nodeId || !input.rowId || !["image", "video"].includes(input.kind) || !input.requestId.trim() || input.requestId !== input.requestId.trim()
        || input.requestId.length > 100 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !hexHash.test(input.expectedContentHash)
        || !hexHash.test(input.dependencyHash) || !input.prompt.trim() || new TextEncoder().encode(input.prompt).length > 64 * 1024) throw new CanvasPromptSaveError("提示词定位、版本、请求 ID 或正文无效", "rejected");
    const expectedRequestHash = await canvasPromptRequestHash(input);
    let saved: Awaited<ReturnType<typeof saveCanvasPrompt>>;
    let recoveredResponse = false;
    try { saved = await port.saveCanvasPrompt(canvasId, input); }
    catch (error) {
        let receipt: CanvasPromptReceipt;
        try { receipt = await port.getCanvasPromptReceipt(canvasId, input.requestId); } catch (receiptError) {
            // Only an explicit rejecting response AND absent receipt prove this
            // request was not saved. A timeout/5xx can follow a committed write.
            if (error instanceof ApiError && [400, 401, 403, 404, 409, 413, 429].includes(error.status || 0) && receiptError instanceof ApiError && receiptError.status === 404) {
                throw new CanvasPromptSaveError(error.message, "rejected", { cause: error });
            }
            throw error;
        }
        if (receipt.requestHash !== expectedRequestHash) throw error;
        saved = { receipt, replayed: true };
        recoveredResponse = true;
    }
    const [receipt, revision, context] = await Promise.all([
        port.getCanvasPromptReceipt(canvasId, input.requestId), port.getCanvasPromptRevision(canvasId, input, input.expectedRevision + 1), port.getCanvasPrompt(canvasId, input),
    ]);
    await verifyCanvasPromptRevision(revision, canvasId, input, input.expectedRevision + 1);
    await verifyCanvasPromptContext(context, canvasId, input);
    if (receipt.canvasId !== canvasId || receipt.requestId !== input.requestId || receipt.requestHash !== expectedRequestHash
        || JSON.stringify(receipt) !== JSON.stringify(saved.receipt) || JSON.stringify(receipt.snapshot) !== JSON.stringify(revision)
        || revision.prompt !== input.prompt || revision.dependencyHash !== input.dependencyHash || revision.requestId !== input.requestId) {
        throw new Error("保存响应、精确历史或原请求回读不一致；保留 requestId 核对，不重复提交");
    }
    const matchesCurrent = context.state.revision === revision.revision && context.state.contentHash === revision.contentHash && context.state.dependencyHash === revision.dependencyHash && context.prompt === revision.prompt;
    return { receipt, context, matchesCurrent, persisted: true as const, replayed: saved.replayed, recoveredResponse };
}

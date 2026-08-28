import { apiClient, request } from "@/services/api/request";

import { buildCreateProductionCanvasCommand, type CreateProductionCanvasCommand } from "./production-canvas";

export type ProductionCanvasAcquireReceipt = Readonly<{
    canvas: Readonly<{ id: string; projectId: string; title: string; createdAt: string; updatedAt: string }>;
    link: Readonly<{ id: string; projectId: string; canvasId: string; unitId: string; role: "production"; createdAt: string }>;
    disposition: "created" | "reused";
    projectRevision: number;
    observedContentHash: string;
    auditEventId: string;
    confirmationId: string;
    confirmedByUserId: string;
    confirmedAt: string;
}>;

export async function prepareProductionCanvasCommand(input: { projectId: string; unitId: string; expectedRevision: number; signal?: AbortSignal }): Promise<CreateProductionCanvasCommand> {
    const result = await request<{ unit: { id: string; projectId: string; sourceText: string } }>(apiClient.get(`/projects/${encodeURIComponent(input.projectId)}/units/${encodeURIComponent(input.unitId)}`, { signal: input.signal }));
    if (result.unit.id !== input.unitId || result.unit.projectId !== input.projectId) throw new Error("ContentUnit 与项目归属不一致");
    return buildCreateProductionCanvasCommand({
        hostProjectId: input.projectId,
        hostUnitId: input.unitId,
        expectedRevision: input.expectedRevision,
        expectedContentHash: await hashHostUnitSourceText(result.unit.sourceText),
    });
}

export function acquireProductionCanvas(command: CreateProductionCanvasCommand, confirmationId: string, signal?: AbortSignal) {
    return request<ProductionCanvasAcquireReceipt>(
        apiClient.post(
            `/projects/${encodeURIComponent(command.hostProjectId)}/units/${encodeURIComponent(command.hostUnitId)}/production-canvas`,
            {
                humanConfirmed: true,
                confirmationId,
                expectedRevision: command.expectedRevision,
                expectedContentHash: command.expectedContentHash,
            },
            { signal },
        ),
    );
}

export async function hashHostUnitSourceText(sourceText: string, cryptoImpl: Crypto = globalThis.crypto): Promise<string> {
    if (!cryptoImpl?.subtle) throw new Error("当前环境缺少 Web Crypto，不能生成 SourceText 并发守卫");
    const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(sourceText));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

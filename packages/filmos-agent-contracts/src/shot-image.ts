export const SHOT_IMAGE_SCHEMA = "filmos.shot-image.v1" as const;
export const SHOT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const SHOT_IMAGE_TTL_MS = 5 * 60 * 1000;

export type ShotImageBinding = {
    projectId: string;
    canvasId: string;
    nodeId: string;
    rowId: string;
    shotId: string;
    shotRevision: number;
    sourceUnitId: string;
    sourceRevision: number;
    sourceHash: string;
    imageNodeId: string;
    resourceId: string;
    resourceUpdatedAt: string;
    resourceETag: string;
    canvasContentHash: string;
    dependencyHash: string;
};

/** Pixels are transient tool transport, never an asset replacement or QC approval. */
export type ShotImageEvidence = {
    schema: typeof SHOT_IMAGE_SCHEMA;
    binding: ShotImageBinding;
    image: { mimeType: "image/png" | "image/jpeg" | "image/webp"; sha256: string; byteLength: number; width: number; height: number };
    capturedAt: string;
    expiresAt: string;
    constraints: { scriptText: string; project: Record<string, string>; shot: Record<string, unknown>; direction: Record<string, unknown>; assets: unknown[] };
    bytesBase64: string;
};

const visualFailures = {
    canvas_image_target_missing: [404, "指定镜头没有可读取的已保存图片；尚未取得像素"],
    canvas_image_scope_mismatch: [403, "图片不属于当前授权项目和镜头，已拒绝读取"],
    canvas_image_stale: [409, "图片、剧本、镜头或当前画布已变化；请刷新后重新读取，不沿用旧图判断"],
    canvas_image_unavailable: [503, "图片资源暂不可读；尚未取得有效像素，不能声称已经看图"],
    canvas_image_invalid: [422, "图片格式、尺寸、字节或哈希未通过校验，不能作为视觉证据"],
    canvas_image_too_large: [413, "图片超过本次视觉读取上限，尚未发送给模型；请使用受支持尺寸的图片"],
} as const;
export type ShotImageErrorCode = keyof typeof visualFailures;

export class ShotImageReadError extends Error {
    readonly statusCode: number;
    constructor(readonly code: ShotImageErrorCode) {
        const [status, message] = visualFailures[code];
        super(message);
        this.name = "ShotImageReadError";
        this.statusCode = status;
    }
}

export function shotImageReadError(code: unknown): ShotImageReadError | undefined {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(visualFailures, code)
        ? new ShotImageReadError(code as ShotImageErrorCode) : undefined;
}

/** Keep identity/constraints visible in history without duplicating image bytes. */
export function summarizeShotImage(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { schema?: unknown }).schema !== SHOT_IMAGE_SCHEMA) return value;
    const { bytesBase64: _bytes, ...metadata } = value as ShotImageEvidence;
    return { ...metadata, pixelTransport: "MCP_IMAGE_BLOCK_REQUIRED", visualJudgment: "NOT_YET_VERIFIED", imageProvenance: "CURRENT_ROW_BINDING_ONLY_NOT_CREATION_LINEAGE" };
}

/** Provider history may include MCP pixels again; UI history keeps descriptors only. */
export function summarizeShotImageMcpResult(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const result = value as { content?: unknown[] };
    if (!Array.isArray(result.content)) return summarizeShotImage(value);
    return { ...result, content: result.content.map(block => {
        if (!block || typeof block !== "object" || (block as { type?: string }).type !== "image") return block;
        return { type: "image", mimeType: (block as { mimeType?: string }).mimeType, pixelsOmittedFromHistory: true };
    }) };
}

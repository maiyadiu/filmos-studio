import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { SHOT_IMAGE_MAX_BYTES, SHOT_IMAGE_SCHEMA, SHOT_IMAGE_TTL_MS, ShotImageReadError, summarizeShotImage, type ShotImageEvidence } from "@filmos/agent-contracts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;

/** Only the dedicated, scoped tool can deliver pixels; JSON text is not vision. */
export async function shotImageMcpContent(value: unknown, now = Date.now(), expected?: { nodeId: string; rowId: string; projectId?: string; canvasId?: string; expectedImageHash?: string }) {
    const evidence = value as ShotImageEvidence | undefined;
    const invalid = () => new ShotImageReadError("canvas_image_invalid");
    if (!evidence || evidence.schema !== SHOT_IMAGE_SCHEMA || !evidence.binding || !evidence.image || !evidence.constraints || typeof evidence.bytesBase64 !== "string") throw invalid();
    const { binding, image, constraints } = evidence;
    if (expected && (binding.nodeId !== expected.nodeId || binding.rowId !== expected.rowId
        || (expected.projectId !== undefined && binding.projectId !== expected.projectId) || (expected.canvasId !== undefined && binding.canvasId !== expected.canvasId))) throw new ShotImageReadError("canvas_image_scope_mismatch");
    if (expected?.expectedImageHash !== undefined && image.sha256 !== expected.expectedImageHash) throw new ShotImageReadError("canvas_image_stale");
    if (![binding.projectId, binding.canvasId, binding.nodeId, binding.rowId, binding.shotId, binding.sourceUnitId, binding.imageNodeId, binding.resourceId].every(v => typeof v === "string" && v.length > 0)
        || binding.rowId !== `project-shot:${binding.shotId}`
        || ![binding.shotRevision, binding.sourceRevision].every(v => Number.isSafeInteger(v) && v >= 1)
        || ![binding.sourceHash, binding.canvasContentHash, binding.dependencyHash, image.sha256].every(v => typeof v === "string" && hex.test(v))
        || typeof constraints.scriptText !== "string" || hash(constraints.scriptText) !== binding.sourceHash
        || constraints.project?.id !== binding.projectId || constraints.shot?.id !== binding.shotId || constraints.shot?.projectId !== binding.projectId
        || constraints.shot.unitId !== binding.sourceUnitId || constraints.shot.revision !== binding.shotRevision
        || constraints.shot.sourceRevision !== binding.sourceRevision || constraints.shot.sourceHash !== binding.sourceHash
        || !Number.isFinite(Date.parse(binding.resourceUpdatedAt)) || typeof binding.resourceETag !== "string") throw invalid();
    const captured = Date.parse(evidence.capturedAt), expires = Date.parse(evidence.expiresAt);
    if (!Number.isFinite(captured) || !Number.isFinite(expires) || captured > now + 5_000 || expires <= now || expires <= captured || expires - captured > SHOT_IMAGE_TTL_MS) throw new ShotImageReadError("canvas_image_stale");
    if (!Number.isSafeInteger(image.byteLength) || image.byteLength < 1 || evidence.bytesBase64.length > Math.ceil(SHOT_IMAGE_MAX_BYTES / 3) * 4 || image.byteLength > SHOT_IMAGE_MAX_BYTES) throw new ShotImageReadError("canvas_image_too_large");
    const bytes = Buffer.from(evidence.bytesBase64, "base64");
    if (bytes.toString("base64") !== evidence.bytesBase64 || bytes.length !== image.byteLength || hash(bytes) !== image.sha256) throw invalid();
    let metadata: Metadata;
    try { metadata = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata(); }
    catch { throw invalid(); }
    const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[String(metadata.format) as "png" | "jpeg" | "webp"];
    if (!mime || mime !== image.mimeType || metadata.width !== image.width || metadata.height !== image.height
        || !image.width || !image.height || image.width > 8192 || image.height > 8192 || (metadata.pages || 1) !== 1) throw invalid();
    // Header inspection alone accepts truncated/corrupt pixel streams.
    try { await sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" }).raw().toBuffer(); }
    catch { throw invalid(); }
    return {
        content: [
            { type: "text" as const, text: JSON.stringify(summarizeShotImage(evidence)) },
            { type: "image" as const, mimeType: image.mimeType, data: evidence.bytesBase64 },
        ],
    };
}

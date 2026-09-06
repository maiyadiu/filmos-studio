import { SHOT_IMAGE_MAX_BYTES, SHOT_IMAGE_SCHEMA, SHOT_IMAGE_TTL_MS, ShotImageReadError, type ShotImageEvidence } from "../../../../packages/filmos-agent-contracts/src/shot-image";
import { hashScriptContent } from "@/film/story/script-version";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { sameCanvasJSON } from "@/lib/canvas/canvas-sync-baseline";
import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasNodeData } from "@/types/canvas";
import { getCanvasPrompt, verifyCanvasPromptContext, type CanvasPromptTarget } from "./canvas-prompts";
import { getProjectUnit } from "./projects";
import { getRemoteCanvasProject } from "./user-data";
import { getResource, getResourceBlob, resourceIdFromStorageKey } from "./resources";
import { ApiError } from "./request";
import type { ShotImageSnapshot } from "@/lib/canvas/agent-creative-results";

const port = { getCanvasPrompt, getProjectUnit, getRemoteCanvasProject, getResource, getResourceBlob, userScope: getActiveUserScope,
    imageSize: async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
        try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
    }, now: Date.now };
function fail(code: ConstructorParameters<typeof ShotImageReadError>[0]): never { throw new ShotImageReadError(code); }
const hex = /^[a-f0-9]{64}$/;
type CurrentCanvas = Pick<CanvasAgentSnapshot, "projectId" | "domainProjectId" | "nodes">;

/** Reopen the exact bytes of an old reading, never the row's replacement image. */
export async function loadShotImagePreview(evidence: ShotImageSnapshot, current: () => CurrentCanvas, signal: AbortSignal, io = port): Promise<Blob> {
    const { binding, image } = evidence, user = io.userScope();
    const guard = () => {
        const scope = current();
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (io.userScope() !== user || scope.projectId !== binding.canvasId || scope.domainProjectId !== binding.projectId) fail("canvas_image_scope_mismatch");
    };
    guard();
    if (await hashScriptContent(evidence.constraints.scriptText) !== binding.sourceHash) fail("canvas_image_invalid");
    const check = async () => {
        const [remote, resource] = await Promise.all([io.getRemoteCanvasProject(binding.canvasId, signal), io.getResource(binding.resourceId, { fresh: true, signal })]);
        guard();
        if (remote.project.id !== binding.canvasId || remote.project.projectId !== binding.projectId || resource.id !== binding.resourceId) fail("canvas_image_scope_mismatch");
        if (resource.status !== "ready") fail("canvas_image_unavailable");
        if (resource.kind !== "image" || resource.mimeType !== image.mimeType || resource.size !== image.byteLength
            || resource.updatedAt !== binding.resourceUpdatedAt || (resource.etag || "") !== binding.resourceETag) fail("canvas_image_stale");
    };
    await check();
    const blob = await io.getResourceBlob(`resource:${binding.resourceId}`, { signal, maxBytes: SHOT_IMAGE_MAX_BYTES });
    if (!blob) fail("canvas_image_unavailable");
    if (blob.size !== image.byteLength || blob.type.split(";", 1)[0] !== image.mimeType) fail("canvas_image_invalid");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== image.sha256) fail("canvas_image_stale");
    const size = await io.imageSize(blob);
    if (size.width !== image.width || size.height !== image.height) fail("canvas_image_invalid");
    await check(); guard();
    return blob;
}

/** One scoped read through the existing API authority; never flush local drafts. */
export async function readProjectShotImage(raw: Record<string, unknown>, projectId: string, canvasId: string | undefined, current: () => CurrentCanvas, io = port): Promise<ShotImageEvidence> {
    if (!projectId || !canvasId || (raw.projectId !== undefined && raw.projectId !== projectId) || (raw.canvasId !== undefined && raw.canvasId !== canvasId)) fail("canvas_image_scope_mismatch");
    if (Object.keys(raw).some(key => !["projectId", "canvasId", "nodeId", "rowId", "expectedImageHash"].includes(key))
        || typeof raw.nodeId !== "string" || !raw.nodeId || typeof raw.rowId !== "string" || !raw.rowId.startsWith("project-shot:")
        || (raw.expectedImageHash !== undefined && (typeof raw.expectedImageHash !== "string" || !hex.test(raw.expectedImageHash)))) fail("canvas_image_invalid");
    const target: CanvasPromptTarget = { projectId, nodeId: raw.nodeId, rowId: raw.rowId, kind: "image" };
    const userScope = io.userScope(), started = io.now();
    const localTarget = () => {
        const snapshot = current();
        if (io.userScope() !== userScope || snapshot.projectId !== canvasId || snapshot.domainProjectId !== projectId) fail("canvas_image_scope_mismatch");
        return locate(snapshot.nodes, target);
    };
    const before = structuredClone(localTarget());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    const signal = controller.signal;
    try {
        const read = async () => {
            const [remote, context] = await Promise.all([io.getRemoteCanvasProject(canvasId, signal), io.getCanvasPrompt(canvasId, target, signal)]);
            if (remote.project.id !== canvasId || remote.project.projectId !== projectId) fail("canvas_image_scope_mismatch");
            if (!hex.test(remote.contentHash)) fail("canvas_image_invalid");
            await verifyCanvasPromptContext(context, canvasId, target);
            const located = locate(remote.project.nodes, target), { shot, source } = context.dependencies;
            if (context.writeBlockers.some(code => code !== "SOURCE_NOT_EDITABLE") || located.chapterId !== source.unitId
                || located.row.projectShotSource?.id !== shot.id || located.row.projectShotSource.revision !== shot.revision
                || located.row.projectShotSource.sourceRevision !== source.revision || located.row.projectShotSource.sourceHash !== source.hash
                || shot.sourceRevision !== source.revision || shot.sourceHash !== source.hash) fail("canvas_image_stale");
            const [{ unit }, resource] = await Promise.all([io.getProjectUnit(projectId, source.unitId, signal), io.getResource(located.resourceId, { fresh: true, signal })]);
            if (unit.id !== source.unitId || unit.projectId !== projectId || resource.id !== located.resourceId) fail("canvas_image_scope_mismatch");
            if (unit.revision !== source.revision || await hashScriptContent(unit.sourceText) !== source.hash) fail("canvas_image_stale");
            if (resource.status !== "ready") fail("canvas_image_unavailable");
            if (resource.kind !== "image" || !["image/png", "image/jpeg", "image/webp"].includes(resource.mimeType)
                || !Number.isSafeInteger(resource.size) || resource.size < 1 || !Number.isFinite(Date.parse(resource.updatedAt))) fail("canvas_image_invalid");
            if (resource.size > SHOT_IMAGE_MAX_BYTES) fail("canvas_image_too_large");
            return { remote, context, located, unit, resource };
        };
        const first = await read();
        if (!sameCanvasJSON(before, first.located) || !sameCanvasJSON(before, localTarget())) fail("canvas_image_stale");
        const blob = await io.getResourceBlob(`resource:${first.resource.id}`, { signal, maxBytes: SHOT_IMAGE_MAX_BYTES });
        if (!blob) fail("canvas_image_unavailable");
        if (blob.size > SHOT_IMAGE_MAX_BYTES) fail("canvas_image_too_large");
        if (!blob.size || blob.size !== first.resource.size || blob.type.split(";", 1)[0] !== first.resource.mimeType) fail("canvas_image_invalid");
        const buffer = await blob.arrayBuffer();
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
        if (raw.expectedImageHash !== undefined && raw.expectedImageHash !== sha256) fail("canvas_image_stale");
        let dimensions: { width: number; height: number };
        try { dimensions = await io.imageSize(blob); } catch { return fail("canvas_image_invalid"); }
        if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 16_777_216) fail("canvas_image_invalid");
        const last = await read();
        // A second read bounds the evidence window. It is not an everlasting lock.
        if (last.remote.contentHash !== first.remote.contentHash || last.context.dependencyHash !== first.context.dependencyHash
            || !sameCanvasJSON(last.context.dependencies, first.context.dependencies) || !sameCanvasJSON(last.located, first.located)
            || !sameCanvasJSON(last.resource, first.resource) || !sameCanvasJSON(before, localTarget())
            || signal.aborted || io.now() - started >= SHOT_IMAGE_TTL_MS) fail("canvas_image_stale");
        const { source, shot, project, direction, assets } = last.context.dependencies;
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { schema: SHOT_IMAGE_SCHEMA,
            binding: { projectId, canvasId, nodeId: target.nodeId, rowId: target.rowId, shotId: shot.id, shotRevision: shot.revision,
                sourceUnitId: source.unitId, sourceRevision: source.revision, sourceHash: source.hash, imageNodeId: last.located.imageNodeId,
                resourceId: last.resource.id, resourceUpdatedAt: last.resource.updatedAt, resourceETag: last.resource.etag || "", canvasContentHash: last.remote.contentHash, dependencyHash: last.context.dependencyHash },
            image: { mimeType: last.resource.mimeType as ShotImageEvidence["image"]["mimeType"], sha256, byteLength: buffer.byteLength, ...dimensions },
            capturedAt: new Date(started).toISOString(), expiresAt: new Date(started + SHOT_IMAGE_TTL_MS).toISOString(),
            constraints: { scriptText: last.unit.sourceText, project, shot: { ...shot }, direction: { ...direction }, assets }, bytesBase64: btoa(binary) };
    } catch (error) {
        // Keep explicit authentication/business HTTP failures, never leak resource URLs.
        if (error instanceof ShotImageReadError || error instanceof ApiError) throw error;
        if (error instanceof RangeError && error.message === "RESOURCE_BYTE_LIMIT_EXCEEDED") fail("canvas_image_too_large");
        return fail("canvas_image_unavailable");
    } finally { clearTimeout(timeout); }
}

function locate(nodes: CanvasNodeData[], target: CanvasPromptTarget) {
    const scripts = nodes.filter(node => node.id === target.nodeId && node.type === "script");
    if (scripts.length !== 1) return fail("canvas_image_target_missing");
    const rows = scripts[0].metadata?.storyboard?.rows.filter(row => row.id === target.rowId) || [];
    if (rows.length !== 1 || !rows[0].imageNodeId) return fail("canvas_image_target_missing");
    const row = rows[0], images = nodes.filter(node => node.id === row.imageNodeId && node.type === "image");
    if (images.length !== 1) return fail("canvas_image_target_missing");
    const image = images[0];
    if (image.metadata?.status !== "success") return fail("canvas_image_unavailable");
    const resourceId = resourceIdFromStorageKey(image.metadata.storageKey);
    if (!resourceId) return fail("canvas_image_target_missing");
    return { chapterId: scripts[0].metadata?.chapterId, row, imageNodeId: image.id, resourceId, imageStatus: image.metadata.status };
}

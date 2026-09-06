import type { CanvasAgentSnapshot } from "./canvas-agent-ops";
import { CanvasNodeType } from "@/types/canvas";
import { SHOT_IMAGE_SCHEMA, SHOT_IMAGE_MAX_BYTES, SHOT_IMAGE_TTL_MS, type ShotImageEvidence } from "../../../../packages/filmos-agent-contracts/src/shot-image";

export type ShotImageSnapshot = Omit<ShotImageEvidence, "bytesBase64">;

export type AgentCreativeResult =
    | { kind: "script"; projectId: string; unitId: string; revision: number }
    | { kind: "shots"; projectId: string; unitId: string }
    | { kind: "prompt"; projectId: string; canvasId: string; nodeId: string; rowId: string; promptKind: "image" | "video"; revision: number; shotNumber: number }
    | { kind: "shot-image"; evidence: ShotImageSnapshot; shotNumber: number };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// Only project-tool output is a navigation source. Assistant prose, proposed
// arguments and arbitrary URLs cannot become a saved-result claim or action.
export function agentCreativeResult(item: { role: string; detail?: unknown }, snapshot: CanvasAgentSnapshot): AgentCreativeResult | null {
    if (item.role !== "tool" || !snapshot.domainProjectId) return null;
    const detail = record(item.detail);
    if (detail.error || (detail.status !== undefined && !["completed", "succeeded"].includes(String(detail.status)))) return null;
    const name = detail.name ?? detail.tool;
    let output = record(detail.result);
    if (output.isError === true) return null;
    if (Array.isArray(output.content)) {
        // Only the image reader has a second, non-persisted pixel descriptor.
        const imageResult = name === "project_read_shot_image" && output.content.length === 2
            && record(output.content[1]).type === "image";
        if ((!imageResult && output.content.length !== 1) || record(output.content[0]).type !== "text") return null;
        try { output = record(JSON.parse(String(record(output.content[0]).text))); } catch { return null; }
    }
    if (output.ok === false || output.isError === true) return null;
    const data = record(output.data), verification = record(data.verification);
    const inScope = (projectId: unknown, unitId: unknown) => projectId === snapshot.domainProjectId && text(unitId) && (!snapshot.contentUnitId || snapshot.contentUnitId === unitId);
    if (name === "project_read_shot_image") {
        const binding = record(output.binding), image = record(output.image), constraints = record(output.constraints), shot = record(constraints.shot);
        const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
        const captured = Date.parse(String(output.capturedAt)), expires = Date.parse(String(output.expiresAt));
        if (output.schema !== SHOT_IMAGE_SCHEMA || !inScope(binding.projectId, binding.sourceUnitId) || binding.canvasId !== snapshot.projectId
            || ![binding.nodeId, binding.imageNodeId, binding.resourceId, binding.shotId].every(text) || binding.rowId !== `project-shot:${binding.shotId}`
            || ![binding.shotRevision, binding.sourceRevision].every(revision)
            || ![binding.sourceHash, binding.canvasContentHash, binding.dependencyHash, image.sha256].every(hex)
            || !Number.isFinite(Date.parse(String(binding.resourceUpdatedAt))) || typeof binding.resourceETag !== "string"
            || !Number.isFinite(captured) || !Number.isFinite(expires) || expires <= captured || expires - captured > SHOT_IMAGE_TTL_MS
            || !["image/png", "image/jpeg", "image/webp"].includes(String(image.mimeType))
            || ![image.byteLength, image.width, image.height].every(revision) || Number(image.byteLength) > SHOT_IMAGE_MAX_BYTES
            || Number(image.width) > 8192 || Number(image.height) > 8192 || Number(image.width) * Number(image.height) > 16_777_216
            || typeof constraints.scriptText !== "string" || record(constraints.project).id !== binding.projectId || !Array.isArray(constraints.assets)
            || !constraints.direction || Array.isArray(constraints.direction) || typeof constraints.direction !== "object"
            || shot.id !== binding.shotId || shot.unitId !== binding.sourceUnitId || shot.projectId !== binding.projectId
            || shot.revision !== binding.shotRevision || shot.sourceRevision !== binding.sourceRevision || shot.sourceHash !== binding.sourceHash
            || !Number.isSafeInteger(shot.position) || Number(shot.position) < 0) return null;
        // This is a historical reading, not a claim about today's row or QC state.
        // Select metadata explicitly: raw transport bytes never enter this result.
        const evidence = { schema: SHOT_IMAGE_SCHEMA, binding, image, constraints, capturedAt: output.capturedAt, expiresAt: output.expiresAt } as ShotImageSnapshot;
        return { kind: "shot-image", evidence, shotNumber: Number(shot.position) + 1 };
    }
    if (["project_revise_script", "project_get_script_revision", "project_get_script"].includes(String(name))) {
        if (name === "project_revise_script" && (output.ok !== true || verification.ok !== true || verification.persisted !== true)) return null;
        const source = record(name === "project_revise_script" ? data.after : name === "project_get_script_revision" ? output.revision : output.unit);
        const unitId = name === "project_get_script" ? source.id : source.unitId;
        if (!inScope(source.projectId, unitId) || !revision(source.revision)) return null;
        return { kind: "script", projectId: snapshot.domainProjectId, unitId: unitId as string, revision: source.revision };
    }
    if (["project_create_or_update_shots", "project_get_shots", "project_get_shot_batch", "project_sync_storyboard"].includes(String(name))) {
        if (name === "project_create_or_update_shots" && (output.ok !== true || verification.persisted !== true)) return null;
        if (name === "project_sync_storyboard" && (output.ok !== true || verification.ok !== true || verification.persisted !== true || record(data.location).canvasId !== snapshot.projectId)) return null;
        const source = record(name === "project_get_shots" ? output.unit : name === "project_sync_storyboard" ? data.location : name === "project_get_shot_batch" ? output.receipt : data.receipt);
        const unitId = name === "project_get_shots" ? source.id : source.unitId;
        if (!inScope(source.projectId, unitId)) return null;
        // Reopen the current business viewer; an old batch is not the current version.
        return { kind: "shots", projectId: snapshot.domainProjectId, unitId: unitId as string };
    }
    if (!["project_save_prompt", "project_get_prompt", "project_get_prompt_revision", "project_get_prompt_request"].includes(String(name))) return null;
    if (name === "project_save_prompt" && (output.ok !== true || verification.ok !== true || verification.persisted !== true)) return null;
    const context = record(name === "project_save_prompt" ? data.context : name === "project_get_prompt_revision" ? output.revision : name === "project_get_prompt_request" ? record(output.receipt).snapshot : output);
    const deps = record(context.dependencies), shot = record(deps.shot), source = record(deps.source);
    const version = name === "project_save_prompt" || name === "project_get_prompt" ? record(context.state).revision : context.revision;
    if (!inScope(record(deps.project).id, source.unitId) || shot.projectId !== snapshot.domainProjectId || shot.unitId !== source.unitId || !text(shot.id)
        || context.canvasId !== snapshot.projectId || context.rowId !== `project-shot:${shot.id}` || !text(context.nodeId)
        || !["image", "video"].includes(String(context.kind)) || !revision(version) || !Number.isSafeInteger(shot.position) || Number(shot.position) < 0) return null;
    const nodes = snapshot.nodes.filter(node => node.id === context.nodeId);
    if (nodes.length !== 1 || nodes[0].type !== CanvasNodeType.Script || nodes[0].metadata?.chapterId !== source.unitId
        || nodes[0].metadata?.storyboard?.rows.filter(row => row.id === context.rowId).length !== 1) return null;
    return { kind: "prompt", projectId: snapshot.domainProjectId, canvasId: snapshot.projectId, nodeId: context.nodeId, rowId: context.rowId as string,
        promptKind: context.kind as "image" | "video", revision: version, shotNumber: Number(shot.position) + 1 };
}

export function creativeToolTargetSummary(name: string, input: Record<string, unknown>, snapshot: CanvasAgentSnapshot): string | null {
    if (!snapshot.domainProjectId || (input.projectId !== undefined && input.projectId !== snapshot.domainProjectId)) return null;
    if (name === "project_save_prompt") {
        const nodes = snapshot.nodes.filter(node => node.id === input.nodeId && node.type === CanvasNodeType.Script);
        const rows = nodes[0]?.metadata?.storyboard?.rows.filter(row => row.id === input.rowId);
        if (nodes.length !== 1 || rows?.length !== 1 || !["image", "video"].includes(String(input.kind))) return null;
        return `目标：${nodes[0].title} · 镜头 ${rows[0].shotNumber} · ${input.kind === "image" ? "图片" : "视频"}提示词；基于 v${input.expectedRevision} 保存新版本。仅保存草稿，不生成媒体。`;
    }
    if (!["project_revise_script", "project_create_or_update_shots", "project_sync_storyboard"].includes(name) || !text(input.unitId)) return null;
    const nodes = snapshot.nodes.filter(node => node.type === CanvasNodeType.Script && node.metadata?.chapterId === input.unitId);
    const target = nodes.length === 1 ? nodes[0].title : `章节 ${input.unitId}`;
    if (name === "project_revise_script") return `目标：${target} · 正文 v${input.expectedRevision}；${Array.isArray(input.edits) ? input.edits.length : 0} 处精确修订，原版本保留。`;
    if (name === "project_sync_storyboard") return `目标：${target} → 当前画布「${snapshot.title}」；同步分镜 v${input.expectedShotRevision}，保留原节点与布局，不生成媒体。`;
    const shots = Array.isArray(input.shots) ? input.shots : [];
    const existing = shots.filter(shot => text(record(shot).id)).length;
    return `目标：${target} · 分镜批次 v${input.expectedShotRevision}；新增 ${shots.length - existing} 镜，修订 ${existing} 镜，未指定镜头保留。`;
}

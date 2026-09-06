import type { CanvasAgentSnapshot } from "./canvas-agent-ops";
import { CanvasNodeType } from "@/types/canvas";

export type AgentCreativeResult =
    | { kind: "script"; projectId: string; unitId: string; revision: number }
    | { kind: "shots"; projectId: string; unitId: string }
    | { kind: "prompt"; projectId: string; canvasId: string; nodeId: string; rowId: string; promptKind: "image" | "video"; revision: number; shotNumber: number };

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
        // Native MCP history contains exactly one JSON text block for these tools.
        if (output.content.length !== 1 || record(output.content[0]).type !== "text") return null;
        try { output = record(JSON.parse(String(record(output.content[0]).text))); } catch { return null; }
    }
    if (output.ok === false || output.isError === true) return null;
    const data = record(output.data), verification = record(data.verification);
    const inScope = (projectId: unknown, unitId: unknown) => projectId === snapshot.domainProjectId && text(unitId) && (!snapshot.contentUnitId || snapshot.contentUnitId === unitId);
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

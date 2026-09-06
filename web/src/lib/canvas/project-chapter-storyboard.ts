import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import type { ProjectShot, ProjectShotContext, ProjectUnit } from "@/services/api/projects";
import { sameCanvasJSON } from "./canvas-sync-baseline";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardData, type StoryboardRow } from "@/types/canvas";

type ProjectChapterStoryboardInput = {
    unit: Pick<ProjectUnit, "id" | "title">;
    shots: ProjectShot[];
    newNodeId?: string;
};

export type ProjectStoryboardSyncInput = { projectId: string; unitId: string; expectedShotRevision: number; sourceRevision: number; sourceHash: string };
export const CANVAS_STORYBOARD_UPDATED_EVENT = "filmos:canvas-storyboard-updated";
export type CanvasStoryboardUpdatedEvent = { canvasId: string; userScope: string; before: CanvasNodeData | undefined; after: CanvasNodeData; phase: "check" | "apply"; rejected?: boolean };

export function assertProjectStoryboardContext(context: ProjectShotContext, input: ProjectStoryboardSyncInput) {
    if (context.unit.id !== input.unitId || context.unit.projectId !== input.projectId || (context.unit.shotRevision ?? 0) !== input.expectedShotRevision || context.unit.revision !== input.sourceRevision || context.sourceHash !== input.sourceHash) throw new Error("分镜或剧本版本已改变，请先回读；未同步旧结果");
    if (!context.shots.length || context.staleShotIds.length || context.shots.some(shot => shot.projectId !== input.projectId || shot.unitId !== input.unitId || shot.sourceRevision !== input.sourceRevision || shot.sourceHash !== input.sourceHash)) throw new Error("没有可同步的当前来源分镜，或镜头绑定不一致；未修改画布");
    if (new Set(context.shots.map(shot => shot.id)).size !== context.shots.length) throw new Error("业务分镜身份重复，未修改画布");
}

// Apply only the imported node; preserve other nodes and every connection.
export function mergeProjectStoryboardReadback(nodes: CanvasNodeData[], before: CanvasNodeData | undefined, after: CanvasNodeData) {
    const matches = nodes.filter(node => node.id === after.id || (node.type === CanvasNodeType.Script && node.metadata?.chapterId === after.metadata?.chapterId));
    if (matches.length > 1 || (matches[0] && matches[0].id !== after.id)) throw new Error("本章分镜节点不唯一，未替换本地内容");
    const current = matches[0];
    if (sameCanvasJSON(current, after)) return nodes;
    if (!sameCanvasJSON(current, before)) throw new Error("等待期间本章分镜发生手工修改，已保留；请核对已保存结果");
    return current ? nodes.map(node => node.id === after.id ? after : node) : [...nodes, after];
}

const BUSINESS_SHOT_COLUMNS: StoryboardData["visibleColumns"] = ["shotNumber", "durationSeconds", "plotDescription", "dialogue", "performanceBlocking", "camera", "assets"];

export function upsertProjectChapterStoryboard(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    { unit, shots, newNodeId }: ProjectChapterStoryboardInput,
) {
    const matches = nodes.filter((node) => node.type === CanvasNodeType.Script && node.metadata?.chapterId === unit.id);
    if (matches.length > 1) throw new Error("本章存在多个分镜节点，请先核对；未任意选择覆盖");
    const existing = matches[0];
    const currentRows = new Map((existing?.metadata?.storyboard?.rows || []).map((row) => [row.id, row]));
    if (currentRows.size !== (existing?.metadata?.storyboard?.rows.length || 0)) throw new Error("分镜行身份重复，未覆盖任何一行");
    const incomingIds = new Set(shots.filter(shot => shot.unitId === unit.id).map(shot => `project-shot:${shot.id}`));
    if ([...currentRows.keys()].some(id => !incomingIds.has(id))) {
        throw new Error("画布中存在本次业务分镜以外的镜头，已保留；请在新画布导入，避免覆盖手工镜头或已有连接");
    }
    const rows = shots
        .filter((shot) => shot.unitId === unit.id)
        .slice()
        .sort((left, right) => left.position - right.position)
        .map((shot, index) => projectShotRow(shot, index, currentRows));

    const storyboard: StoryboardData = {
        rows,
        visibleColumns: existing?.metadata?.storyboard?.visibleColumns || BUSINESS_SHOT_COLUMNS,
        referenceNodeIds: existing?.metadata?.storyboard?.referenceNodeIds || [],
    };
    const scriptNode: CanvasNodeData = existing
        ? {
              ...existing,
              title: `分镜脚本 · ${unit.title}`,
              metadata: {
                  ...existing.metadata,
                  status: "idle" as const,
                  workflowKind: "storyboard" as const,
                  workflowTitle: "章节分镜",
                  workflowDescription: `已导入 ${rows.length} 个镜头`,
                  chapterId: unit.id,
                  chapterTitle: unit.title,
                  storyboard,
              },
          }
        : createChapterStoryboardNode(nodes, unit, rows);
    if (!existing && newNodeId) {
        if (nodes.some(node => node.id === newNodeId)) throw new Error("分镜节点 ID 已被其他对象使用，未覆盖");
        scriptNode.id = newNodeId;
    }
    const nextNodes = existing ? nodes.map((node) => node.id === existing.id ? scriptNode : node) : [...nodes, scriptNode];
    const validRowHandles = new Set(rows.map((row) => `row:${row.id}`));
    const nextConnections = existing
        ? connections
              .filter((connection) => connection.fromNodeId !== existing.id || validStoryboardHandle(connection.fromHandleId, validRowHandles))
              .filter((connection) => connection.toNodeId !== existing.id || validStoryboardHandle(connection.toHandleId, validRowHandles))
        : connections;
    if (nextConnections.length !== connections.length) throw new Error("同步会移除现有分镜连接，已保留原画布；请先核对连接");
    return { nodes: nextNodes, connections: nextConnections, scriptNodeId: scriptNode.id, rowCount: rows.length };
}

function projectShotRow(shot: ProjectShot, index: number, currentRows: Map<string, StoryboardRow>) {
    const id = `project-shot:${shot.id}`;
    const current = currentRows.get(id);
    const mappedFields = {
        durationSeconds: Math.max(0.001, shot.durationMs / 1000),
        plotDescription: shot.description.trim() || shot.title.trim(),
        dialogue: (shot.content?.dialogue || []).map(cue => `${cue.speaker}：${cue.text}`).join("\n"),
        performanceBlocking: shot.content?.action || "",
        camera: shot.content?.camera || "",
    };
    // Re-import is explicit, but must still protect local text edits. The last
    // projection is only a conflict baseline; business versions remain in Shot.
    if (current) {
        const baseline = current.projectShotSource?.mappedFields;
        const conflict = (Object.keys(mappedFields) as Array<keyof typeof mappedFields>).some(key => {
            if (baseline) return current[key] !== baseline[key];
            return current[key] !== "" && current[key] !== mappedFields[key];
        });
        if (conflict) throw new Error(`第 ${current.shotNumber} 镜在画布中有手工修改，已保留；请使用新画布查看最新业务分镜，或核对后再同步`);
    }
    return createStoryboardRow(index + 1, {
        ...current,
        ...mappedFields,
        id,
        shotNumber: index + 1,
        projectShotSource: { id: shot.id, revision: shot.revision, sourceRevision: shot.sourceRevision, sourceHash: shot.sourceHash, mappedFields },
        characters: [
            ...(current?.characters || []),
            ...(shot.content?.characters || []).filter(name => !current?.characters.some(ref => ref.characterName === name)).map(characterName => ({ characterName })),
        ],
        status: current?.status || "idle",
    });
}

function createChapterStoryboardNode(nodes: CanvasNodeData[], unit: Pick<ProjectUnit, "id" | "title">, rows: StoryboardRow[]) {
    const rightEdge = nodes.reduce((value, node) => Math.max(value, node.position.x + node.width), 0);
    const node = createCanvasNode(CanvasNodeType.Script, { x: rightEdge + 540, y: 340 }, {
        status: "idle",
        workflowKind: "storyboard",
        workflowTitle: "章节分镜",
        workflowDescription: `已导入 ${rows.length} 个镜头`,
        chapterId: unit.id,
        chapterTitle: unit.title,
        storyboard: {
            rows,
            visibleColumns: BUSINESS_SHOT_COLUMNS,
            referenceNodeIds: [],
        },
    });
    node.title = `分镜脚本 · ${unit.title}`;
    return node;
}

function validStoryboardHandle(handleId: string | undefined, validRowHandles: Set<string>) {
    return !handleId || handleId === "storyboard:context" || validRowHandles.has(handleId);
}

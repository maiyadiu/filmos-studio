import type { CanvasNodeData, StoryboardRow } from "@/types/canvas";
import type { CanvasPromptContext, CanvasPromptTarget } from "@/services/api/canvas-prompts";

export type CanvasPromptLocalBaseline = { prompt: string; state: StoryboardRow["promptDrafts"]; shotId: string; unitId: string };
export const CANVAS_PROMPT_UPDATED_EVENT = "filmos:canvas-prompt-updated";
export type CanvasPromptUpdatedEvent = { canvasId: string; userScope: string; before: CanvasPromptLocalBaseline; context: CanvasPromptContext; rejected?: boolean };
export const canvasPromptField = (kind: "image" | "video") => kind === "image" ? "imageGenerationPrompt" : "videoMotionPrompt";

export function localCanvasPromptBaseline(nodes: CanvasNodeData[], target: CanvasPromptTarget): CanvasPromptLocalBaseline {
    const node = nodes.find(node => node.id === target.nodeId);
    const matches = node?.metadata?.storyboard?.rows.filter(row => row.id === target.rowId) || [];
    if (node?.type !== "script" || matches.length !== 1 || !matches[0].projectShotSource?.id || target.rowId !== `project-shot:${matches[0].projectShotSource.id}` || !node.metadata?.chapterId) throw new Error("本地画布分镜定位不唯一或未绑定业务来源");
    const row = matches[0];
    return { prompt: row[canvasPromptField(target.kind)], state: structuredClone(row.promptDrafts), shotId: row.projectShotSource!.id, unitId: node.metadata.chapterId };
}

/** Merge one verified field. Layout, other rows/kinds, assets and director edits
 * survive; an intervening literal edit or row deletion is never overwritten. */
export function mergeCanvasPromptContext(nodes: CanvasNodeData[], before: CanvasPromptLocalBaseline, context: CanvasPromptContext) {
    const current = localCanvasPromptBaseline(nodes, context);
    const field = canvasPromptField(context.kind);
    if (current.unitId !== context.dependencies.source.unitId || current.shotId !== context.dependencies.shot.id || (current.state?.[context.kind]?.revision || 0) > context.state.revision) throw new Error("提示词回读来源改变或版本倒退，未替换本地内容");
    const sameCurrent = current.prompt === context.prompt && JSON.stringify(current.state?.[context.kind]) === JSON.stringify(context.managed ? context.state : undefined);
    if (current.shotId !== before.shotId || current.unitId !== before.unitId || (!sameCurrent && (current.prompt !== before.prompt || JSON.stringify(current.state?.[context.kind]) !== JSON.stringify(before.state?.[context.kind])))) throw new Error("等待期间本地提示词或来源已改变，已保留本地内容；后端结果可按请求 ID 回读");
    if (!context.managed || sameCurrent) return nodes;
    return nodes.map(node => node.id !== context.nodeId ? node : { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: node.metadata!.storyboard!.rows.map(row => row.id !== context.rowId ? row : {
        ...row, [field]: context.prompt, promptDrafts: { ...row.promptDrafts, [context.kind]: context.state },
        ...(context.kind === "image" ? { imagePromptTemplateVariables: undefined } : { videoPromptTemplateVariables: undefined }),
    }) } } });
}

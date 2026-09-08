import { sameCanvasJSON } from "@/lib/canvas/canvas-sync-baseline";
import { isEmptyStoryboardPlaceholder } from "@/lib/canvas/canvas-project-domain";
import { assertProjectStoryboardContext, upsertProjectChapterStoryboard } from "@/lib/canvas/project-chapter-storyboard";
import type { ProjectShotBatchReceipt, ProjectShotContext } from "@/services/api/projects";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

type CanvasState = { id: string; projectId?: string; nodes: CanvasNodeData[]; connections: CanvasConnection[] };
export type StoryboardButtonAction = {
    id: string;
    userId: string;
    canvasId: string;
    projectId?: string;
    unitId?: string;
    nodeId: string;
    prompt: string;
    createdAt: number;
    before: CanvasState;
    status: "queued" | "preparing" | "running" | "checking" | "verified" | "not_sent" | "needs_review";
    sessionId?: string;
    message: string;
};

export function storyboardActionBusy(action: StoryboardButtonAction | null | undefined) {
    return !!action && ["queued", "preparing", "running", "checking", "needs_review"].includes(action.status);
}

export function createStoryboardButtonAction(input: { id: string; userId: string; canvas: CanvasState; nodeId: string; prompt: string; now?: number }): StoryboardButtonAction {
    const node = input.canvas.nodes.find(node => node.id === input.nodeId);
    if (!input.userId || !input.canvas.id || !/^[A-Za-z0-9-]{1,80}$/.test(input.id) || node?.type !== CanvasNodeType.Script || !input.prompt.trim() || input.prompt.length > 50_000) throw new Error("分镜生成目标或正文不完整，未发送任务");
    const unitId = node.metadata?.chapterId;
    if (unitId && (!input.canvas.projectId || input.canvas.nodes.filter(node => node.type === CanvasNodeType.Script && node.metadata?.chapterId === unitId).length !== 1)) throw new Error("本章分镜节点不唯一或项目未绑定，未发送任务");
    return { id: input.id, userId: input.userId, canvasId: input.canvas.id, projectId: input.canvas.projectId, unitId, nodeId: node.id, prompt: input.prompt.trim(), createdAt: input.now ?? Date.now(), before: structuredClone(input.canvas), status: "queued", message: "正在连接 Codex；只发送一次" };
}

export function assertStoryboardButtonScope(action: StoryboardButtonAction, userId: string, canvas: CanvasState) {
    const node = canvas.nodes.find(node => node.id === action.nodeId);
    if (action.userId !== userId || action.canvasId !== canvas.id || action.projectId !== canvas.projectId || node?.type !== CanvasNodeType.Script || node.metadata?.chapterId !== action.unitId) throw new Error("账号、画布或分镜目标已改变，未发送或重发任务");
}

export function assertStoryboardButtonUnchanged(action: StoryboardButtonAction, userId: string, canvas: CanvasState) {
    assertStoryboardButtonScope(action, userId, canvas);
    const before = action.before.nodes.find(node => node.id === action.nodeId)!;
    const current = canvas.nodes.find(node => node.id === action.nodeId)!;
    if (action.before.nodes.length !== canvas.nodes.length || action.before.nodes.some(node => !canvas.nodes.some(next => next.id === node.id && next.type === node.type && next.title === node.title && (node.id === action.nodeId || sameCanvasJSON(node.metadata, next.metadata))))) throw new Error("来源节点已改变，任务未发送；请核对当前内容");
    if (!sameCanvasJSON(before.metadata, current.metadata) || !sameCanvasJSON(action.before.connections, canvas.connections)) throw new Error("等待期间分镜或连接已改变；请等待保存完成后再发起，未发送任务");
}

export function storyboardButtonPrompt(action: StoryboardButtonAction) {
    const node = action.before.nodes.find(node => node.id === action.nodeId)!;
    const target = { canvasId: action.canvasId, domainProjectId: action.projectId ?? null, unitId: action.unitId ?? null, nodeId: action.nodeId, requestId: `shots-${action.id}` };
    return [
        "用户点击了当前分镜节点的‘Codex 生成分镜’。请实际执行并保存，不只给出聊天方案。",
        `本次固定目标：${JSON.stringify(target)}`,
        "先读取实时上下文、目标节点、完整来源及连接，核对上述身份；若不一致停止。不选择其他作品，不新建画布或替代分镜节点。",
        `镜数：${node.metadata?.storyboardShotCount || "auto"}；每镜时长：${node.metadata?.storyboardShotDuration || "auto"}。auto表示依剧情决定，不能机械按对白切镜。保留完整对白、动作、人物、道具和位置。`,
        action.unitId
            ? "此节点绑定业务章节：先读 project_get_script / project_get_shots 和原 requestId 回执。使用 project_create_or_update_shots 及实时 sourceHash/sourceRevision/expectedShotRevision，修订已有镜头必须复用其ID和版本；用固定requestId保存一次并回读，再 project_sync_storyboard 同步到本节点。返回章节完整覆盖结果。不得只改画布而不保存业务分镜。"
            : "此节点未绑定业务章节：只用画布工具更新该节点 metadata.storyboard.rows，不猜测章节ID、不擅自建业务章节。每行含独立ID、shotNumber、durationSeconds、plotDescription、dialogue、performanceBlocking、camera及适用提示词；完成后回读原节点。",
        `已有内容或连线的镜头行ID必须保留：${JSON.stringify(protectedStoryboardRowIds(action))}。空白且无连接的占位行可替换，不强制凑镜数。所有节点和连接必须保留；只在本节点内修订或新增镜头行，不删除真实镜头、不生成图片/视频、不修改剧本或其他节点。复杂更新先校验再执行；需要确认时走原审批，不绕过。`,
        "响应不确定时查询原请求和当前结果，不换requestId重写。最后报告保存和回读的实际结果，未完成不得称成功。",
        "以下是用户的分镜创作要求：",
        action.prompt,
    ].join("\n\n");
}

// Readback verifies the original node, not an assistant's completion sentence.
export function verifyStoryboardButtonResult(action: StoryboardButtonAction, userId: string, local: CanvasState, remote: CanvasState, business?: { context: ProjectShotContext; receipt: ProjectShotBatchReceipt }) {
    assertStoryboardButtonScope(action, userId, local);
    assertStoryboardButtonScope(action, userId, remote);
    const node = remote.nodes.find(node => node.id === action.nodeId)!;
    const rows = node.metadata?.storyboard?.rows ?? [];
    if (!rows.length || rows.some(row => !row.id || !Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0 || !(row.plotDescription?.trim() || row.videoMotionPrompt?.trim())) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("分镜正文、行身份或时长不完整，不能确认完成");
    const before = action.before.nodes.find(node => node.id === action.nodeId)!;
    if (protectedStoryboardRowIds(action).some(id => !rows.some(next => next.id === id))) throw new Error("原有镜头行缺失，请核对原作品；未自动覆盖恢复");
    if (action.before.connections.length !== remote.connections.length || action.before.connections.some(connection => !remote.connections.some(next => sameCanvasJSON(connection, next)))) throw new Error("原有连接发生变化，请核对原作品");
    if (action.before.nodes.length !== remote.nodes.length || action.before.nodes.some(beforeNode => beforeNode.id !== action.nodeId && !remote.nodes.some(next => sameCanvasJSON(beforeNode, next)))) throw new Error("目标以外的节点发生变化，不能确认本次窄范围完成");
    if (!sameCanvasJSON(local.nodes.find(node => node.id === action.nodeId)?.metadata?.storyboard, node.metadata?.storyboard)) throw new Error("当前页面与已保存分镜不一致，请先回读；未覆盖页面草稿");
    if (sameCanvasJSON(before.metadata?.storyboard?.rows ?? [], rows)) throw new Error("原分镜尚无变更；不能把聊天回复当作已生成");
    if (action.unitId) {
        if (!business) throw new Error("缺少本次业务分镜回执");
        const { context, receipt } = business;
        if (receipt.requestId !== `shots-${action.id}` || receipt.projectId !== action.projectId || receipt.unitId !== action.unitId || !sameCanvasJSON(receipt.shots, context.shots)) throw new Error("分镜不是原请求的当前保存结果，请核对原请求");
        assertProjectStoryboardContext(context, { projectId: action.projectId!, unitId: action.unitId, expectedShotRevision: receipt.shotRevision, sourceRevision: receipt.sourceRevision, sourceHash: receipt.sourceHash });
        if (!context.coverage.chapterComplete || !context.coverage.dialogueMatches || context.coverage.missingParagraphIds.length) throw new Error("本章来源或对白未完整覆盖");
        const projection = upsertProjectChapterStoryboard(remote.nodes, remote.connections, { unit: context.unit, shots: context.shots });
        if (projection.scriptNodeId !== action.nodeId || !sameCanvasJSON(projection.nodes.find(node => node.id === action.nodeId)?.metadata?.storyboard?.rows, rows)) throw new Error("业务镜头与画布逐行内容不一致");
    }
    return { rowCount: rows.length, durationSeconds: rows.reduce((sum, row) => sum + row.durationSeconds, 0) };
}

function protectedStoryboardRowIds(action: StoryboardButtonAction) {
    const rows = action.before.nodes.find(node => node.id === action.nodeId)?.metadata?.storyboard?.rows ?? [];
    return rows.filter(row => !isEmptyStoryboardPlaceholder(row, action.nodeId, action.before.connections)).map(row => row.id);
}

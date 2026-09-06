import { getCanvasPromptHistory, getCanvasPromptReceipt, getCanvasPromptRevision, verifyCanvasPromptRevision, type CanvasPromptInput, type CanvasPromptTarget } from "./canvas-prompts";
import { getRemoteCanvasProject } from "./user-data";

export const projectPromptToolNames = ["project_get_prompt", "project_save_prompt", "project_get_prompt_revision", "project_get_prompt_request"] as const;
export type ProjectPromptToolName = typeof projectPromptToolNames[number];

// Load the existing sync authority only when used; schema/tool-list imports must
// not initialize browser persistence or a parallel prompt service.
const promptPort = {
    load: async (canvasId: string, target: CanvasPromptTarget) => (await import("../user-data-sync")).loadSyncedCanvasPrompt(canvasId, target),
    save: async (canvasId: string, input: CanvasPromptInput) => (await import("../user-data-sync")).saveSyncedCanvasPrompt(canvasId, input),
    getRemoteCanvasProject, getCanvasPromptHistory, getCanvasPromptRevision, getCanvasPromptReceipt,
};

export async function runProjectPromptTool(name: ProjectPromptToolName, raw: Record<string, unknown>, projectId: string, canvasId: string | undefined, port = promptPort) {
    if (!projectId || !canvasId || (raw.projectId !== undefined && raw.projectId !== projectId) || (raw.canvasId !== undefined && raw.canvasId !== canvasId)) throw new Error("提示词工具必须绑定当前授权业务项目和画布");
    if (raw.kind !== "image" && raw.kind !== "video") throw new Error("提示词 kind 必须为 image 或 video");
    const target: CanvasPromptTarget = { projectId, nodeId: text(raw.nodeId, "nodeId"), rowId: text(raw.rowId, "rowId"), kind: raw.kind };
    if (name === "project_get_prompt") {
        const [{ context, appliedLocally }, history] = await Promise.all([port.load(canvasId, target), port.getCanvasPromptHistory(canvasId, target)]);
        return { ...context, history, appliedLocally, note: "普通创作草稿；dependencies 是真实绑定，visualVerified=false 不是看图。保存必须使用本次 state 和 dependencyHash，不能以旧稿冒充模型适配完成。" };
    }
    if (name === "project_save_prompt") {
        const input: CanvasPromptInput = { ...target, requestId: text(raw.requestId, "requestId"), expectedRevision: version(raw.expectedRevision), expectedContentHash: text(raw.expectedContentHash, "expectedContentHash"), dependencyHash: text(raw.dependencyHash, "dependencyHash"), prompt: text(raw.prompt, "prompt") };
        const result = await port.save(canvasId, input);
        const currentVerified = result.matchesCurrent && result.appliedLocally && !result.context.stale;
        return {
            ok: currentVerified,
            message: currentVerified ? `已保存并回读第 ${result.context.dependencies.shot.position + 1} 镜${target.kind === "image" ? "图片" : "视频"}提示词 v${result.context.state.revision}；未生成图片或视频` : "原请求已保存，但当前文本、来源或本地映射已变化；请回读核对，不重发新请求冒充完成。",
            data: { receipt: result.receipt, context: result.context, replayed: result.replayed, recoveredResponse: result.recoveredResponse, verification: { ok: currentVerified, persisted: result.persisted, matchesCurrent: result.matchesCurrent, appliedLocally: result.appliedLocally, sourceCurrent: !result.context.stale }, location: { canvasId, ...target } },
        };
    }
    // History must remain readable when a row/source was removed. Check the
    // owning canvas/project, not current dependencies or a fabricated fallback.
    const { project } = await port.getRemoteCanvasProject(canvasId);
    if (project.id !== canvasId || project.projectId !== projectId) throw new Error("历史不属于当前授权项目画布");
    if (name === "project_get_prompt_revision") {
        const revision = version(raw.revision);
        const value = await port.getCanvasPromptRevision(canvasId, target, revision);
        await verifyCanvasPromptRevision(value, canvasId, target, revision);
        return { revision: value, historical: true, note: "仅回读历史，不采用或恢复；当前文本须用 project_get_prompt 核对。" };
    }
    const requestId = text(raw.requestId, "requestId");
    const receipt = await port.getCanvasPromptReceipt(canvasId, requestId);
    if (receipt.canvasId !== canvasId || receipt.requestId !== requestId || !/^[a-f0-9]{64}$/.test(receipt.requestHash) || receipt.snapshot.requestId !== requestId || receipt.snapshot.revision < 1) throw new Error("提示词原请求回执身份不匹配");
    await verifyCanvasPromptRevision(receipt.snapshot, canvasId, target, receipt.snapshot.revision);
    return { receipt, historical: true, note: "这是原请求的持久回执，不代表当前仍为该版；勿换 requestId 重复写入。" };
}

function text(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${name}`);
    return value;
}
function version(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("必须使用读取结果的提示词版本；原稿版本为0");
    return value;
}

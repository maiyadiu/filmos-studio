import { request, apiClient } from "./request";
import { getProjectUnit, type ProjectScriptRevision } from "./projects";
import { hashScriptContent } from "@/film/story/script-version";

export interface ScriptCreationInput {
    expectedProjectRevision: number;
    requestId: string;
    note: string;
    chapters: { title: string; sourceText: string }[];
}
export interface ScriptCreationResult {
    receipt: { id: string; projectId: string; requestId: string; requestHash: string; projectRevision: number; unitIds: string[]; createdBy: string; createdAt: string };
    revisions: ProjectScriptRevision[];
    replayed: boolean;
}
export function createProjectScript(projectId: string, input: ScriptCreationInput) {
    return request<ScriptCreationResult>(apiClient.post(`/projects/${encodeURIComponent(projectId)}/script-batches`, input));
}
export function getProjectScriptBatch(projectId: string, requestId: string) {
    return request<ScriptCreationResult>(apiClient.get(`/projects/${encodeURIComponent(projectId)}/script-batches/${encodeURIComponent(requestId)}`));
}
export const projectScriptCreationToolNames = ["project_create_script", "project_get_script_batch"] as const;
type CreationPort = { createProjectScript: typeof createProjectScript; getProjectScriptBatch: typeof getProjectScriptBatch; getProjectUnit: typeof getProjectUnit };
const port: CreationPort = { createProjectScript, getProjectScriptBatch, getProjectUnit };

export async function runProjectScriptCreationTool(name: typeof projectScriptCreationToolNames[number], input: Record<string, unknown>, projectId: string, api: CreationPort = port) {
    if (!projectId || (input.projectId !== undefined && input.projectId !== projectId)) throw new Error("剧本创建必须绑定当前授权项目");
    if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.trim() !== input.requestId || input.requestId.length > 100) throw new Error("必须提供稳定requestId");
    let saved: ScriptCreationResult | undefined;
    let creation: ScriptCreationInput | undefined;
    if (name === "project_create_script") {
        if (!Number.isSafeInteger(input.expectedProjectRevision) || Number(input.expectedProjectRevision) < 1 || typeof input.note !== "string" || !input.note.trim() || input.note.length > 1000) throw new Error("必须使用当前项目版本并说明创作要求");
        if (!Array.isArray(input.chapters) || input.chapters.length < 1 || input.chapters.length > 50) throw new Error("请提供1–50个完整章节");
        let bytes = 0;
        const chapters = input.chapters.map((chapter: unknown) => {
            if (!chapter || typeof chapter !== "object") throw new Error("章节参数无效");
            const c = chapter as Record<string, unknown>;
            if (typeof c.title !== "string" || !c.title.trim() || new TextEncoder().encode(c.title).length > 960 || typeof c.sourceText !== "string" || !c.sourceText.trim()) throw new Error("必须提供章节标题和完整正文");
            bytes += new TextEncoder().encode(c.sourceText).length;
            if (bytes > 2 * 1024 * 1024) throw new Error("整批正文超过2MiB");
            return { title: c.title.trim(), sourceText: c.sourceText };
        });
        creation = { expectedProjectRevision: Number(input.expectedProjectRevision), requestId: input.requestId, note: input.note, chapters };
        saved = await api.createProjectScript(projectId, creation);
    }
    const result = await api.getProjectScriptBatch(projectId, input.requestId);
    const receipt = result.receipt;
    if (receipt.projectId !== projectId || receipt.requestId !== input.requestId || !receipt.id || !/^[a-f0-9]{64}$/.test(receipt.requestHash)
        || !Array.isArray(receipt.unitIds) || !receipt.unitIds.length || receipt.unitIds.length > 50 || new Set(receipt.unitIds).size !== receipt.unitIds.length
        || result.revisions.length !== receipt.unitIds.length || (saved && saved.receipt.id !== receipt.id)
        || (creation && (receipt.projectRevision !== creation.expectedProjectRevision + 1 || creation.chapters.length !== receipt.unitIds.length))) throw new Error("建章回执身份不一致；请回读，勿重复提交");
    let matchesCurrent = true;
    for (let i = 0; i < receipt.unitIds.length; i++) {
        const row = result.revisions[i], expected = creation?.chapters[i];
        if (row.projectId !== projectId || row.unitId !== receipt.unitIds[i] || row.revision !== 1 || row.requestId !== input.requestId
            || row.sourceHash !== await hashScriptContent(row.sourceText ?? "") || (expected && (row.title !== expected.title || row.sourceText !== expected.sourceText))) throw new Error("建章正文或哈希回读不一致；勿重复提交");
        const { unit } = await api.getProjectUnit(projectId, row.unitId);
        if (unit.id !== row.unitId || unit.projectId !== projectId) throw new Error("当前章节身份不匹配");
        if (unit.revision !== row.revision || unit.sourceText !== row.sourceText || unit.title !== row.title) matchesCurrent = false;
    }
    if (typeof window !== "undefined" && saved) window.dispatchEvent(new CustomEvent("filmos:script-revised", { detail: { projectId, unitIds: receipt.unitIds } }));
    return { ok: true, message: matchesCurrent ? `已保存${receipt.unitIds.length}个章节初稿，正文和历史回读通过` : "初稿回执已核验；当前章节已有后续修改，请读取最新正文",
        data: { ...result, replayed: saved?.replayed ?? result.replayed, verification: { ok: true, persisted: true, matchesCurrent } } };
}

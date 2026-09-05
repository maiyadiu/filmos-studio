import { getProjectUnit, getProjectScriptRevision, reviseProjectScript } from "./projects";
import { hashScriptContent } from "@/film/story/script-version";

export const projectScriptToolNames = ["project_get_script", "project_get_script_revision", "project_revise_script"] as const;
export type ProjectScriptToolName = typeof projectScriptToolNames[number];
type ScriptPort = { getProjectUnit: typeof getProjectUnit; getProjectScriptRevision: typeof getProjectScriptRevision; reviseProjectScript: typeof reviseProjectScript };
const scriptPort: ScriptPort = { getProjectUnit, getProjectScriptRevision, reviseProjectScript };

export function applyScriptEdits(source: string, rawEdits: unknown): string {
    if (!Array.isArray(rawEdits) || !rawEdits.length || rawEdits.length > 20) throw new Error("请提供 1–20 处精确修改");
    let result = source;
    for (const edit of rawEdits) {
        if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") throw new Error("修改必须包含非空 oldText 和字符串 newText");
        const start = result.indexOf(edit.oldText);
        if (start < 0 || result.indexOf(edit.oldText, start + 1) >= 0) throw new Error("原文片段不存在或不唯一；请重新读取并扩大定位范围，未保存");
        result = result.slice(0, start) + edit.newText + result.slice(start + edit.oldText.length);
    }
    if (result === source) throw new Error("本次修订没有改变正文");
    if (new TextEncoder().encode(result).length > 2 * 1024 * 1024) throw new Error("修订正文超过大小限制");
    return result;
}

export async function runProjectScriptTool(name: ProjectScriptToolName, input: Record<string, unknown>, projectId: string, port: ScriptPort = scriptPort) {
    const unitId = requiredText(input.unitId, "unitId");
    if (!projectId || (input.projectId !== undefined && input.projectId !== projectId)) throw new Error("剧本工具必须绑定当前授权项目");
    if (name === "project_get_script") {
        const { unit } = await port.getProjectUnit(projectId, unitId);
        if (unit.projectId !== projectId || unit.id !== unitId || !Number.isSafeInteger(unit.revision) || unit.revision < 1) throw new Error("剧本身份或版本不匹配");
        return { unit, sourceHash: await hashScriptContent(unit.sourceText), sourceFormat: "html", editable: ["draft", "ready"].includes(unit.status) };
    }
    if (name === "project_get_script_revision") {
        const result = await port.getProjectScriptRevision(projectId, unitId, requiredVersion(input.revision));
        await verifyRevision(result.revision, projectId, unitId, requiredVersion(input.revision));
        return result;
    }
    const expectedRevision = requiredVersion(input.expectedRevision);
    const requestId = requiredText(input.requestId, "requestId");
    const note = requiredText(input.note, "note");
    if (requestId.length > 100 || note.length > 1000) throw new Error("修订请求或说明过长");
    // Read the exact base even on retry. Rebuilding from the newest chapter
    // would change the request identity and could silently overwrite another edit.
    const { revision: before } = await port.getProjectScriptRevision(projectId, unitId, expectedRevision);
    await verifyRevision(before, projectId, unitId, expectedRevision);
    if (!["draft", "ready"].includes(before.status)) throw new Error("已完成的章节不能由修订工具直接更改");
    const sourceText = applyScriptEdits(before.sourceText ?? "", input.edits);
    const saved = await port.reviseProjectScript(projectId, unitId, { expectedRevision, requestId, sourceText, title: before.title, note });
    // A successful POST alone is not evidence of a persisted, current revision.
    const [{ revision: after }, { unit }] = await Promise.all([
        port.getProjectScriptRevision(projectId, unitId, expectedRevision + 1), port.getProjectUnit(projectId, unitId),
    ]);
    await verifyRevision(after, projectId, unitId, expectedRevision + 1);
    if ((after.sourceText ?? "") !== sourceText || after.requestId !== requestId || saved.revision.id !== after.id || unit.id !== unitId || unit.projectId !== projectId || unit.revision !== after.revision || unit.sourceText !== sourceText) {
        throw new Error("修订请求已返回，但回读不一致或正文又被修改；请重新读取，勿重复提交");
    }
    const message = `剧本已保存为修订 v${after.revision}，原版 v${before.revision} 已保留，回读核验通过`;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("filmos:script-revised", { detail: { projectId, unitId, revision: after.revision } }));
    return { ok: true, message, data: { before, after, replayed: saved.replayed, verification: { ok: true, persisted: true, currentRevision: unit.revision, sourceHash: after.sourceHash } } };
}

async function verifyRevision(revision: Awaited<ReturnType<typeof getProjectScriptRevision>>["revision"], projectId: string, unitId: string, version: number) {
    if (revision.projectId !== projectId || revision.unitId !== unitId || revision.revision !== version || revision.sourceHash !== await hashScriptContent(revision.sourceText ?? "")) throw new Error("剧本修订身份或正文哈希不匹配");
}

function requiredText(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${name}`);
    return value;
}
function requiredVersion(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("必须使用读取结果中的修订号");
    return value;
}

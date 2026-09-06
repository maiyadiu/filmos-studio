import { hashScriptContent } from "@/film/story/script-version";
import { buildShotDialogueReview } from "@/film/story/shot-source-review";
import {
    getProjectShotContext, getProjectShotBatch, getProjectShotRevisions, saveProjectUnitShots,
    type ProjectShot, type ProjectShotBatchInput, type ProjectShotBatchReceipt, type ProjectShotContext,
} from "./projects";

export const projectShotToolNames = ["project_get_shots", "project_get_shot_batch", "project_get_shot_revisions", "project_create_or_update_shots"] as const;
export type ProjectShotToolName = typeof projectShotToolNames[number];
type ShotPort = {
    getProjectShotContext: typeof getProjectShotContext; getProjectShotBatch: typeof getProjectShotBatch;
    getProjectShotRevisions: typeof getProjectShotRevisions; saveProjectUnitShots: typeof saveProjectUnitShots;
};
const shotPort: ShotPort = { getProjectShotContext, getProjectShotBatch, getProjectShotRevisions, saveProjectUnitShots };

export async function runProjectShotTool(name: ProjectShotToolName, input: Record<string, unknown>, projectId: string, port: ShotPort = shotPort) {
    if (!projectId || (input.projectId !== undefined && input.projectId !== projectId)) throw new Error("分镜工具必须绑定当前授权项目");
    if (name === "project_get_shot_revisions") {
        const shotId = text(input.shotId, "shotId");
        const result = await port.getProjectShotRevisions(projectId, shotId);
        for (const row of result.revisions) {
            if (row.projectId !== projectId || row.shotId !== shotId || row.shot.id !== shotId || row.shot.projectId !== projectId || row.shot.unitId !== row.unitId || row.shot.revision !== row.revision) throw new Error("镜头历史身份不匹配");
        }
        return result;
    }
    const unitId = text(input.unitId, "unitId");
    if (name === "project_get_shots") {
        const result = await port.getProjectShotContext(projectId, unitId);
        await verifyContext(result, projectId, unitId);
        return { ...result, dialogueReview: buildShotDialogueReview(result), editable: ["draft", "ready"].includes(result.unit.status), paragraphIdentityScope: "unitId + sourceRevision + sourceHash" };
    }
    const requestId = text(input.requestId, "requestId");
    if (name === "project_get_shot_batch") {
        const result = await port.getProjectShotBatch(projectId, unitId, requestId);
        verifyReceipt(result.receipt, projectId, unitId, requestId);
        return { ...result, historicalReceipt: true, note: "这是该请求的持久回执；当前镜头状态请用 project_get_shots 回读，不据此重复创建。" };
    }
    if (!Array.isArray(input.shots) || !input.shots.length || input.shots.length > 100 || input.shots.some(shot => !shot || typeof shot !== "object")) throw new Error("需要完整的1–100个镜头，非法条目不得跳过");
    if (!Array.isArray(input.sourceParagraphIds) || !input.sourceParagraphIds.length || input.sourceParagraphIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("请明确sourceParagraphIds；全章拆镜选择全部来源段落");
    const body: ProjectShotBatchInput = {
        requestId, expectedShotRevision: version(input.expectedShotRevision, 0), sourceRevision: version(input.sourceRevision, 1),
        sourceHash: text(input.sourceHash, "sourceHash"), sourceParagraphIds: input.sourceParagraphIds as string[], shots: input.shots as ProjectShotBatchInput["shots"],
    };
    // Never rebuild a retry from the newest chapter or replace missing shots.
    // The server validates every item and commits the entire batch atomically.
    const saved = await port.saveProjectUnitShots(projectId, unitId, body);
    const [{ receipt }, current] = await Promise.all([
        port.getProjectShotBatch(projectId, unitId, requestId), port.getProjectShotContext(projectId, unitId),
    ]);
    verifyReceipt(receipt, projectId, unitId, requestId);
    await verifyContext(current, projectId, unitId);
    if (!sameJSON(receipt.sourceParagraphIds, body.sourceParagraphIds)) throw new Error("批次来源范围与请求不一致");
    if (!sameJSON(saved.receipt, receipt) || receipt.shotRevision !== body.expectedShotRevision + 1 || receipt.sourceRevision !== body.sourceRevision || receipt.sourceHash !== body.sourceHash || receipt.shots.length !== body.shots.length) throw new Error("批次回执不匹配，请回读，勿重复创建镜头");
    for (let i = 0; i < body.shots.length; i++) {
        const expected = body.shots[i], shot = receipt.shots[i];
        if ((expected.id && shot.id !== expected.id) || shot.revision !== expected.expectedRevision + 1 || shot.title !== expected.title.trim() || shot.description !== expected.description || shot.position !== expected.position || shot.durationMs !== expected.durationMs || !sameJSON(shot.content, expected.content)) throw new Error("镜头保存正文与请求不一致，请回读，勿重复创建");
    }
    const currentById = new Map(current.shots.map(shot => [shot.id, shot]));
    const matchesCurrent = current.unit.revision === receipt.sourceRevision && current.sourceHash === receipt.sourceHash && receipt.shots.every(shot => sameJSON(currentById.get(shot.id), shot));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("filmos:shots-revised", { detail: { projectId, unitId, shotRevision: current.unit.shotRevision } }));
    return {
        ok: true,
        message: matchesCurrent ? `已保存并回读核验 ${receipt.shots.length} 个镜头；原ID、历史及未指定镜头保留` : "该请求已保存，但之后镜头或脚本已有变化；旧回执不是当前结果，请回读并复核，不重复创建。",
        data: { receipt, replayed: saved.replayed, verification: { persisted: true, matchesCurrent, currentShotRevision: current.unit.shotRevision, staleShotIds: current.staleShotIds, coverage: current.coverage, semanticDirectingQuality: "NOT_PROVEN_BY_SOURCE_MATCHING" } },
    };
}

async function verifyContext(value: ProjectShotContext, projectId: string, unitId: string) {
    if (value.unit.id !== unitId || value.unit.projectId !== projectId || value.unit.revision < 1 || !Number.isSafeInteger(value.unit.shotRevision) || value.unit.shotRevision < 0 || value.sourceHash !== await hashScriptContent(value.unit.sourceText)) throw new Error("章节身份、版本或哈希不匹配");
    verifyShots(value.shots, projectId, unitId);
}
function verifyReceipt(value: ProjectShotBatchReceipt, projectId: string, unitId: string, requestId: string) {
    if (!value.id || value.projectId !== projectId || value.unitId !== unitId || value.requestId !== requestId || value.shotRevision < 1) throw new Error("镜头批次身份不匹配");
    verifyShots(value.shots, projectId, unitId);
    if (value.shots.some(shot => shot.sourceHash !== value.sourceHash || shot.sourceRevision !== value.sourceRevision)) throw new Error("批次镜头来源不匹配");
}
function verifyShots(shots: ProjectShot[], projectId: string, unitId: string) {
    const ids = new Set<string>();
    for (const shot of shots) {
        if (!shot.id || ids.has(shot.id) || shot.projectId !== projectId || shot.unitId !== unitId || !Number.isSafeInteger(shot.revision) || shot.revision < 1) throw new Error("镜头身份或版本不匹配");
        ids.add(shot.id);
    }
}
function text(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${name}`);
    return value;
}
function version(value: unknown, min: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error("请使用读取结果的镜头/来源修订号");
    return value;
}
function sameJSON(a: unknown, b: unknown): boolean {
    // HTTP serializers may reorder object keys; arrays and all values stay exact.
    const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

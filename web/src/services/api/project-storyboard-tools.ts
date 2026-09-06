import type { ProjectStoryboardSyncInput } from "@/lib/canvas/project-chapter-storyboard";

const storyboardPort = {
    sync: async (canvasId: string, input: ProjectStoryboardSyncInput) => (await import("../user-data-sync")).syncSyncedProjectStoryboard(canvasId, input),
};

export async function runProjectStoryboardTool(raw: Record<string, unknown>, projectId: string, canvasId: string | undefined, port = storyboardPort) {
    if (!projectId || !canvasId || (raw.projectId !== undefined && raw.projectId !== projectId)) throw new Error("分镜同步必须绑定当前授权业务项目和画布");
    if (Object.keys(raw).some(key => !["projectId", "unitId", "expectedShotRevision", "sourceRevision", "sourceHash"].includes(key))) throw new Error("分镜同步不接受另一画布、生成、上传或新增对象参数");
    if (typeof raw.unitId !== "string" || !raw.unitId.trim() || typeof raw.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceHash) || typeof raw.expectedShotRevision !== "number" || !Number.isSafeInteger(raw.expectedShotRevision) || raw.expectedShotRevision < 0 || typeof raw.sourceRevision !== "number" || !Number.isSafeInteger(raw.sourceRevision) || raw.sourceRevision < 1) throw new Error("必须使用 project_get_shots 返回的真实章节、分镜版本和剧本版本/哈希");
    const result = await port.sync(canvasId, { projectId, unitId: raw.unitId, expectedShotRevision: raw.expectedShotRevision, sourceRevision: raw.sourceRevision, sourceHash: raw.sourceHash });
    return {
        ok: result.verification.ok,
        message: result.verification.ok ? `已将 ${result.location.rows.length} 个业务分镜同步到当前画布，并回读核验；未生成媒体` : `画布分镜已保存，但尚未完成核对：${result.issue || "来源或章节关联已变化"}；不要继续依赖未确认的结果`,
        data: result,
    };
}

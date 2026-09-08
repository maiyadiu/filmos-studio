import type { ProjectAssetCandidate, ProjectDetail, ProjectUnit } from "@/services/api/projects";
import type { AgentPageSnapshot } from "./workspace-agent-context";
import type { BrainSessionView } from "./agent-client";
import { normalizeCharacterName } from "@/lib/canvas/canvas-character-reference";
import { documentTextFromHtml } from "@/lib/document-text";

export type CharacterButtonAction = {
    id: string;
    userId: string;
    projectId: string;
    unitId: string;
    sourceRevision: number;
    sourceText: string;
    createdAt: number;
    status: "queued" | "preparing" | "running" | "needs_review" | "verified" | "no_change" | "not_sent";
    message: string;
    sessionId?: string;
    beforeCandidates?: ProjectAssetCandidate[];
};

export function characterActionBusy(action: CharacterButtonAction | null | undefined) {
    return !!action && ["queued", "preparing", "running", "needs_review"].includes(action.status);
}

export function createCharacterButtonAction(input: { id: string; userId: string; projectId: string; unit: ProjectUnit; dirty: boolean; now?: number }): CharacterButtonAction {
    if (!input.userId || !input.projectId || !/^[A-Za-z0-9-]{1,80}$/.test(input.id) || !input.unit.id || input.unit.projectId !== input.projectId || !Number.isInteger(input.unit.revision) || input.unit.revision < 1 || !documentTextFromHtml(input.unit.sourceText).trim()) throw new Error("章节身份或正文尚未确认，未发送角色提取");
    if (input.dirty) throw new Error("请先保存当前章节，再提取角色");
    return { id: input.id, userId: input.userId, projectId: input.projectId, unitId: input.unit.id, sourceRevision: input.unit.revision, sourceText: input.unit.sourceText,
        createdAt: input.now ?? Date.now(), status: "queued", message: "正在连接当前章节的 Codex；只发送一次" };
}

export function assertCharacterButtonScope(action: CharacterButtonAction, userId: string, snapshot: AgentPageSnapshot) {
    if (userId !== action.userId || snapshot.contextKind !== "project" || snapshot.domainProjectId !== action.projectId || snapshot.projectId !== action.projectId || snapshot.contentUnitId !== action.unitId || snapshot.contentUnitRevision !== action.sourceRevision || snapshot.blockers?.length) throw new Error("账号、章节、版本或草稿状态已改变；角色任务未发送或重发");
}

export function assertCharacterButtonDispatch(action: CharacterButtonAction, userId: string, snapshot: AgentPageSnapshot, enabled: boolean, now = Date.now()) {
    assertCharacterButtonScope(action, userId, snapshot);
    if (!enabled || now < action.createdAt || now - action.createdAt >= 45_000) throw new Error("Codex 已停用或发送等待到期，角色任务未发送；不会迟到补发");
}

export function assertCharacterButtonSource(action: CharacterButtonAction, detail: ProjectDetail, unit: ProjectUnit) {
    if (detail.project.id !== action.projectId || detail.project.userId !== action.userId || detail.project.status === "archived" || unit.projectId !== action.projectId || unit.id !== action.unitId || unit.revision !== action.sourceRevision || unit.sourceText !== action.sourceText) throw new Error("已保存的角色来源发生变化，请核对当前章节；未重复写入");
}

export function characterButtonPrompt(action: CharacterButtonAction) {
    return [
        "用户点击了‘Codex 提取角色’。请读取完整已保存章节并实际保存文字角色候选，不只在聊天中给方案。",
        `固定目标：${JSON.stringify({ domainProjectId: action.projectId, unitId: action.unitId, sourceRevision: action.sourceRevision, extractionRequestId: `characters-${action.id}` })}`,
        "先读 workbench_get_context、project_get_script 和 project_get_context（含 assetCandidates、assets）。核对账号/项目/章节/版本，若身份改变或存在未保存草稿立即停止。不要猜测ID。",
        "对照完整正文提取真实出现的角色与别名，检查已有候选和正式角色；已有同名或别名角色不要重复创建。无新增角色时明确报告，不为凑数创建。",
        "用 project_extract_asset_candidates 保存 category=character 的文字卡：details 必须有非空 role、voiceLanguage、voiceAge、voiceTimbre；appearance/clothing/physique/personality/consistencyPrompt/multiViewPrompt 至少三项非空。原文没有设定的标为‘原文未设定/待设计’，创作建议与原文事实分开，附可回查的来源片段。不捏造已经锁定的外貌或声音。",
        `每个本次新增候选都绑定 unitId=${action.unitId}；details 附 extractionRequestId="characters-${action.id}"、sourceRevision=${action.sourceRevision}。这些仅为回读关联标记，不是后端幂等保证。一次批量提交；响应不确定先查原会话工具结果和当前候选，不盲目重发或更换请求标记。`,
        "保存后用 project_get_context 的 assetCandidates 逐项回读本次标记、角色名和全部字段。仅建立待确认文字卡，不确认/锁定资产，不生成或上传图片，不修改剧本/分镜/画布。需要审批时沿用当前会话审批，不能绕过。最后区分已保存候选、已有角色、未完成项。",
    ].join("\n\n");
}

export function verifyCharacterButtonResult(action: CharacterButtonAction, session: BrainSessionView, detail: ProjectDetail, unit: ProjectUnit) {
    assertCharacterButtonSource(action, detail, unit);
    const receipt = session.latestTurnReceipt;
    if (!action.sessionId || session.id !== action.sessionId || session.projectId !== action.projectId || session.domainProjectId !== action.projectId || session.contentUnitId !== action.unitId || session.canvasId !== null || session.brainProfileId !== "codex.subscription"
        || !session.execution || session.execution.activeTurnId || session.execution.resuming || session.execution.pendingConfirmations.length || receipt?.turnId !== `characters-${action.id}` || !["completed", "failed", "cancelled"].includes(receipt.status) || !receipt.finishedAt || !Number.isFinite(Date.parse(receipt.finishedAt))) throw new Error("原轮次尚未结束或身份不明；请核对原会话，不会重发");
    const before = action.beforeCandidates;
    if (!before) throw new Error("缺少发送前候选基线，不能确认保存");
    const current = detail.assetCandidates;
    if (before.some(candidate => !current.some(next => next.id === candidate.id && JSON.stringify(next) === JSON.stringify(candidate)))) throw new Error("已有角色候选发生变化，请核对原结果");
    const added = current.filter(candidate => !before.some(old => old.id === candidate.id));
    if (!added.length && receipt.writeAttempted === false) return { status: "no_change" as const, count: 0 };
    if (!added.length) throw new Error("未读到本次新增角色，不能把聊天回复当作保存完成");
    const names = new Set(before.filter(candidate => candidate.category === "character").map(candidate => normalizeCharacterName(candidate.name)));
    for (const asset of detail.assets) if (asset.category === "character") names.add(normalizeCharacterName(asset.title));
    for (const candidate of added) {
        const fields = JSON.parse(candidate.detailsJson) as Record<string, unknown>;
        const text = (key: string) => typeof fields?.[key] === "string" && (fields[key] as string).trim().length > 0;
        const name = normalizeCharacterName(candidate.name);
        if (candidate.projectId !== action.projectId || candidate.unitId !== action.unitId || candidate.category !== "character" || candidate.status !== "pending_confirmation" || !name || names.has(name)
            || fields?.extractionRequestId !== `characters-${action.id}` || fields?.sourceRevision !== action.sourceRevision
            || !["role", "voiceLanguage", "voiceAge", "voiceTimbre"].every(text) || ["appearance", "clothing", "physique", "personality", "consistencyPrompt", "multiViewPrompt"].filter(text).length < 3) throw new Error("角色候选身份、来源关联或文字卡字段不完整，不能确认本次保存");
        names.add(name);
    }
    return { status: "verified" as const, count: added.length };
}

import { afterEach, expect, test } from "bun:test";
import { assertCharacterButtonDispatch, assertCharacterButtonScope, assertCharacterButtonSource, characterButtonPrompt, createCharacterButtonAction, verifyCharacterButtonResult } from "../src/film/agent/character-button-action";
import { buildProjectAgentSnapshot } from "../src/film/agent/project-agent-context";
import { claimCharacterButtonAction, patchCharacterButtonAction, queueCharacterButtonAction, queueStoryboardButtonAction, useCanvasAgentStore } from "../src/stores/canvas/use-canvas-agent-store";
import type { ProjectDetail, ProjectUnit, ProjectAssetCandidate } from "../src/services/api/projects";
import type { BrainSessionView } from "../src/film/agent/agent-client";
import type { StoryboardButtonAction } from "../src/film/agent/storyboard-button-action";

const initial = useCanvasAgentStore.getState();
afterEach(() => useCanvasAgentStore.setState(initial));
function fixture() {
    const unit = { id: "chapter", projectId: "project", revision: 2, title: "雨夜", sourceText: "<p>林夏：那封信是谁送来的？</p>" } as ProjectUnit;
    const detail = { project: { id: "project", userId: "user", revision: 1, status: "active" }, units: [unit], assetCandidates: [], assets: [] } as unknown as ProjectDetail;
    const action = createCharacterButtonAction({ id: "one-click", userId: "user", projectId: "project", unit, dirty: false });
    action.sessionId = "original-session"; action.beforeCandidates = [];
    const snapshot = buildProjectAgentSnapshot(detail, "chapters", { projectId: "project", unitId: unit.id, revision: 2, ready: true, dirty: false });
    const fields = { role: "提出疑问的人", voiceLanguage: "原文未设定/待设计", voiceAge: "原文未设定/待设计", voiceTimbre: "原文未设定/待设计", appearance: "原文未设定/待设计", clothing: "原文未设定/待设计", physique: "原文未设定/待设计", extractionRequestId: "characters-one-click", sourceRevision: 2 };
    const candidate = { id: "candidate", name: "林夏", category: "character", status: "pending_confirmation", projectId: "project", unitId: "chapter", detailsJson: JSON.stringify(fields) } as ProjectAssetCandidate;
    const saved = { ...detail, assetCandidates: [candidate] };
    const session = { id: action.sessionId, brainProfileId: "codex.subscription", projectId: "project", domainProjectId: "project", contentUnitId: "chapter", canvasId: null,
        execution: { activeTurnId: null, resuming: false, pendingConfirmations: [] }, latestTurnReceipt: { turnId: "characters-one-click", status: "completed", finishedAt: new Date().toISOString(), writeAttempted: true } } as BrainSessionView;
    return { unit, detail, action, snapshot, fields, candidate, saved, session };
}

test("character button captures actual saved chapter and rejects dirty/empty/foreign source", () => {
    const { unit, action } = fixture();
    unit.sourceText = "later";
    expect(action.sourceText).toContain("林夏");
    for (const patch of [{ userId: "" }, { dirty: true }, { unit: { ...unit, projectId: "else" } }, { unit: { ...unit, sourceText: " " } }, { unit: { ...unit, sourceText: "<p><br></p>" } }, { unit: { ...unit, revision: 0 } }]) {
        expect(() => createCharacterButtonAction({ id: "click", userId: "user", projectId: "project", unit, dirty: false, ...patch })).toThrow();
    }
    const prompt = characterButtonPrompt(action);
    for (const required of ["project_get_script", "project_get_context", "project_extract_asset_candidates", "原文未设定", "voiceTimbre", "不是后端幂等保证", "不生成或上传图片", "不要重复创建"]) expect(prompt).toContain(required);
    expect(prompt).not.toContain("project_create_asset_candidates");
});

test("scope and remote guards reject user/project/chapter/version/draft/archived changes", () => {
    const { action, snapshot, detail, unit } = fixture();
    expect(() => assertCharacterButtonScope(action, "user", snapshot)).not.toThrow();
    expect(() => assertCharacterButtonScope(action, "other", snapshot)).toThrow();
    for (const patch of [{ projectId: "else" }, { domainProjectId: "else" }, { contentUnitId: "else" }, { contentUnitRevision: 3 }, { contextKind: "canvas" as const }, { blockers: ["未保存"] }]) expect(() => assertCharacterButtonScope(action, "user", { ...snapshot, ...patch })).toThrow();
    expect(() => assertCharacterButtonSource(action, detail, unit)).not.toThrow();
    for (const patch of [{ id: "other" }, { userId: "other" }, { status: "archived" }]) expect(() => assertCharacterButtonSource(action, { ...detail, project: { ...detail.project, ...patch } }, unit)).toThrow();
    for (const patch of [{ sourceText: "new" }, { revision: 3 }, { id: "other" }, { projectId: "other" }]) expect(() => assertCharacterButtonSource(action, detail, { ...unit, ...patch })).toThrow();
});

test("single claim preserves chat draft and attachments across duplicate clicks and remount", () => {
    const { action } = fixture();
    useCanvasAgentStore.setState({ prompt: "keep my draft", attachments: [{ id: "draft", name: "image", url: "blob:original", dataUrl: "data:image/png;base64,eA==", type: "image/png", size: 1 }] });
    queueCharacterButtonAction(action);
    expect(() => queueCharacterButtonAction({ ...action, id: "double" })).toThrow();
    expect(claimCharacterButtonAction("wrong")).toBe(false);
    expect(claimCharacterButtonAction(action.id)).toBe(true);
    expect(claimCharacterButtonAction(action.id)).toBe(false);
    expect(useCanvasAgentStore.getState().prompt).toBe("keep my draft");
    expect(useCanvasAgentStore.getState().attachments[0].url).toBe("blob:original");
    patchCharacterButtonAction(action.id, { status: "needs_review" });
    expect(claimCharacterButtonAction(action.id)).toBe(false);
    expect(() => queueStoryboardButtonAction({ id: "story" } as StoryboardButtonAction)).toThrow();
    expect(patchCharacterButtonAction("old", { status: "verified" })).toBe(false);
});

test("slow preflight and disabled Codex cannot dispatch later, but old result readback remains allowed", () => {
    const { action, snapshot } = fixture();
    expect(() => assertCharacterButtonDispatch(action, "user", snapshot, true, action.createdAt + 44_999)).not.toThrow();
    expect(() => assertCharacterButtonDispatch(action, "user", snapshot, true, action.createdAt + 45_000)).toThrow("等待到期");
    expect(() => assertCharacterButtonDispatch(action, "user", snapshot, false)).toThrow();
    expect(() => assertCharacterButtonScope({ ...action, createdAt: 1 }, "user", snapshot)).not.toThrow();
});

test("busy, approvals, storyboard work and uncertain results cannot enqueue or replay", () => {
    const { action } = fixture();
    for (const patch of [{ sending: true }, { waiting: true }, { pendingTool: { requestId: "approval", name: "write" } }, { storyboardAction: { status: "running" } as StoryboardButtonAction }, { characterAction: { ...action, status: "needs_review" as const } }]) {
        useCanvasAgentStore.setState({ ...initial, ...patch });
        expect(() => queueCharacterButtonAction(action)).toThrow();
    }
    useCanvasAgentStore.setState({ ...initial, characterAction: { ...action, status: "not_sent" } });
    expect(() => queueCharacterButtonAction(action)).not.toThrow();
});

test("only a settled original turn plus persisted source-tagged complete cards passes readback", () => {
    const { action, session, saved, unit, detail } = fixture();
    expect(verifyCharacterButtonResult(action, session, saved, unit)).toEqual({ status: "verified", count: 1 });
    expect(() => verifyCharacterButtonResult(action, session, detail, unit)).toThrow("未读到");
    for (const patch of [{ id: "other" }, { domainProjectId: "other" }, { contentUnitId: "other" }, { canvasId: "canvas" }, { execution: undefined }, { execution: { ...session.execution!, activeTurnId: "running" } }, { latestTurnReceipt: { ...session.latestTurnReceipt!, turnId: "other" } }]) expect(() => verifyCharacterButtonResult(action, { ...session, ...patch }, saved, unit)).toThrow();
    expect(() => verifyCharacterButtonResult({ ...action, beforeCandidates: undefined }, session, saved, unit)).toThrow("基线");
});

test("wrong source tags, partial cards, duplicate names and changed prior roles do not pass", () => {
    const { action, session, saved, unit, candidate, fields } = fixture();
    for (const patch of [{ extractionRequestId: "other" }, { sourceRevision: 3 }, { voiceTimbre: " " }, { physique: "" }]) expect(() => verifyCharacterButtonResult(action, session, { ...saved, assetCandidates: [{ ...candidate, detailsJson: JSON.stringify({ ...fields, ...patch }) }] }, unit)).toThrow();
    for (const patch of [{ projectId: "other" }, { unitId: "other" }, { status: "confirmed" }, { detailsJson: "null" }]) expect(() => verifyCharacterButtonResult(action, session, { ...saved, assetCandidates: [{ ...candidate, ...patch }] }, unit)).toThrow();
    expect(() => verifyCharacterButtonResult(action, session, { ...saved, assetCandidates: [candidate, { ...candidate, id: "duplicate" }] }, unit)).toThrow();
    expect(() => verifyCharacterButtonResult({ ...action, beforeCandidates: [{ ...candidate, id: "old" }] }, session, saved, unit)).toThrow("已有");
});

test("no write evidence releases no-change, uncertain writes never get a retry", () => {
    const { action, session, detail, unit } = fixture();
    const noWrite = { ...session, latestTurnReceipt: { ...session.latestTurnReceipt!, writeAttempted: false } };
    expect(verifyCharacterButtonResult(action, noWrite, detail, unit)).toEqual({ status: "no_change", count: 0 });
    expect(() => verifyCharacterButtonResult(action, session, detail, unit)).toThrow();
});

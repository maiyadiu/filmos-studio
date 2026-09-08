import { afterEach, expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "../src/types/canvas";
import { assertStoryboardButtonScope, assertStoryboardButtonUnchanged, createStoryboardButtonAction, storyboardButtonPrompt, verifyStoryboardButtonResult, verifyStoryboardButtonNoChange } from "../src/film/agent/storyboard-button-action";
import type { BrainSessionView } from "../src/film/agent/agent-client";
import { claimStoryboardButtonAction, patchStoryboardButtonAction, queueStoryboardButtonAction, useCanvasAgentStore } from "../src/stores/canvas/use-canvas-agent-store";
import { upsertProjectChapterStoryboard } from "../src/lib/canvas/project-chapter-storyboard";
import type { ProjectShotContext, ProjectShotBatchReceipt } from "../src/services/api/projects";

const initialAgent = useCanvasAgentStore.getState();
afterEach(() => useCanvasAgentStore.setState(initialAgent));
function fixture(bound = false) {
    const node = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }); node.id = "original";
    node.metadata = { ...node.metadata, composerContent: "镜头按完整剧情决定", ...(bound ? { chapterId: "chapter" } : {}), storyboard: { rows: [], visibleColumns: ["plotDescription"], referenceNodeIds: [] } };
    const text = createCanvasNode(CanvasNodeType.Text, { x: -400, y: 0 }); text.id = "script";
    const canvas = { id: "canvas", projectId: "project", nodes: [node, text], connections: [{ id: "keep", fromNodeId: "script", toNodeId: "original" }] };
    const action = createStoryboardButtonAction({ id: "one-request", userId: "user", canvas, nodeId: node.id, prompt: "镜头按完整剧情决定" });
    const saved = structuredClone(canvas);
    saved.nodes[0].metadata!.storyboard!.rows = [createStoryboardRow(1, { id: "shot", durationSeconds: 5, plotDescription: "她在桌边停下，抬头回应。", dialogue: "林夏：我陪你。" })];
    return { canvas, action, saved };
}

test("request binds an immutable original target and doesn't invent a chapter", () => {
    const { action, canvas } = fixture();
    canvas.nodes[0].metadata!.composerContent = "later edit";
    expect(action.before.nodes[0].metadata!.composerContent).not.toBe("later edit");
    expect(storyboardButtonPrompt(action)).toContain('"nodeId":"original"');
    expect(storyboardButtonPrompt(action)).toContain("shots-one-request");
    expect(storyboardButtonPrompt(action)).toContain("不猜测章节ID");
    expect(storyboardButtonPrompt(action)).toContain("镜数：auto");
    expect(storyboardButtonPrompt(fixture(true).action)).toContain("project_create_or_update_shots");
});

test("different user, canvas, project, chapter, deleted or duplicate target fail closed", () => {
    const { action, canvas } = fixture(true);
    expect(() => assertStoryboardButtonScope(action, "other", canvas)).toThrow();
    for (const patch of [{ id: "else" }, { projectId: "else" }, { nodes: [] }, { nodes: canvas.nodes.map(n => ({ ...n, metadata: { ...n.metadata, chapterId: "else" } })) }]) expect(() => assertStoryboardButtonScope(action, "user", { ...canvas, ...patch })).toThrow();
    expect(() => createStoryboardButtonAction({ id: "x", userId: "user", canvas: { ...canvas, nodes: [...canvas.nodes, { ...canvas.nodes[0], id: "duplicate" }] }, nodeId: "original", prompt: "test" })).toThrow("不唯一");
});

test("preflight guards unsaved rows, changed composer and original links", () => {
    const { action, canvas, saved } = fixture();
    expect(() => assertStoryboardButtonUnchanged(action, "user", saved)).toThrow("改变");
    expect(() => assertStoryboardButtonUnchanged(action, "user", { ...canvas, connections: [] })).toThrow();
    const edited = structuredClone(canvas); edited.nodes[0].metadata!.composerContent = "later";
    expect(() => assertStoryboardButtonUnchanged(action, "user", edited)).toThrow();
    expect(() => assertStoryboardButtonUnchanged(action, "user", canvas)).not.toThrow();
});

test("source edits and new source nodes during preparation block dispatch", () => {
    const { action, canvas } = fixture();
    const changed = structuredClone(canvas); changed.nodes[1].metadata = { ...changed.nodes[1].metadata, composerContent: "来源正文已修订" };
    expect(() => assertStoryboardButtonUnchanged(action, "user", changed)).toThrow("来源节点");
    expect(() => assertStoryboardButtonUnchanged(action, "user", { ...canvas, nodes: [...canvas.nodes, { ...canvas.nodes[1], id: "new-source" }] })).toThrow("来源节点");
    const config = structuredClone(canvas); config.nodes[0].metadata!.storyboardShotCount = "3";
    expect(() => assertStoryboardButtonUnchanged(action, "user", config)).toThrow("改变");
});

test("only empty unconnected placeholders may be replaced; other directing fields are real work", () => {
    const { action, saved } = fixture();
    const placeholder = createStoryboardRow(1, { id: "placeholder" });
    action.before.nodes[0].metadata!.storyboard!.rows = [placeholder];
    expect(() => verifyStoryboardButtonResult(action, "user", saved, saved)).not.toThrow();
    for (const patch of [{ narrativeIntent: "迟疑" }, { audioEffects: "玻璃震响" }, { mustHave: ["信封"] }, { promptDrafts: { image: { revision: 1, contentHash: "hash", dependencyHash: "source" } } }]) {
        action.before.nodes[0].metadata!.storyboard!.rows = [{ ...placeholder, ...patch }];
        expect(() => verifyStoryboardButtonResult(action, "user", saved, saved)).toThrow("原有镜头");
    }
    action.before.nodes[0].metadata!.storyboard!.rows = [placeholder];
    action.before.connections.push({ id: "downstream", fromNodeId: "original", toNodeId: "script", fromHandleId: "row:placeholder" });
    expect(() => verifyStoryboardButtonResult(action, "user", saved, saved)).toThrow("原有镜头");
});

test("double click and StrictMode second claim cannot create a second turn intent", () => {
    const { action } = fixture();
    useCanvasAgentStore.setState({ prompt: "unrelated draft", attachments: [{ id: "image", url: "blob:fixture", dataUrl: "data:image/png;base64,eA==", type: "image/png", name: "draft", size: 1 }] });
    queueStoryboardButtonAction(action);
    expect(() => queueStoryboardButtonAction({ ...action, id: "duplicate" })).toThrow();
    expect(claimStoryboardButtonAction(action.id)).toBe(true);
    expect(claimStoryboardButtonAction(action.id)).toBe(false);
    expect(useCanvasAgentStore.getState().prompt).toBe("unrelated draft");
    expect(useCanvasAgentStore.getState().attachments).toHaveLength(1);
    patchStoryboardButtonAction(action.id, { status: "running", sessionId: "original-session" });
    expect(claimStoryboardButtonAction(action.id)).toBe(false); // receiver remount
    expect(patchStoryboardButtonAction("stale-action", { status: "verified" })).toBe(false);
});

test("active or uncertain work prevents another action, not_sent permits a new explicit click", () => {
    const { action } = fixture();
    for (const state of [{ sending: true }, { waiting: true }, { storyboardAction: { ...action, status: "needs_review" as const } }]) {
        useCanvasAgentStore.setState({ ...initialAgent, ...state });
        expect(() => queueStoryboardButtonAction(action)).toThrow();
    }
    useCanvasAgentStore.setState({ ...initialAgent, storyboardAction: { ...action, status: "not_sent" } });
    expect(() => queueStoryboardButtonAction(action)).not.toThrow();
});

test("unchanged data and text-only completion cannot pass; saved original rows can", () => {
    const { action, canvas, saved } = fixture();
    expect(() => verifyStoryboardButtonResult(action, "user", canvas, canvas)).toThrow("正文");
    expect(verifyStoryboardButtonResult(action, "user", saved, saved)).toEqual({ rowCount: 1, durationSeconds: 5 });
    const done = { ...action, before: saved };
    expect(() => verifyStoryboardButtonResult(done, "user", saved, saved)).toThrow("尚无变更");
});

test("missing, duplicated, blank or invalid rows cannot pass readback", () => {
    const { action, saved } = fixture();
    for (const patch of [{ durationSeconds: 0 }, { durationSeconds: Number.NaN }, { id: "" }, { plotDescription: "", videoMotionPrompt: "" }]) {
        const bad = structuredClone(saved); Object.assign(bad.nodes[0].metadata!.storyboard!.rows[0], patch);
        expect(() => verifyStoryboardButtonResult(action, "user", bad, bad)).toThrow();
    }
    const duplicate = structuredClone(saved); duplicate.nodes[0].metadata!.storyboard!.rows.push(duplicate.nodes[0].metadata!.storyboard!.rows[0]);
    expect(() => verifyStoryboardButtonResult(action, "user", duplicate, duplicate)).toThrow();
});

test("wrong node, lost link, other-node mutation, lost row and local mismatch cannot pass", () => {
    const { action, canvas, saved } = fixture();
    expect(() => verifyStoryboardButtonResult(action, "user", canvas, saved)).toThrow("不一致");
    const lost = { ...saved, connections: [] };
    expect(() => verifyStoryboardButtonResult(action, "user", lost, lost)).toThrow("连接");
    const extra = { ...saved, connections: [...saved.connections, { id: "unexpected", fromNodeId: "original", toNodeId: "script" }] };
    expect(() => verifyStoryboardButtonResult(action, "user", extra, extra)).toThrow("连接");
    const changed = structuredClone(saved); changed.nodes[1].title = "wrong write";
    expect(() => verifyStoryboardButtonResult(action, "user", changed, changed)).toThrow("目标以外");
    const other = structuredClone(saved); other.nodes[0].id = "replacement";
    expect(() => verifyStoryboardButtonResult(action, "user", other, other)).toThrow("目标");
    const existing = { ...action, before: structuredClone(saved) }; existing.before.nodes[0].metadata!.storyboard!.rows[0].id = "old-row";
    expect(() => verifyStoryboardButtonResult(existing, "user", saved, saved)).toThrow("原有镜头");
});

test("business readback requires exact original request, full coverage and current projection", () => {
    const { action, canvas } = fixture(true);
    const shots = [{ id: "s1", projectId: "project", unitId: "chapter", title: "回应", description: "桌边回应", position: 0, durationMs: 5000, status: "draft", revision: 1, sourceRevision: 2, sourceHash: "hash", createdAt: "now", updatedAt: "now", content: { sourceReferences: [], scene: "书店", characters: [], dialogue: [], action: "停步", camera: "中景" } }];
    const context = { unit: { id: "chapter", projectId: "project", title: "一章", revision: 2, shotRevision: 1 }, sourceHash: "hash", shots, staleShotIds: [], paragraphs: [], coverage: { coveredParagraphIds: [], missingParagraphIds: [], dialogueMatches: true, chapterComplete: true } } as unknown as ProjectShotContext;
    const receipt = { requestId: "shots-one-request", projectId: "project", unitId: "chapter", shots, shotRevision: 1, sourceRevision: 2, sourceHash: "hash" } as ProjectShotBatchReceipt;
    const projection = upsertProjectChapterStoryboard(canvas.nodes, canvas.connections, { unit: context.unit, shots });
    const saved = { ...canvas, nodes: projection.nodes, connections: projection.connections };
    expect(verifyStoryboardButtonResult(action, "user", saved, saved, { context, receipt }).rowCount).toBe(1);
    expect(() => verifyStoryboardButtonResult(action, "user", saved, saved)).toThrow("缺少");
    expect(() => verifyStoryboardButtonResult(action, "user", saved, saved, { context, receipt: { ...receipt, requestId: "another" } })).toThrow("原请求");
    expect(() => verifyStoryboardButtonResult(action, "user", saved, saved, { context: { ...context, coverage: { ...context.coverage, chapterComplete: false } }, receipt })).toThrow("完整覆盖");
});

test("a settled original turn with no write attempt can release an unchanged button without claiming success", () => {
    const { action, canvas, saved } = fixture();
    action.sessionId = "original-session";
    const session = { id: action.sessionId, brainProfileId: "codex.subscription", execution: { activeTurnId: null, resuming: false, pendingConfirmations: [] }, latestTurnReceipt: { turnId: `storyboard-${action.id}`, status: "failed", writeAttempted: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } } as BrainSessionView;
    for (const status of ["completed", "failed", "cancelled"] as const) {
        expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, { ...session, latestTurnReceipt: { ...session.latestTurnReceipt!, status } })).not.toThrow();
    }
    for (const patch of [{ turnId: "other-turn" }, { status: "running" as const }, { status: "waiting_host" as const }, { writeAttempted: true }, { finishedAt: undefined }]) {
        expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, { ...session, latestTurnReceipt: { ...session.latestTurnReceipt!, ...patch } })).toThrow();
    }
    for (const patch of [{ id: "other-session" }, { latestTurnReceipt: undefined }, { execution: undefined }, { execution: { ...session.execution!, activeTurnId: "new-turn" } }, { execution: { ...session.execution!, resuming: true } }]) {
        expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, { ...session, ...patch })).toThrow();
    }
    expect(() => verifyStoryboardButtonNoChange(action, "other", canvas, canvas, session)).toThrow();
    expect(() => verifyStoryboardButtonNoChange(action, "user", saved, saved, session)).toThrow();
    useCanvasAgentStore.setState({ ...initialAgent, storyboardAction: { ...action, status: "no_change" } });
    expect(() => queueStoryboardButtonAction({ ...action, id: "explicit-new-click" })).not.toThrow();
});

test("no-change for a bound chapter also requires an unchanged business baseline and definite missing original receipt", () => {
    const { action, canvas } = fixture(true);
    action.sessionId = "original-session";
    const context = { unit: { id: "chapter", projectId: "project", revision: 2, shotRevision: 0 }, sourceHash: "hash", shots: [] } as unknown as ProjectShotContext;
    const session = { id: action.sessionId, brainProfileId: "codex.subscription", execution: { activeTurnId: null, resuming: false, pendingConfirmations: [] }, latestTurnReceipt: { turnId: `storyboard-${action.id}`, status: "cancelled", writeAttempted: false, finishedAt: new Date().toISOString() } } as BrainSessionView;
    const business = { context, receiptMissing: true };
    expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, session, business)).toThrow("业务分镜");
    action.beforeBusiness = structuredClone(context);
    expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, session, business)).not.toThrow();
    expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, session, { ...business, receiptMissing: false })).toThrow();
    for (const patch of [{ sourceHash: "changed" }, { unit: { ...context.unit, revision: 3 } }, { unit: { ...context.unit, shotRevision: 1 } }, { shots: [{ id: "partially-saved" }] as ProjectShotContext["shots"] }]) {
        expect(() => verifyStoryboardButtonNoChange(action, "user", canvas, canvas, session, { ...business, context: { ...context, ...patch } })).toThrow();
    }
});

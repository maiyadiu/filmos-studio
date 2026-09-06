import { expect, test } from "bun:test";
import { agentCreativeResult, creativeToolTargetSummary } from "../src/lib/canvas/agent-creative-results";
import type { CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";
import { CanvasNodeType } from "../src/types/canvas";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { SHOT_IMAGE_SCHEMA, type ShotImageEvidence } from "../../packages/filmos-agent-contracts/src/shot-image";

function scope(): CanvasAgentSnapshot {
    const node = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 });
    const row = createStoryboardRow(1);
    node.id = "n"; node.title = "渡口留灯"; row.id = "project-shot:s";
    node.metadata = { ...node.metadata, chapterId: "u", storyboard: { ...node.metadata!.storyboard!, rows: [row] } };
    return { projectId: "c", domainProjectId: "p", contentUnitId: "u", title: "当前画布", selectedNodeIds: [], connections: [], viewport: { x: 0, y: 0, k: 1 },
        nodes: [node] };
}
const item = (name: string, result: unknown) => ({ role: "tool", detail: { name, result } });
function prompt() {
    const context = { canvasId: "c", projectId: "p", nodeId: "n", rowId: "project-shot:s", kind: "image", state: { revision: 2 },
        dependencies: { project: { id: "p" }, source: { unitId: "u" }, shot: { id: "s", projectId: "p", unitId: "u", position: 0 } } };
    return { ok: true, data: { context, verification: { ok: true, persisted: true } } };
}

function imageReading(): ShotImageEvidence {
    return { schema: SHOT_IMAGE_SCHEMA, capturedAt: "2026-09-06T09:00:00Z", expiresAt: "2026-09-06T09:05:00Z", bytesBase64: "never-copy-to-action",
        binding: { projectId: "p", canvasId: "c", nodeId: "n", rowId: "project-shot:s", shotId: "s", shotRevision: 1, sourceUnitId: "u", sourceRevision: 1,
            sourceHash: "a".repeat(64), imageNodeId: "old-image", resourceId: "old-resource", resourceUpdatedAt: "2026-09-06T08:00:00Z", resourceETag: "etag", canvasContentHash: "b".repeat(64), dependencyHash: "c".repeat(64) },
        image: { mimeType: "image/png", sha256: "d".repeat(64), byteLength: 12, width: 64, height: 48 },
        constraints: { scriptText: "<p>原稿</p>", project: { id: "p" }, shot: { id: "s", projectId: "p", unitId: "u", position: 0, revision: 1, sourceRevision: 1, sourceHash: "a".repeat(64) }, direction: {}, assets: [] } };
}

test("image result reopens pinned historical reading, not current replacement or expired live evidence", () => {
    const evidence = imageReading(), s = scope();
    s.nodes[0].metadata!.storyboard!.rows[0].imageNodeId = "new-image";
    const result = agentCreativeResult(item("project_read_shot_image", evidence), s);
    expect(result).toMatchObject({ kind: "shot-image", shotNumber: 1, evidence: { binding: { imageNodeId: "old-image", resourceId: "old-resource" } } });
    expect(JSON.stringify(result)).not.toContain("never-copy-to-action");
    const native = { content: [{ type: "text", text: JSON.stringify(evidence) }, { type: "image", mimeType: "image/png", pixelsOmittedFromHistory: true }] };
    expect(agentCreativeResult(item("project_read_shot_image", native), s)).toEqual(result);
    expect(agentCreativeResult(item("project_get_prompt", native), s)).toBeNull();
});

test("image feedback cannot turn malformed, cross-project or inconsistent identities into an action", () => {
    const mutations = [
        (e: ShotImageEvidence) => { e.binding.projectId = "foreign"; }, (e: ShotImageEvidence) => { e.binding.canvasId = "foreign"; },
        (e: ShotImageEvidence) => { e.binding.sourceUnitId = "foreign"; }, (e: ShotImageEvidence) => { e.binding.rowId = "project-shot:other"; },
        (e: ShotImageEvidence) => { e.image.sha256 = "path.png"; }, (e: ShotImageEvidence) => { e.image.mimeType = "image/svg+xml" as "image/png"; },
        (e: ShotImageEvidence) => { e.image.width = 99999; }, (e: ShotImageEvidence) => { e.constraints.shot.sourceHash = "d".repeat(64); },
        (e: ShotImageEvidence) => { e.expiresAt = "invalid"; }, (e: ShotImageEvidence) => { e.constraints.shot.position = -1; },
    ];
    for (const mutate of mutations) { const e = imageReading(); mutate(e); expect(agentCreativeResult(item("project_read_shot_image", e), scope())).toBeNull(); }
    expect(agentCreativeResult({ role: "assistant", detail: { name: "project_read_shot_image", result: imageReading() } }, scope())).toBeNull();
});

test("verified script output opens exact historical revision and native MCP history uses the same path", () => {
    const output = { ok: true, data: { after: { projectId: "p", unitId: "u", revision: 2 }, verification: { ok: true, persisted: true } } };
    const result = { kind: "script", projectId: "p", unitId: "u", revision: 2 };
    expect(agentCreativeResult(item("project_revise_script", output), scope())).toEqual(result);
    expect(agentCreativeResult({ role: "tool", detail: { type: "mcpToolCall", tool: "project_revise_script", status: "completed", result: { content: [{ type: "text", text: JSON.stringify(output) }] } } }, scope())).toEqual(result);
    expect(agentCreativeResult(item("project_get_script_revision", { revision: output.data.after }), scope())).toEqual(result);
    expect(agentCreativeResult(item("project_get_script", { unit: { id: "u", projectId: "p", revision: 1 } }), scope())).toMatchObject({ revision: 1 });
    output.data.verification.persisted = false;
    expect(agentCreativeResult(item("project_revise_script", output), scope())).toBeNull();
});

test("assistant claims, pending, errors, unknown tools and malformed envelopes cannot produce result actions", () => {
    const good = item("project_save_prompt", prompt());
    expect(agentCreativeResult({ ...good, role: "assistant" }, scope())).toBeNull();
    for (const detail of [{ ...good.detail, status: "pending" }, { ...good.detail, status: "failed" }, { ...good.detail, error: { message: "failed" } },
        { ...good.detail, name: "arbitrary", url: "https://example.com" }, { name: "project_save_prompt", input: prompt() },
        { ...good.detail, result: { isError: true, content: [] } }, { ...good.detail, result: { content: [{ type: "text", text: "{broken" }] } },
        { ...good.detail, result: { content: [{ type: "text", text: JSON.stringify(prompt()) }, { type: "text", text: "extra" }] } }]) {
        expect(agentCreativeResult({ role: "tool", detail }, scope())).toBeNull();
    }
    const failed = prompt(); failed.ok = false;
    expect(agentCreativeResult(item("project_save_prompt", failed), scope())).toBeNull();
});

test("prompt result targets existing unique row, exact source scope and receipt version", () => {
    const p = prompt();
    expect(agentCreativeResult(item("project_save_prompt", p), scope())).toEqual({ kind: "prompt", projectId: "p", canvasId: "c", nodeId: "n", rowId: "project-shot:s", promptKind: "image", revision: 2, shotNumber: 1 });
    expect(agentCreativeResult(item("project_get_prompt", p.data.context), scope())).toMatchObject({ revision: 2 });
    const historical = { ...p.data.context, revision: 1, kind: "video" };
    expect(agentCreativeResult(item("project_get_prompt_revision", { revision: historical }), scope())).toMatchObject({ revision: 1, promptKind: "video" });
    expect(agentCreativeResult(item("project_get_prompt_request", { receipt: { snapshot: historical } }), scope())).toMatchObject({ revision: 1 });
    for (const mutate of [
        (s: CanvasAgentSnapshot) => { s.domainProjectId = "other"; }, (s: CanvasAgentSnapshot) => { s.projectId = "other"; },
        (s: CanvasAgentSnapshot) => { s.contentUnitId = "other"; }, (s: CanvasAgentSnapshot) => { s.nodes = []; },
        (s: CanvasAgentSnapshot) => { s.nodes.push(structuredClone(s.nodes[0])); }, (s: CanvasAgentSnapshot) => { s.nodes[0].metadata!.chapterId = "other"; },
        (s: CanvasAgentSnapshot) => { s.nodes[0].metadata!.storyboard!.rows.push(structuredClone(s.nodes[0].metadata!.storyboard!.rows[0])); },
    ]) { const s = scope(); mutate(s); expect(agentCreativeResult(item("project_save_prompt", p), s)).toBeNull(); }
    for (const key of ["canvasId", "nodeId", "rowId", "kind"]) {
        const bad = structuredClone(p); Object.assign(bad.data.context, { [key]: "other" });
        expect(agentCreativeResult(item("project_save_prompt", bad), scope())).toBeNull();
    }
    for (const value of [0, -1, 1.5, NaN]) { const bad = prompt(); bad.data.context.state.revision = value; expect(agentCreativeResult(item("project_save_prompt", bad), scope())).toBeNull(); }
});

test("old shot receipts reopen current business view without claiming the batch is still current", () => {
    const receipt = { projectId: "p", unitId: "u" };
    const expected = { kind: "shots", projectId: "p", unitId: "u" };
    expect(agentCreativeResult(item("project_create_or_update_shots", { ok: true, data: { receipt, verification: { persisted: true, matchesCurrent: false } } }), scope())).toEqual(expected);
    expect(agentCreativeResult(item("project_get_shot_batch", { receipt, historicalReceipt: true }), scope())).toEqual(expected);
    expect(agentCreativeResult(item("project_get_shots", { unit: { projectId: "p", id: "u" } }), scope())).toEqual(expected);
    const sync = { ok: true, data: { location: { ...receipt, canvasId: "c" }, verification: { ok: true, persisted: true } } };
    expect(agentCreativeResult(item("project_sync_storyboard", sync), scope())).toEqual(expected);
    sync.data.location.canvasId = "other";
    expect(agentCreativeResult(item("project_sync_storyboard", sync), scope())).toBeNull();
});

test("confirmation summary names targets and counts without copying script/prompt text", () => {
    const s = scope();
    expect(creativeToolTargetSummary("project_revise_script", { unitId: "u", expectedRevision: 2, edits: [{ oldText: "private", newText: "private" }] }, s)).toBe("目标：渡口留灯 · 正文 v2；1 处精确修订，原版本保留。");
    expect(creativeToolTargetSummary("project_create_or_update_shots", { unitId: "u", expectedShotRevision: 1, shots: [{ id: "s" }, {}] }, s)).toContain("新增 1 镜，修订 1 镜");
    expect(creativeToolTargetSummary("project_sync_storyboard", { unitId: "u", expectedShotRevision: 2 }, s)).toContain("当前画布「当前画布」");
    expect(creativeToolTargetSummary("project_save_prompt", { nodeId: "n", rowId: "project-shot:s", kind: "video", expectedRevision: 1, prompt: "private" }, s)).toBe("目标：渡口留灯 · 镜头 1 · 视频提示词；基于 v1 保存新版本。仅保存草稿，不生成媒体。");
    expect(creativeToolTargetSummary("project_revise_script", { projectId: "other", unitId: "u" }, s)).toBeNull();
});

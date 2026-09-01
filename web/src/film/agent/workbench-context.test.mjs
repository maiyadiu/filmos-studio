import { describe, expect, test } from "bun:test";

import { applyWorkbenchContext, buildLiveWorkbenchContextDraft, buildWorkbenchContext } from "./workbench-context.ts";

describe("workbench context bridge", () => {
    test("projects explicit IDs, selection, visible nodes and asset versions", () => {
        const nodes = [
            node("node-1", 10, 20, { contentUnitId: "unit-1", contentUnitKind: "episode", sceneId: "scene-1", directorUnitId: "director-1", shotId: "shot-1", assetVersionId: "asset-version-1" }),
            node("node-2", 2500, 20, { sceneId: "scene-2" }),
        ];
        const context = buildWorkbenchContext({ projectId: "canvas-1", domainProjectId: "project-1", title: "EP17", nodes, selectedNodeIds: new Set(["node-1"]), viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 }, canvasRevision: 9, filmExpectedVersion: 4 });

        expect(context).toMatchObject({ projectId: "canvas-1", domainProjectId: "project-1", contentUnitId: "unit-1", contentUnitKind: "episode", sceneId: "scene-1", directorUnitId: "director-1", shotId: "shot-1", visibleNodeIds: ["node-1"], assetVersionIds: ["asset-version-1"], canvasRevision: 9, filmExpectedVersion: 4 });
        expect(applyWorkbenchContext({ projectId: "canvas-1", domainProjectId: "project-1", title: "EP17", nodes, connections: [], selectedNodeIds: ["node-1"], viewport: { x: 0, y: 0, k: 1 } }, context).sceneId).toBe("scene-1");
    });

    test("keeps an unlinked Host canvas explicit without inventing a Film project", () => {
        const context = buildWorkbenchContext({ projectId: "canvas-1", title: "未关联", nodes: [], selectedNodeIds: new Set(), viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 } });
        expect(context?.projectId).toBe("canvas-1");
        expect(context?.domainProjectId).toBeUndefined();
    });

    test("ambiguous selected entity IDs are omitted instead of guessed", () => {
        const context = buildWorkbenchContext({ projectId: "canvas-1", domainProjectId: "project-1", title: "冲突", nodes: [node("a", 0, 0, { sceneId: "scene-a" }), node("b", 100, 0, { sceneId: "scene-b" })], selectedNodeIds: new Set(["a", "b"]), viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 } });
        expect(context?.sceneId).toBeUndefined();
    });

    test("publishes a deterministic full live context draft for the exact Domain Project", async () => {
        const context = buildWorkbenchContext({ projectId: "canvas-1", domainProjectId: "project-1", title: "EP17", nodes: [node("node-1", 10, 20, { chapterId: "unit-1", status: "draft" })], selectedNodeIds: new Set(["node-1"]), viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 } });
        const first = await buildLiveWorkbenchContextDraft(context);
        const second = await buildLiveWorkbenchContextDraft(context);

        expect(first).toEqual(second);
        expect(first).toMatchObject({ project_id: "project-1", content_unit_id: "unit-1", content_unit_kind: "chapter", canvas_id: "canvas-1", selected_node_ids: ["node-1"], film_expected_version: null, film_content_hash: null });
        expect(first.visible_node_summaries).toEqual([{ id: "node-1", type: "text", title: "node-1", status: "draft" }]);
        expect(first.canvas_state_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(first.context_receipt_id).toBe(`workbench:${first.canvas_state_hash}`);
    });
});

function node(id, x, y, metadata) {
    return { id, type: "text", title: id, position: { x, y }, width: 320, height: 180, metadata };
}

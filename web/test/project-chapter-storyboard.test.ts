import { expect, test } from "bun:test";
import { mergeProjectStoryboardReadback, upsertProjectChapterStoryboard } from "../src/lib/canvas/project-chapter-storyboard";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasConnection } from "../src/types/canvas";
import type { ProjectShot } from "../src/services/api/projects";

const unit = { id: "u", title: "雨夜" };
function shot(id = "s1", position = 0): ProjectShot {
    return { id, projectId: "p", unitId: "u", title: "回应", description: "人物隔桌回应", position, durationMs: 43500, status: "draft", revision: 1, sourceRevision: 2, sourceHash: "hash", createdAt: "now", updatedAt: "now", content: { sourceReferences: [{ paragraphId: "p1", quote: "林夏：我陪你。" }], scene: "书店", characters: ["林夏"], dialogue: [{ paragraphId: "p1", speaker: "林夏", text: "我陪你。" }], action: "手停在账本旁", camera: "固定双人中景" } };
}

test("maps ordered business fields and provenance without a second node on repeat", () => {
    const shots = [shot("s2", 1), shot(), { ...shot("other"), unitId: "elsewhere" }];
    const first = upsertProjectChapterStoryboard([], [], { unit, shots });
    const second = upsertProjectChapterStoryboard(first.nodes, first.connections, { unit, shots });
    expect(second.nodes).toEqual(first.nodes);
    expect(second.rowCount).toBe(2);
    expect(second.nodes[0].metadata?.storyboard?.rows[0]).toMatchObject({ id: "project-shot:s1", shotNumber: 1, durationSeconds: 43.5, dialogue: "林夏：我陪你。", performanceBlocking: "手停在账本旁", camera: "固定双人中景", characters: [{ characterName: "林夏" }], projectShotSource: { id: "s1", revision: 1, sourceRevision: 2, sourceHash: "hash" } });
});

test("first business generation replaces only untouched defaults in the original bound node", () => {
    const original = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { chapterId: unit.id });
    const before = structuredClone(original);
    const result = upsertProjectChapterStoryboard([original], [], { unit, shots: [shot()] });
    expect(result.scriptNodeId).toBe(original.id);
    expect(result.rowCount).toBe(1);
    expect(original).toEqual(before);
    for (const patch of [{ durationSeconds: 9 }, { narrativeIntent: "威胁逼近" }, { errorDetails: "旧生成失败" }]) {
        const work = structuredClone(original); Object.assign(work.metadata!.storyboard!.rows[0], patch);
        expect(() => upsertProjectChapterStoryboard([work], [], { unit, shots: [shot()] })).toThrow("避免覆盖手工镜头");
    }
    const rowId = original.metadata!.storyboard!.rows[0].id;
    const links = [{ id: "keep", fromNodeId: original.id, fromHandleId: `row:${rowId}`, toNodeId: "image" }];
    expect(() => upsertProjectChapterStoryboard([original], links, { unit, shots: [shot()] })).toThrow("避免覆盖手工镜头");
});

test("one updated business shot preserves prompts, assets, other rows and valid connections", () => {
    const shots = [shot(), shot("s2", 1)];
    const original = upsertProjectChapterStoryboard([], [], { unit, shots });
    const rows = original.nodes[0].metadata!.storyboard!.rows;
    rows[0].imageGenerationPrompt = "用户手写图像提示词";
    rows[0].videoMotionPrompt = "用户手写视频提示词";
    rows[0].imageNodeId = "image";
    rows[0].characters[0].characterAssetId = "asset";
    const image = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 });
    const links: CanvasConnection[] = [{ id: "keep", fromNodeId: original.scriptNodeId, fromHandleId: "row:project-shot:s1", toNodeId: image.id }];
    shots[0].revision = 2;
    shots[0].content.camera = "固定近景";
    const result = upsertProjectChapterStoryboard([...original.nodes, image], links, { unit, shots });
    const next = result.nodes[0].metadata!.storyboard!.rows;
    expect(next[0]).toMatchObject({ camera: "固定近景", imageGenerationPrompt: "用户手写图像提示词", videoMotionPrompt: "用户手写视频提示词", imageNodeId: "image", characters: [{ characterName: "林夏", characterAssetId: "asset" }], projectShotSource: { revision: 2 } });
    expect(next[1]).toEqual(rows[1]);
    expect(result.connections).toEqual(links);
    expect(result.nodes[1]).toEqual(image);
});

test("local mapped-field edits block reimport without mutating the canvas", () => {
    for (const key of ["dialogue", "performanceBlocking", "camera", "plotDescription", "durationSeconds"] as const) {
        const s = shot();
        const current = upsertProjectChapterStoryboard([], [], { unit, shots: [s] });
        const row = current.nodes[0].metadata!.storyboard!.rows[0];
        if (key === "durationSeconds") row[key] = 50;
        else row[key] = "手工改动";
        const before = structuredClone(current.nodes);
        s.revision = 2;
        expect(() => upsertProjectChapterStoryboard(current.nodes, [], { unit, shots: [s] })).toThrow("手工修改");
        expect(current.nodes).toEqual(before);
    }
});

test("old mappings are not silently overwritten when their text differs", () => {
    const s = shot();
    const current = upsertProjectChapterStoryboard([], [], { unit, shots: [s] });
    const row = current.nodes[0].metadata!.storyboard!.rows[0];
    delete row.projectShotSource;
    row.camera = "旧手工镜头";
    expect(() => upsertProjectChapterStoryboard(current.nodes, [], { unit, shots: [s] })).toThrow("手工修改");
});

test("additional manual rows and their connections survive a rejected import", () => {
    const s = shot();
    const current = upsertProjectChapterStoryboard([], [], { unit, shots: [s] });
    const rows = current.nodes[0].metadata!.storyboard!.rows;
    rows.push({ ...structuredClone(rows[0]), id: "manual", projectShotSource: undefined });
    const links: CanvasConnection[] = [{ id: "manual-link", fromNodeId: current.scriptNodeId, fromHandleId: "row:manual", toNodeId: "image" }];
    const before = structuredClone({ nodes: current.nodes, links });
    expect(() => upsertProjectChapterStoryboard(current.nodes, links, { unit, shots: [s] })).toThrow("避免覆盖手工镜头");
    expect({ nodes: current.nodes, links }).toEqual(before);
});

test("duplicate chapter nodes, rows and invalidated connections fail without removing anything", () => {
    const first = upsertProjectChapterStoryboard([], [], { unit, shots: [shot()], newNodeId: "fixed" });
    expect(first.scriptNodeId).toBe("fixed");
    expect(() => upsertProjectChapterStoryboard([...first.nodes, { ...first.nodes[0], id: "duplicate" }], [], { unit, shots: [shot()] })).toThrow("多个分镜节点");
    expect(() => upsertProjectChapterStoryboard(first.nodes, [{ id: "invalid", fromNodeId: "fixed", fromHandleId: "row:unknown", toNodeId: "image" }], { unit, shots: [shot()] })).toThrow("移除现有分镜连接");
    const duplicate = structuredClone(first.nodes);
    duplicate[0].metadata!.storyboard!.rows.push(structuredClone(duplicate[0].metadata!.storyboard!.rows[0]));
    expect(() => upsertProjectChapterStoryboard(duplicate, [], { unit, shots: [shot()] })).toThrow("行身份重复");
    const collision = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }); collision.id = "fixed";
    expect(() => upsertProjectChapterStoryboard([collision], [], { unit, shots: [shot()], newNodeId: "fixed" })).toThrow("ID 已被其他对象");
});

test("readback keeps unrelated node edits and rejects target movement or deletion during save", () => {
    const before = upsertProjectChapterStoryboard([], [], { unit, shots: [shot()], newNodeId: "fixed" }).nodes[0];
    const revised = shot(); revised.revision = 2; revised.content.camera = "近景";
    const after = upsertProjectChapterStoryboard([before], [], { unit, shots: [revised] }).nodes[0];
    const extra = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 });
    const merged = mergeProjectStoryboardReadback([before, extra], before, after);
    expect(merged).toEqual([after, extra]);
    expect(mergeProjectStoryboardReadback(merged, before, after)).toBe(merged);
    expect(() => mergeProjectStoryboardReadback([], before, after)).toThrow("手工修改");
    expect(() => mergeProjectStoryboardReadback([{ ...before, position: { x: 900, y: 1 } }], before, after)).toThrow("手工修改");
});

import { expect, test } from "bun:test";
import { attachNodeToStoryboardRow, createCanvasNode, createStoryboardRow, getConnectionTargetAnchor, storyboardHandleAtY, storyboardRowFromHandle } from "../src/lib/canvas/canvas-project-domain";
import { connectionHandleY } from "../src/components/canvas/canvas-connections";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT } from "../src/lib/canvas/canvas-storyboard-layout";
import { CanvasNodeType } from "../src/types/canvas";

function fixture() {
    const rows = [1, 2, 3].map(n => createStoryboardRow(n, { id: `stable-shot-${n}`, plotDescription: `画面${n}`, videoMotionPrompt: `视频${n}`, durationSeconds: n + 2 }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 500, y: 500 }, { storyboard: { rows, visibleColumns: [], referenceNodeIds: [] } });
    script.height = 600;
    return { script, rows };
}

test("rendered port centers, connection endpoints and pointer hit tests agree after scrolling and reordering", () => {
    const { script, rows } = fixture();
    script.metadata!.storyboard!.rows = [rows[2], rows[0], rows[1]];
    for (const scrollTop of [0, 35, 80]) {
        script.metadata!.storyboard!.rows.forEach((row, index) => {
            const localCenter = index * STORYBOARD_ROW_HEIGHT + STORYBOARD_ROW_HEIGHT / 2 - scrollTop;
            if (localCenter < 4) return;
            const expectedY = script.position.y + STORYBOARD_HEADER_HEIGHT + localCenter;
            const handle = `row:${row.id}`;
            expect(connectionHandleY(script, handle, scrollTop)).toBe(expectedY);
            expect(getConnectionTargetAnchor(script, { nodeId: script.id, handleType: "source" }, handle, scrollTop).y).toBe(expectedY);
            expect(storyboardHandleAtY(script, expectedY, scrollTop)).toBe(handle);
            expect(storyboardRowFromHandle([script], script.id, handle)).toBe(row);
        });
    }
});

test("reference assets and output targets bind only to the stable selected shot", () => {
    const { script, rows } = fixture();
    const image = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 });
    image.metadata = { assetCategory: "environment", content: "fixture-image" };
    const video = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 });
    const originals = JSON.stringify([script, image, video]);
    const withAsset = attachNodeToStoryboardRow([script, image, video], { fromNodeId: image.id, toNodeId: script.id, toHandleId: `row:${rows[1].id}` });
    const linked = attachNodeToStoryboardRow(withAsset, { fromNodeId: script.id, fromHandleId: `row:${rows[1].id}`, toNodeId: video.id });
    const actualRows = linked[0].metadata!.storyboard!.rows;
    expect(actualRows[0]).toEqual(rows[0]);
    expect(actualRows[2]).toEqual(rows[2]);
    expect(actualRows[1].assetBindings?.map(binding => binding.nodeId)).toEqual([image.id]);
    expect(actualRows[1].videoNodeId).toBe(video.id);
    expect(linked[2].metadata).toMatchObject({ prompt: "视频2", seconds: "4", shotIndex: 2 });
    expect(linked[2].metadata!.composerContent).toContain(image.id);
    expect(JSON.stringify([script, image, video])).toBe(originals);
});

test("image and video downstream context contains the selected shot's complete direction, not the whole table", () => {
    const { script, rows } = fixture();
    Object.assign(rows[1], { narrativeIntent: "建立出口关系", viewerPOV: "观众先看到门口", performanceBlocking: "抬头后手停在桌边", mustHave: ["桌上的信不能消失"], optionalDetails: ["雨滴反光"], continuityOut: "右手仍在桌边", camera: "左侧固定中景", dialogue: "林夏：我在这里。" });
    for (const kind of [CanvasNodeType.Image, CanvasNodeType.Video]) {
        const target = createCanvasNode(kind, { x: 0, y: 0 });
        const connections = [{ id: "fixture-link", fromNodeId: script.id, toNodeId: target.id, fromHandleId: `row:${rows[1].id}` }];
        const context = buildNodeGenerationContext(target.id, [script, target], connections, "根据连线镜头制作", []);
        for (const value of ["画面2", "建立出口关系", "观众先看到门口", "抬头后手停在桌边", "桌上的信不能消失", "雨滴反光", "右手仍在桌边", "左侧固定中景", "林夏：我在这里。"]) expect(context.prompt).toContain(value);
        expect(context.prompt).not.toContain("画面1");
        expect(context.prompt).not.toContain("画面3");
        rows[1].plotDescription = "本镜已修改";
        expect(buildNodeGenerationContext(target.id, [script, target], connections, "根据连线镜头制作", []).prompt).toContain("本镜已修改");
        rows[1].plotDescription = "画面2";
    }
});

test("explicit asset mentions retain structural shot direction exactly once, while prompt-only stays explicit", () => {
    const { script, rows } = fixture();
    const target = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 });
    const reference = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "共同风格设定" });
    const connections = [{ id: "shot", fromNodeId: script.id, toNodeId: target.id, fromHandleId: `row:${rows[1].id}` }, { id: "ref", fromNodeId: reference.id, toNodeId: target.id }];
    const nodes = [script, target, reference];
    for (const prompt of [`参考 @[node:${reference.id}]`, `参考 @[node:${reference.id}] @[node:${script.id}:row:${rows[1].id}]`]) {
        const context = buildNodeGenerationContext(target.id, nodes, connections, prompt, []);
        expect(context.prompt.split("画面2")).toHaveLength(2);
        expect(context.prompt).toContain("共同风格设定");
        expect(context.prompt).not.toContain("画面1");
    }
    expect(buildNodeGenerationContext(target.id, nodes, connections, "仅提示词", [], true).prompt).toBe("仅提示词");
});

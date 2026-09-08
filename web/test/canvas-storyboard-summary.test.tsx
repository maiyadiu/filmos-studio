import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasScriptNodeContent } from "../src/components/canvas/canvas-script-node";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { deriveStoryboardPipelineProgress } from "../src/lib/canvas/canvas-storyboard-progress";
import { CanvasNodeType, type StoryboardRow } from "../src/types/canvas";

function renderSummary(rows: StoryboardRow[]) {
    const node = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { storyboard: { rows, visibleColumns: ["plotDescription", "camera"], referenceNodeIds: [] } });
    const before = JSON.stringify(node);
    const noop = () => {};
    const html = renderToStaticMarkup(<CanvasScriptNodeContent node={node} nodes={[node]} pipeline={deriveStoryboardPipelineProgress(node, [node], [])} scale={1} mentionReferences={[]}
        onOpen={noop} onCreateImageNodes={noop} onCreateVideoNodes={noop} onGenerateImages={noop} onGenerateVideos={noop} onVideoInputModeChange={noop} onMergeVideos={noop} onCreateActionBoards={noop}
        onRetryBatch={noop} onRetryBatchItem={noop} onStopBatch={noop} onAddRow={noop} onRemoveRow={noop} onUpdateRow={noop} onPromptChange={noop} onGenerateScript={noop} onModelChange={noop}
        onShotDurationChange={noop} onShotCountChange={noop} onComposerHeightChange={noop} onConnectStart={noop} onScrollTopChange={noop} />);
    expect(JSON.stringify(node)).toBe(before);
    return html;
}

function businessRow() {
    return createStoryboardRow(1, { plotDescription: "扫描光越过门口，警报引入车库。", performanceBlocking: "顶灯闪烁", camera: "固定低机位", videoMotionPrompt: "",
        projectShotSource: { id: "fixture-shot", revision: 1, sourceRevision: 2, sourceHash: "a".repeat(64) } });
}

test("business storyboard summary shows the shot without inventing a media prompt or dialogue", () => {
    const html = renderSummary([businessRow()]);
    expect(html).toContain("画面描述");
    expect(html).toContain("扫描光越过门口，警报引入车库。");
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).toContain('aria-label="第 1 镜画面描述"');
    expect(html).toContain('aria-label="放大分镜表"');
    expect(html).toContain('aria-label="第 1 镜输出连接点"');
    expect(html).toContain('aria-label="第 1 镜输入连接点"');
    expect(html).not.toContain("查看来源并编写提示词");
    expect(html).toContain("台词或旁白");
});

test("native prompt rows remain editable, including a mixed imported storyboard", () => {
    const native = createStoryboardRow(2, { videoMotionPrompt: "镜头缓慢推近", dialogue: "林夏：我陪你。" });
    const nativeHtml = renderSummary([native]);
    expect(nativeHtml).toContain("视频提示词");
    expect(nativeHtml).toContain("镜头缓慢推近");
    expect(nativeHtml).not.toContain("画面描述 / 视频提示词");
    const mixed = renderSummary([businessRow(), native]);
    expect(mixed).toContain("画面描述 / 视频提示词");
    expect(mixed).toContain("扫描光越过门口");
    expect(mixed).toContain("镜头缓慢推近");
    expect(mixed).toContain("林夏：我陪你。");
});

test("a missing business description is explicit, not replaced with a different field", () => {
    const row = businessRow();
    row.plotDescription = "";
    row.videoMotionPrompt = "这是独立的视频提示词";
    const html = renderSummary([row]);
    expect(html).toContain("填写画面描述");
    expect(html).not.toContain(row.videoMotionPrompt);
});

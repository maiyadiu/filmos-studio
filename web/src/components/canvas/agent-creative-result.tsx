import { useState } from "react";
import { Button } from "antd";
import { Link } from "react-router";
import { FileText } from "lucide-react";
import { ScriptRevisionHistory } from "@/pages/projects/detail/script-revision-history";
import { ChapterShotReview } from "@/pages/projects/detail/shot-review";
import type { AgentCreativeResult } from "@/lib/canvas/agent-creative-results";
import { CanvasPromptEditor } from "./canvas-prompt-editor";
import { AgentShotImageView } from "./agent-shot-image-view";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

export function AgentCreativeResultAction({ result, current }: { result: AgentCreativeResult; current: () => CanvasAgentSnapshot }) {
    const [open, setOpen] = useState(false);
    return <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="打开业务结果">
        {result.kind === "script-batch" ? <>
            <Link to={`/projects/${encodeURIComponent(result.projectId)}/chapters`}>查看全部 {result.unitIds.length} 个章节</Link>
            <ScriptRevisionHistory projectId={result.projectId} unitId={result.unitIds[0]} revision={1} initialRevision={1} triggerLabel="回读首章初稿 v1" />
        </> : null}
        {result.kind === "script" ? <ScriptRevisionHistory projectId={result.projectId} unitId={result.unitId} revision={result.revision} initialRevision={result.revision} triggerLabel={`查看剧本 v${result.revision}`} />
            : result.kind === "shots" ? <ChapterShotReview projectId={result.projectId} unitId={result.unitId} triggerLabel="回读本章当前分镜" />
            : result.kind === "shot-image" ? <>
                <Button size="small" icon={<FileText className="size-3.5" />} onClick={() => setOpen(true)}>第 {result.shotNumber} 镜 · 查看原图与依据</Button>
                {open && <AgentShotImageView evidence={result.evidence} shotNumber={result.shotNumber} current={current} onClose={() => setOpen(false)} />}
            </>
            : result.kind === "prompt" ? <>
                <Button size="small" icon={<FileText className="size-3.5" />} onClick={() => setOpen(true)}>第 {result.shotNumber} 镜{result.promptKind === "image" ? "图片" : "视频"}稿 v{result.revision}</Button>
                {open && <CanvasPromptEditor canvasId={result.canvasId} target={{ projectId: result.projectId, nodeId: result.nodeId, rowId: result.rowId, kind: result.promptKind }} shotNumber={result.shotNumber} initialRevision={result.revision} onClose={() => setOpen(false)} />}
            </> : null}
    </div>;
}

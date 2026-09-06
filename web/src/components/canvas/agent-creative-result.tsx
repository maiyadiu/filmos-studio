import { useState } from "react";
import { Button } from "antd";
import { FileText } from "lucide-react";
import { ScriptRevisionHistory } from "@/pages/projects/detail/script-revision-history";
import { ChapterShotReview } from "@/pages/projects/detail/shot-review";
import type { AgentCreativeResult } from "@/lib/canvas/agent-creative-results";
import { CanvasPromptEditor } from "./canvas-prompt-editor";

export function AgentCreativeResultAction({ result }: { result: AgentCreativeResult }) {
    const [open, setOpen] = useState(false);
    return <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="打开业务结果">
        {result.kind === "script" ? <ScriptRevisionHistory projectId={result.projectId} unitId={result.unitId} revision={result.revision} initialRevision={result.revision} triggerLabel={`查看剧本 v${result.revision}`} />
            : result.kind === "shots" ? <ChapterShotReview projectId={result.projectId} unitId={result.unitId} triggerLabel="回读本章当前分镜" />
            : <>
                <Button size="small" icon={<FileText className="size-3.5" />} onClick={() => setOpen(true)}>第 {result.shotNumber} 镜{result.promptKind === "image" ? "图片" : "视频"}稿 v{result.revision}</Button>
                {open && <CanvasPromptEditor canvasId={result.canvasId} target={{ projectId: result.projectId, nodeId: result.nodeId, rowId: result.rowId, kind: result.promptKind }} shotNumber={result.shotNumber} initialRevision={result.revision} onClose={() => setOpen(false)} />}
            </>}
    </div>;
}

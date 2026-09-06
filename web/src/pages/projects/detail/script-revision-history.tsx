import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Modal, Select } from "antd";
import { History } from "lucide-react";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { getProjectScriptRevision, listProjectScriptRevisions } from "@/services/api/projects";
import { documentTextFromHtml } from "./chapter-document-view";

export function ScriptRevisionHistory({ projectId, unitId, revision, initialRevision, triggerLabel = "修订历史" }: { projectId: string; unitId: string; revision: number; initialRevision?: number; triggerLabel?: string }) {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<number>();
    const [readable, setReadable] = useState(true);
    useEffect(() => { setSelected(undefined); }, [unitId]);
    const history = useQuery({ queryKey: ["project-script-revisions", projectId, unitId], queryFn: () => listProjectScriptRevisions(projectId, unitId), enabled: open });
    const version = selected ?? history.data?.revisions[0]?.revision ?? revision;
    const after = useQuery({ queryKey: ["project-script-revision", projectId, unitId, version], queryFn: () => getProjectScriptRevision(projectId, unitId, version), enabled: open && version > 0 });
    const before = useQuery({ queryKey: ["project-script-revision", projectId, unitId, version - 1], queryFn: () => getProjectScriptRevision(projectId, unitId, version - 1), enabled: open && version > 1 });
    const error = history.error || after.error || before.error;
    const oldText = documentTextFromHtml(before.data?.revision.sourceText ?? "");
    const newText = documentTextFromHtml(after.data?.revision.sourceText ?? "");
    return <>
        <Button size="small" icon={<History className="size-3.5" />} onClick={() => { setSelected(initialRevision); setOpen(true); }}>{triggerLabel}</Button>
        <Modal title="剧本修订历史与对照" open={open} onCancel={() => setOpen(false)} footer={null} width={960}>
            <p className="mb-3 text-sm text-muted-foreground">章节编辑记录，原版本保留；不代表 Film Core 已批准或锁定。易读模式显示排版正文；文字差异模式高亮首末变化之间的范围。</p>
            <div className="mb-3 flex gap-2" aria-label="修订显示方式">
                <Button size="small" aria-pressed={readable} onClick={() => setReadable(true)}>易读</Button>
                <Button size="small" aria-pressed={!readable} onClick={() => setReadable(false)}>文字差异</Button>
            </div>
            <Select aria-label="选择剧本修订" value={version} onChange={setSelected} loading={history.isFetching} className="mb-3 w-full" options={history.data?.revisions.map((item) => ({ value: item.revision, label: `v${item.revision} · ${item.note || "初始正文"} · ${new Date(item.createdAt).toLocaleString()}` }))} />
            {error ? <Alert type="error" title="修订读取失败" description={error.message} showIcon /> : after.isPending || (version > 1 && before.isPending) ? <p role="status">正在读取保存的版本……</p> :
                <div className="grid gap-3 md:grid-cols-2">
                    <RevisionText label={version > 1 ? `修订前 v${version - 1}` : "初始版本（无上一版）"} text={oldText} other={newText} readable={readable} />
                    <RevisionText label={`修订后 v${version}`} text={newText} other={oldText} readable={readable} />
                </div>}
            {after.data && <p className="mt-3 break-all text-xs text-muted-foreground">保存说明：{after.data.revision.note || "初始正文"} · 正文 SHA-256：{after.data.revision.sourceHash}</p>}
        </Modal>
    </>;
}

function RevisionText({ label, text, other, readable }: { label: string; text: string; other: string; readable: boolean }) {
    let start = 0;
    while (start < Math.min(text.length, other.length) && text[start] === other[start]) start++;
    let tail = 0;
    while (tail < text.length - start && tail < other.length - start && text[text.length - tail - 1] === other[other.length - tail - 1]) tail++;
    return <section aria-label={label} className="min-w-0 rounded-lg border border-border p-3">
        <h3 className="mb-2 text-sm font-semibold">{label}</h3>
        {readable ? <div className="thin-scrollbar max-h-[55vh] overflow-auto break-words text-sm leading-7"><AIMessageMarkdown>{text}</AIMessageMarkdown></div> : <pre className="thin-scrollbar max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-7">{text.slice(0, start)}<mark className="bg-status-warning/25 text-foreground">{text.slice(start, text.length - tail)}</mark>{tail ? text.slice(-tail) : ""}</pre>}
    </section>;
}

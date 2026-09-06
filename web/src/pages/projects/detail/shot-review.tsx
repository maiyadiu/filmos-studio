import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Modal, Select } from "antd";
import { Clapperboard } from "lucide-react";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { getProjectShotContext, getProjectShotRevisions, type ProjectShot } from "@/services/api/projects";
import { documentTextFromHtml } from "./chapter-document-view";

export function ChapterShotReview({ projectId, unitId, triggerLabel = "查看分镜" }: { projectId: string; unitId: string; triggerLabel?: string }) {
    const [open, setOpen] = useState(false);
    const [selectedId, setSelectedId] = useState("");
    const [version, setVersion] = useState<number>();
    const queryClient = useQueryClient();
    const context = useQuery({ queryKey: ["project-shots", projectId, unitId], queryFn: () => getProjectShotContext(projectId, unitId), enabled: open });
    const shots = context.data?.shots.slice().sort((a, b) => a.position - b.position) || [];
    const selected = shots.find(shot => shot.id === selectedId) || shots[0];
    const history = useQuery({ queryKey: ["project-shot-revisions", projectId, selected?.id], queryFn: () => getProjectShotRevisions(projectId, selected!.id), enabled: open && Boolean(selected) });
    const shown = version === undefined ? selected : history.data?.revisions.find(item => item.revision === version)?.shot;
    useEffect(() => { setSelectedId(""); setVersion(undefined); }, [unitId]);
    useEffect(() => {
        const refresh = (event: Event) => {
            const scope = (event as CustomEvent<{ projectId: string; unitId: string }>).detail;
            if (scope?.projectId !== projectId || scope.unitId !== unitId) return;
            void queryClient.invalidateQueries({ queryKey: ["project-shots", projectId, unitId] });
            void queryClient.invalidateQueries({ queryKey: ["project-shot-revisions", projectId] });
        };
        window.addEventListener("filmos:shots-revised", refresh);
        window.addEventListener("filmos:script-revised", refresh);
        return () => { window.removeEventListener("filmos:shots-revised", refresh); window.removeEventListener("filmos:script-revised", refresh); };
    }, [projectId, unitId, queryClient]);
    const error = context.error || history.error;
    return <>
        <Button size="small" icon={<Clapperboard className="size-3.5" />} onClick={() => setOpen(true)}>{triggerLabel}</Button>
        <Modal title="章节分镜与版本" open={open} onCancel={() => setOpen(false)} footer={null} width={1000}>
            <p className="mb-3 text-sm text-muted-foreground">业务镜头的已保存正文；画布是展示映射。历史只读，不自动还原，也不代表正式批准或已生成图片。</p>
            {error ? <Alert type="error" showIcon title="分镜读取失败" description={error.message} /> : context.isPending ? <p role="status">正在读取业务分镜……</p> : <>
                <div className="mb-4 flex flex-wrap items-center gap-3 text-sm" aria-label="分镜保存状态">
                    <strong>{shots.length} 个镜头</strong><span>分镜 v{context.data?.unit.shotRevision} · 剧本 v{context.data?.unit.revision}</span>
                    <span>{context.data?.coverage.chapterComplete ? "原文与对白覆盖完整" : "来源覆盖待补全"}</span>
                    <Button size="small" loading={context.isFetching} onClick={() => { void context.refetch(); if (selected) void history.refetch(); }}>刷新</Button>
                </div>
                {!!context.data?.staleShotIds.length && <Alert className="mb-3" type="warning" showIcon title={`${context.data.staleShotIds.length} 个镜头来源已过期`} description="剧本已变更，请按新来源修订；旧镜头与历史保留，不自动覆盖。" />}
                {!shots.length ? <p className="py-8 text-center text-muted-foreground">本章还没有已保存分镜。可在 Agent 中安排拆镜，保存后在这里查看。</p> : <>
                    <div className="mb-4 grid gap-3 sm:grid-cols-2">
                        <Select aria-label="选择业务镜头" value={selected?.id} onChange={id => { setSelectedId(id); setVersion(undefined); }} options={shots.map((shot, index) => ({ value: shot.id, label: `${index + 1}. ${shot.title}` }))} />
                        <Select aria-label="选择镜头版本" value={version ?? "current"} onChange={value => setVersion(value === "current" ? undefined : Number(value))} loading={history.isFetching} options={[{ value: "current", label: `当前 v${selected?.revision}` }, ...(history.data?.revisions || []).map(item => ({ value: item.revision, label: `历史 v${item.revision} · ${new Date(item.createdAt).toLocaleString()}` }))]} />
                    </div>
                    {shown ? <ShotText shot={shown} historical={version !== undefined} /> : <p role="status">正在读取镜头版本……</p>}
                </>}
            </>}
        </Modal>
    </>;
}

function ShotText({ shot, historical }: { shot: ProjectShot; historical: boolean }) {
    return <article aria-label={historical ? "历史镜头正文" : "当前镜头正文"} className="thin-scrollbar max-h-[60vh] overflow-auto break-words rounded-lg bg-muted/30 p-4 text-foreground">
        <header className="mb-5"><h3 className="text-lg font-semibold">{shot.title}</h3><p className="mt-1 text-sm text-muted-foreground">{shot.durationMs / 1000} 秒 · 镜头 v{shot.revision} · 来源剧本 v{shot.sourceRevision}{historical ? " · 历史只读" : ""}</p></header>
        <ShotField title="情节与意图" text={shot.description} />
        <ShotField title="场景" text={shot.content.scene} />
        <ShotField title="人物" text={shot.content.characters?.join("、") || ""} />
        <section className="mb-5"><h4 className="mb-2 text-sm font-semibold">对白</h4>{shot.content.dialogue?.length ? shot.content.dialogue.map((cue, index) => <p key={index} className="mb-2 whitespace-pre-wrap text-sm leading-7"><strong>{cue.speaker}：</strong>{cue.text}</p>) : <p className="text-sm text-muted-foreground">无对白</p>}</section>
        <ShotField title="动作与调度" text={shot.content.action} />
        <ShotField title="镜头与构图" text={shot.content.camera} />
        <details className="text-sm"><summary className="cursor-pointer font-medium">来源原文 · {shot.content.sourceReferences?.length || 0} 段</summary>{shot.content.sourceReferences?.map((ref, index) => <div key={index} className="mt-3"><span className="text-xs text-muted-foreground">{ref.paragraphId}</span><ReadableText text={ref.quote} /></div>)}<p className="mt-3 break-all text-xs text-muted-foreground">镜头 ID：{shot.id}<br />来源 SHA-256：{shot.sourceHash}</p></details>
    </article>;
}

function ShotField({ title, text }: { title: string; text: string }) {
    return <section className="mb-5"><h4 className="mb-2 text-sm font-semibold">{title}</h4>{text ? <ReadableText text={text} /> : <p className="text-sm text-muted-foreground">未填写</p>}</section>;
}

function ReadableText({ text }: { text: string }) {
    return <AIMessageMarkdown className="text-sm leading-7">{documentTextFromHtml(text)}</AIMessageMarkdown>;
}

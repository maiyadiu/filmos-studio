import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Segmented, Select, Tag } from "antd";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { documentTextFromHtml } from "@/lib/document-text";
import { CanvasPromptSaveError, getCanvasPromptHistory, getCanvasPromptRevision, verifyCanvasPromptRevision, type CanvasPromptContext, type CanvasPromptDependencies, type CanvasPromptInput, type CanvasPromptRevision, type CanvasPromptRevisionSummary, type CanvasPromptTarget } from "@/services/api/canvas-prompts";
import { loadSyncedCanvasPrompt, saveSyncedCanvasPrompt } from "@/services/user-data-sync";

const blockers: Record<string, string> = { SOURCE_NOT_EDITABLE: "来源已完成或不允许修改", SHOT_SOURCE_STALE: "业务镜头仍引用旧剧本，请先修订分镜", CANVAS_SHOT_STALE: "画布分镜映射已过期，请先核对并同步最新分镜" };

export function CanvasPromptEditor({ canvasId, target, shotNumber, initialRevision, onClose }: { canvasId: string; target: CanvasPromptTarget; shotNumber: number; initialRevision?: number; onClose: () => void }) {
    const { modal } = App.useApp();
    const [context, setContext] = useState<CanvasPromptContext>();
    const [history, setHistory] = useState<CanvasPromptRevisionSummary[]>([]);
    const [version, setVersion] = useState<number | "current">(initialRevision ?? "current");
    const [historical, setHistorical] = useState<CanvasPromptRevision>();
    const [draft, setDraft] = useState("");
    const [mode, setMode] = useState<"readable" | "edit">("readable");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [pending, setPending] = useState<CanvasPromptInput>();
    const [needsReload, setNeedsReload] = useState(false);
    const alive = useRef(true);
    const versionRead = useRef(0);
    const dirty = Boolean(context && draft !== context.prompt);

    const load = async (keepDraft = false) => {
        setLoading(true); setError("");
        try {
            const [result, rows] = await Promise.all([loadSyncedCanvasPrompt(canvasId, target), getCanvasPromptHistory(canvasId, target)]);
            if (!alive.current) return;
            setContext(result.context); setHistory(rows); setNeedsReload(false);
            if (!keepDraft) setDraft(result.context.prompt);
            setNotice(!result.appliedLocally ? "本地提示词存在未同步改动，已保留；请先核对本地内容与后端历史。" : keepDraft ? "已回读最新来源；你的草稿保持不变，请核对后保存。" : "");
        } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "提示词读取失败"); }
        finally { if (alive.current) setLoading(false); }
    };
    useEffect(() => {
        alive.current = true;
        void load();
        if (initialRevision !== undefined) void chooseVersion(initialRevision);
        return () => { alive.current = false; versionRead.current++; };
        // The parent keys this editor by canvas/node/row/kind; no reload on each
        // live row render, which would erase an in-progress local draft.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const chooseVersion = async (value: number | "current") => {
        setVersion(value); setHistorical(undefined);
        const sequence = ++versionRead.current;
        if (value === "current") return;
        try {
            const row = await getCanvasPromptRevision(canvasId, target, value);
            await verifyCanvasPromptRevision(row, canvasId, target, value);
            if (alive.current && sequence === versionRead.current) setHistorical(row);
        } catch (error) { if (alive.current && sequence === versionRead.current) setError(error instanceof Error ? error.message : "历史回读失败"); }
    };
    const save = async () => {
        if (!context || saving) return;
        const input: CanvasPromptInput = pending || { ...target, requestId: crypto.randomUUID(), expectedRevision: context.state.revision, expectedContentHash: context.state.contentHash, dependencyHash: context.dependencyHash, prompt: draft };
        setPending(input); setSaving(true); setError(""); setNotice("");
        try {
            const result = await saveSyncedCanvasPrompt(canvasId, input);
            if (!alive.current) return;
            setContext(result.context); setDraft(result.context.prompt); setPending(undefined); setVersion("current"); setMode("readable");
            setNotice(!result.appliedLocally ? `已保存 v${result.receipt.snapshot.revision}，但本地同一行发生变化，未覆盖本地内容。` : result.matchesCurrent ? `已保存 v${result.context.state.revision}，原版保留，正文与请求回执回读一致。` : `原请求已保存 v${result.receipt.snapshot.revision}；当前已是 v${result.context.state.revision}，没有用旧回执覆盖新稿。`);
            try {
                const rows = await getCanvasPromptHistory(canvasId, target);
                if (alive.current) setHistory(rows);
            } catch { if (alive.current) setError("正文与保存回执已核验；历史列表刷新失败，可回读最新来源刷新列表。"); }
        } catch (error) {
            if (alive.current) {
                if (error instanceof CanvasPromptSaveError && error.outcome === "rejected") {
                    setPending(undefined); setNeedsReload(true);
                    setError(`${error.message}。本次提示词未保存，草稿已保留；请回读最新来源后重新核对。`);
                } else setError(`${error instanceof Error ? error.message : "保存状态待核对"}。保留原请求 ID，可核验并重试同一请求。`);
            }
        } finally { if (alive.current) setSaving(false); }
    };
    const close = () => {
        if (saving) return;
        if (!dirty && !pending) { onClose(); return; }
        modal.confirm({ title: pending ? "关闭前保留请求信息" : "放弃尚未保存的草稿？", content: pending ? `本次请求 ${pending.requestId} 的结果尚待核对。已保存版本仍在历史中；关闭不会撤销后端写入。` : "已保存的提示词和历史不受影响。", okText: "关闭", cancelText: "继续编辑", onOk: onClose });
    };
    const shownText = version === "current" ? draft : historical?.prompt;
    const dependencies = version === "current" ? context?.dependencies : historical?.dependencies;
    return <Modal open title={`第 ${shotNumber} 镜 · ${target.kind === "image" ? "图片" : "视频"}提示词`} onCancel={close} width={1000} footer={null} mask={{ closable: !saving }} keyboard={!saving} closable={!saving} destroyOnHidden>
        <div className="space-y-4 text-foreground" data-canvas-no-zoom>
            <p className="text-sm leading-6 text-muted-foreground">只编辑创作草稿，不生成、不上传、不触发模型调用；保存到原分镜行，旧版保留。</p>
            {error && <Alert type="error" showIcon title="需要核对" description={error} />}
            {notice && <Alert type="info" showIcon title={notice} />}
            {context?.stale && <Alert type="warning" showIcon title="已保存提示词的来源发生变化" description="旧稿仍保留。请根据下方当前剧本、镜头和素材重新核对，不把旧稿当作已适配的新稿。" />}
            {!!context?.writeBlockers.length && <Alert type="warning" showIcon title="当前不可保存新版本" description={context.writeBlockers.map(code => blockers[code] || code).join("；")} />}
            <div className="flex flex-wrap items-center gap-3">
                <Tag>{!context ? loading ? "读取中" : "保存状态尚未取得" : context.managed ? `已存 v${context.state.revision}` : "原稿 · 尚未版本化"}</Tag>
                <Select aria-label="选择提示词版本" className="min-w-52 flex-1" value={version} onChange={value => void chooseVersion(value)} disabled={loading || saving} options={[{ value: "current", label: "当前提示词" }, ...history.map(row => ({ value: row.revision, label: `历史 v${row.revision} · ${new Date(row.createdAt).toLocaleString()}` }))]} />
                <Button onClick={() => void load(dirty)} loading={loading} disabled={saving}>回读最新来源</Button>
                {version === "current" && <Segmented aria-label="提示词显示模式" value={mode} options={[{ label: "易读", value: "readable" }, { label: "编辑原文", value: "edit" }]} onChange={value => setMode(value as "readable" | "edit")} />}
            </div>
            {loading && !context ? <p role="status" className="py-10 text-center">正在读取提示词与来源……</p> : version !== "current" && !historical ? <p role="status">{error ? "历史版本尚未取得；请在连接恢复后重新打开，不代表此版本为空。" : "正在读取历史版本……"}</p> : <>
                <section className="rounded-lg border border-border bg-muted/30 p-4" aria-label={version === "current" ? dirty ? "未保存提示词草稿" : "当前已保存提示词" : "历史提示词正文"}>
                    <p className="mb-3 text-xs text-muted-foreground">{version !== "current" ? `历史 v${version} · 只读` : dirty ? "未保存草稿 · 易读预览不会改变原文" : context?.managed ? `已保存 v${context.state.revision}` : "原文 · 首次保存将保留此版"}</p>
                    {version === "current" && mode === "edit" ? <Input.TextArea aria-label="提示词原文" value={draft} onChange={event => setDraft(event.target.value)} disabled={saving || Boolean(pending)} autoSize={{ minRows: 10, maxRows: 18 }} className="!text-sm !leading-7" /> : <div className="thin-scrollbar max-h-[40vh] overflow-auto break-words text-sm [&_.ai-message-markdown-paragraph]:whitespace-pre-line">{shownText ? <AIMessageMarkdown>{documentTextFromHtml(shownText)}</AIMessageMarkdown> : <p className="py-8 text-center text-sm text-muted-foreground">{version !== "current" ? "此历史版本的提示词为空。" : "还没有提示词。切换“编辑原文”，或让 Agent 根据当前镜头编写。"}</p>}</div>}
                </section>
                <PromptSources dependencies={dependencies} overrides={version === "current" ? context?.localOverrides : undefined} />
            </>}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
                {pending && <code className="mr-auto break-all text-xs text-muted-foreground">请求：{pending.requestId}</code>}
                {version !== "current" && historical && <Button disabled={saving || Boolean(pending)} onClick={() => { setDraft(historical.prompt); setVersion("current"); setMode("edit"); }}>作为新草稿</Button>}
                <Button onClick={close} disabled={saving}>关闭</Button>
                <Button type="primary" onClick={() => void save()} loading={saving} disabled={loading || !context || (!pending && (needsReload || !dirty || !draft.trim() || !!context.writeBlockers.length))}>{pending ? "核验并重试原请求" : "保存并回读"}</Button>
            </div>
        </div>
    </Modal>;
}

function PromptSources({ dependencies, overrides }: { dependencies?: CanvasPromptDependencies | null; overrides?: string[] }) {
    if (!dependencies) return <p className="text-sm text-muted-foreground">此旧版没有可证明的来源依赖，未用当前来源补写历史。</p>;
    const shot = dependencies.shot;
    return <details className="rounded-lg border border-border p-4 text-sm">
        <summary className="cursor-pointer font-medium">来源 · {dependencies.source.title} v{dependencies.source.revision} / 镜头 v{shot.revision} / {dependencies.assets.length} 个素材引用</summary>
        <div className="mt-4 space-y-3 leading-7">
            {!!overrides?.length && <p className="text-muted-foreground">画布中另有手工调整：{overrides.join("、")}。原业务镜头与手工内容分别保留。</p>}
            <AIMessageMarkdown>{documentTextFromHtml(`场景：${shot.content.scene}\n\n角色：${shot.content.characters?.join("、") || "未指定"}\n\n动作：${dependencies.direction.performanceBlocking ?? shot.content.action}\n\n镜头：${dependencies.direction.camera ?? shot.content.camera}`)}</AIMessageMarkdown>
            {!!dependencies.assets.length && <ul className="list-inside list-disc">{dependencies.assets.map((asset, index) => <li key={index}>{asset.title || asset.assetId || asset.nodeId || asset.origin} · {asset.role}{asset.version ? ` · 设定 v${asset.version.version}` : ""}{asset.resource ? " · 已绑定用户资源" : ""} · 未验证像素</li>)}</ul>}
            <p className="break-all text-xs text-muted-foreground">镜头：{shot.id}<br />脚本 SHA-256：{dependencies.source.hash}</p>
            {dependencies.guidance && <details className="border-t border-border pt-3"><summary className="cursor-pointer">原生模板依据 · {dependencies.guidance.templateId ? `v${dependencies.guidance.templateVersion}` : "内置默认"}{dependencies.guidance.customizationId ? " · 含用户定制" : ""}</summary><p className="text-muted-foreground">仅为当前来源的创作指导，不是已保存提示词或已完成的模型适配。</p><AIMessageMarkdown>{documentTextFromHtml(dependencies.guidance.content)}</AIMessageMarkdown></details>}
        </div>
    </details>;
}

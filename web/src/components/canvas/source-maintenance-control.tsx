import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Tag } from "antd";
import { CodeXml, RefreshCw } from "lucide-react";
import { AgentRuntimeRequestError, type AgentSessionClient, type SourceTaskInput, type SourceTaskView, type SourceWorkspaceView } from "@/film/agent/agent-client";
import { assertSourceSession, type SourceScopeOperation, type SourceSessionScope } from "@/film/agent/source-maintenance-action";

type Props = {
    client: AgentSessionClient;
    scope: SourceSessionScope;
    connected: boolean;
    disabled: boolean;
    active: boolean;
    uncertain: boolean;
    onChange: (operation: SourceScopeOperation) => Promise<SourceTaskView>;
};

export function SourceMaintenanceControl({ client, scope, connected, disabled, active, uncertain, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState<SourceTaskView | null>(null);
    const [workspace, setWorkspace] = useState<SourceWorkspaceView | null>(null);
    const [purpose, setPurpose] = useState("");
    const [prefix, setPrefix] = useState("web/src/");
    const [files, setFiles] = useState<string[]>([]);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [listedPrefix, setListedPrefix] = useState("");
    const [selected, setSelected] = useState<SourceTaskInput["files"]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [known, setKnown] = useState(false);
    const lock = useRef(false);
    const mounted = useRef(true);
    const reads = useRef<AbortController | null>(null);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current?.abort(); }; }, []);
    const explain = (error: unknown) => error instanceof AgentRuntimeRequestError && error.status === 404
        ? "当前运行的 Agent 尚未提供维护接口。需要先安全更新源码服务；不会跳转 API 设置。"
        : error instanceof Error ? error.message : "维护状态读取失败，请核对原会话。";

    const refresh = async () => {
        if (lock.current || !connected) return;
        reads.current?.abort();
        const controller = new AbortController(); reads.current = controller;
        setKnown(false); setError("");
        try {
            const { session } = await client.getSession(scope.id, controller.signal);
            assertSourceSession(session, scope);
            const [task, inspection] = await Promise.all([client.getSourceTask(scope.id, controller.signal), client.inspectSource(controller.signal)]);
            if (controller.signal.aborted || !mounted.current) return;
            setSource(task.source); setWorkspace(inspection.result); setKnown(true);
        } catch (error) { if (!controller.signal.aborted && mounted.current) setError(explain(error)); }
    };
    useEffect(() => {
        if (open && connected) void refresh();
        else reads.current?.abort();
        if (!connected) setKnown(false);
        return () => reads.current?.abort();
    }, [open, connected, client, scope.id]);

    const listFiles = async (offset = 0) => {
        if (lock.current || !connected) return;
        lock.current = true; setBusy(true); setError("");
        const value = offset ? listedPrefix : prefix.trim();
        try {
            const { result } = await client.listSourceFiles({ prefix: value, offset, limit: 60 });
            if (!mounted.current) return;
            setFiles(previous => offset ? [...previous, ...result.paths] : result.paths);
            setListedPrefix(value); setNextOffset(result.nextOffset);
        } catch (error) { if (mounted.current) setError(explain(error)); }
        finally { lock.current = false; if (mounted.current) setBusy(false); }
    };
    const selectFile = async (path: string) => {
        if (lock.current || disabled || !connected) return;
        if (selected.some(file => file.path === path)) { setSelected(files => files.filter(file => file.path !== path)); return; }
        if (selected.length >= 5) return;
        lock.current = true; setBusy(true); setError("");
        try {
            const { result } = await client.readSourceFile({ path, lineCount: 1 });
            if (mounted.current) setSelected(files => [...files, { path: result.path, expectedHash: result.contentHash }]);
        } catch (error) { if (mounted.current) setError(explain(error)); }
        finally { lock.current = false; if (mounted.current) setBusy(false); }
    };
    const change = async (operation: SourceScopeOperation) => {
        if (lock.current || disabled || !connected || !known) return;
        lock.current = true; reads.current?.abort(); setBusy(true); setError(""); setNotice("");
        try {
            const result = await onChange(operation);
            if (!mounted.current) return;
            setSource(result); setKnown(true);
            setNotice(operation.kind === "open" ? "维护范围已开启。回到下方原聊天框描述修复要求；尚未发送任务。" : operation.kind === "close" ? "已回到原创作工具范围，未自动发送或重放任务。" : "已核对磁盘哈希，未应用补丁、恢复权限或更新服务。");
            if (operation.kind === "open") { setSelected([]); setPurpose(""); }
        } catch (error) {
            if (mounted.current) { setError(`${explain(error)} 请只读刷新并核对原范围；不要重复开启。`); setKnown(false); }
        } finally { lock.current = false; if (mounted.current) setBusy(false); }
    };
    const record = source?.record;
    return <div className="shrink-0 px-4 pb-2 text-xs" data-canvas-no-zoom>
        <Button size="small" icon={<CodeXml size={14} />} disabled={!connected} onClick={() => setOpen(true)}>
            {active ? "源码维护中 · 范围与回执" : "源码维护"}
        </Button>
        {active ? <p className="mt-1 text-muted-foreground">当前仅能维护选定源码，创作按钮暂停；退出维护后继续作品。</p> : null}
        <Modal title="在原会话中维护源码" open={open} onCancel={() => setOpen(false)} footer={null} width={720}
            className="source-maintenance-dialog" styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}>
            <div className="space-y-4 text-sm leading-relaxed" data-canvas-no-zoom data-canvas-wheel-scroll>
                <p className="text-muted-foreground">仅适用于本机开发者。限定最多 5 个已有文件；不访问作品或密钥，不安装依赖，不自动运行检查、提交、打包或重启。开关只切换权限，聊天草稿和历史不变。</p>
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="small" icon={<RefreshCw size={14} />} disabled={busy || !connected} onClick={() => void refresh()}>只读刷新状态</Button>
                    <span>{!connected ? "连接已断开" : !known ? "状态待核对" : workspace ? `${workspace.branch} · ${workspace.head.slice(0, 8)} · ${workspace.trackedClean ? "源码已提交" : "含未提交修改"}` : ""}</span>
                </div>
                {error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                {known && !record && uncertain ? <Button disabled={disabled || busy || !connected} onClick={() => void change({ kind: "close" })}>核对并恢复创作权限</Button> : null}
                {record ? <section className="space-y-2 rounded-lg border border-border p-3" aria-label="维护回执">
                    <div className="flex flex-wrap items-center gap-2"><Tag>{!known || !connected ? "历史记录 · 当前状态待核对" : record.status === "closed" ? "已结束范围" : source?.live ? "维护范围有效" : "历史范围 · 权限不可用"}</Tag><span>服务尚未更新</span></div>
                    <p className="break-words">{record.purpose}</p>
                    <p className="text-xs text-muted-foreground">有效期至 {new Date(record.expiresAt).toLocaleString()}；历史回执不代表当前权限。</p>
                    {record.files.map(file => <div key={file.path} className="break-all font-mono text-xs" title={file.currentHash}>{file.path} · {file.currentHash.slice(0, 12)}</div>)}
                    <details><summary className="cursor-pointer">补丁回执 · {record.patches.length} 项</summary>
                        {record.patches.length ? record.patches.map(patch => <div key={patch.requestId} className="my-2 break-all rounded border border-border p-2 text-xs">
                            <p>{patch.path} · {{ prepared: "已预览，未应用", applying: "结果待核对，不重复写入", applied: "已应用并回读", not_applied: "已核对未应用" }[patch.status]}</p>
                            <p>请求：{patch.requestId}</p><p>之前：{patch.beforeHash}</p><p>之后：{patch.afterHash}</p>
                        </div>) : <p>尚无补丁；开启范围本身不修改源码。</p>}
                    </details>
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={!known || disabled || busy || !connected} onClick={() => void change({ kind: "reconcile" })}>核对磁盘，不重写</Button>
                        <Button disabled={!known || disabled || busy || !connected} onClick={() => void change({ kind: "close" })}>{record.status === "closed" ? "核对并恢复创作权限" : "结束维护，返回创作"}</Button>
                    </div>
                </section> : null}
                {known && !uncertain && record?.status !== "active" ? <section className="space-y-3" aria-label="开启维护范围">
                    <label className="block">本次要修复什么<Input.TextArea aria-label="维护目标" value={purpose} maxLength={1000} autoSize={{ minRows: 2, maxRows: 4 }} disabled={disabled || busy} onChange={event => setPurpose(event.target.value)} placeholder="描述可核验的小范围问题，不填作品正文或凭据" /></label>
                    <label className="block">源码路径前缀<Input.Search aria-label="源码路径前缀" value={prefix} onChange={event => setPrefix(event.target.value)} onSearch={() => void listFiles()} disabled={busy || !connected} enterButton="查找文件" /></label>
                    {files.length ? <div className="max-h-48 overflow-y-auto rounded-lg border border-border" data-canvas-wheel-scroll>
                        {files.map(path => { const chosen = selected.some(file => file.path === path); return <button type="button" key={path} aria-pressed={chosen} disabled={disabled || busy || (!chosen && selected.length >= 5)} onClick={() => void selectFile(path)} className="block w-full break-all border-b border-border px-3 py-2 text-left font-mono text-xs hover:bg-muted focus-visible:outline-2 disabled:opacity-50">
                            {chosen ? "✓ " : "+ "}{path}
                        </button>; })}
                    </div> : <p className="text-muted-foreground">查找当前源码中的受支持文件，再选定本次范围。</p>}
                    {nextOffset !== null ? <Button size="small" disabled={busy || !connected} onClick={() => void listFiles(nextOffset)}>加载更多文件</Button> : null}
                    <div className="space-y-1"><p>已选 {selected.length} / 5 · 开启时再次核对哈希</p>{selected.map(file => <div key={file.path} className="flex gap-2 text-xs"><span className="min-w-0 flex-1 break-all" title={file.expectedHash}>{file.path}</span><Button size="small" disabled={busy || disabled} onClick={() => setSelected(files => files.filter(item => item.path !== file.path))}>移除</Button></div>)}</div>
                    <Button type="primary" loading={busy} disabled={disabled || !connected || !purpose.trim() || !selected.length} onClick={() => void change({ kind: "open", input: { requestId: crypto.randomUUID(), purpose: purpose.trim(), files: selected } })}>在原会话开启维护范围</Button>
                </section> : null}
            </div>
        </Modal>
    </div>;
}

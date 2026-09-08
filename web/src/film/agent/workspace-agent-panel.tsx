import { Suspense, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { Button, Drawer } from "antd";
import { Bot, PanelRightClose } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { useLocalRuntimeStore } from "@/stores/use-local-runtime-store";
import { prepareCanvasRuntimeConnection } from "@/lib/canvas/local-runtime-connection";
import { YingceLocalAgentPanel } from "@/film/adapters/yingce/contributions/agent-panel";
import { buildYingceWorkspaceContext, publishYingceWorkbenchContext } from "@/film/adapters/yingce/contributions/workbench-context-publisher";
import { useAccountAgentClient } from "./use-account-agent-client";
import { buildWorkspaceAgentSnapshot, workspaceAgentPage } from "./workspace-agent-context";

export function WorkspaceAgentEntry() {
    const userId = useUserStore(state => state.user?.id);
    const { pathname } = useLocation();
    return userId && workspaceAgentPage(pathname) ? <WorkspaceAgentPanel key={userId} pathname={pathname} /> : null;
}

function WorkspaceAgentPanel({ pathname }: { pathname: string }) {
    const client = useAccountAgentClient();
    const [open, setOpen] = useState(false);
    const [activated, setActivated] = useState(false);
    const [retry, setRetry] = useState(0);
    const [scope, setScope] = useState<{ workspaceId?: string; error?: string }>({});
    const page = workspaceAgentPage(pathname)!;
    useEffect(() => {
        if (!activated) return;
        const controller = new AbortController();
        setScope({});
        void (async () => {
            await prepareCanvasRuntimeConnection(useLocalRuntimeStore, controller.signal);
            const { workspaceId } = await client.getWorkspace(controller.signal);
            if (!/^[A-Za-z0-9_-]{1,120}$/.test(workspaceId)) throw new Error("工作区身份未确认");
            if (!controller.signal.aborted) setScope({ workspaceId });
        })().catch(error => {
            if (!controller.signal.aborted) setScope({ error: error instanceof Error ? error.message : "本机工作区连接失败" });
        });
        return () => controller.abort();
    }, [activated, retry, client]);
    const snapshot = useMemo(() => scope.workspaceId ? buildWorkspaceAgentSnapshot(scope.workspaceId, pathname) : undefined, [scope.workspaceId, pathname]);
    const context = useMemo(() => snapshot ? buildYingceWorkspaceContext(snapshot) : undefined, [snapshot]);
    useLayoutEffect(() => publishYingceWorkbenchContext(context), [context]);
    return <>
        <Button size="small" type="text" icon={<Bot className="size-4" />} onClick={() => { setActivated(true); setOpen(true); }} aria-label="打开工作台 Codex" aria-expanded={open}>Codex</Button>
        <Drawer title="工作台 Codex" open={open} onClose={() => setOpen(false)} closable={false}
            extra={<Button size="small" type="text" icon={<PanelRightClose className="size-4" />} onClick={() => setOpen(false)} aria-label="收起工作台 Codex">收起</Button>}
            size="min(520px, 100vw)" mask={false} destroyOnHidden={false}
            styles={{ body: { padding: 0, display: "flex", flexDirection: "column", minHeight: 0 } }}>
            <div className="shrink-0 border-b border-border px-4 py-3 text-sm" aria-label="Codex 当前工作范围">
                <p className="font-medium text-foreground">全局工作台 · {page.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">尚未选中作品 · 可读取当前页面身份；作品编辑请进入项目。具体素材与设置内容暂未接入，不会读取密钥。</p>
            </div>
            {snapshot ? <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开 Codex 面板…</p>}>
                <YingceLocalAgentPanel embedded genericRuntime autoConnect snapshot={snapshot} canUndoOps={false}
                    onApplyOps={async () => { throw new Error("当前没有绑定项目或画布，未执行画布操作"); }} onUndoOps={() => null} />
            </Suspense> : <div className="p-4 text-sm text-muted-foreground" role="status">
                <p>{scope.error || "正在确认本机工作区…"}</p>
                {scope.error ? <Button className="mt-3" onClick={() => setRetry(value => value + 1)}>重新连接工作区</Button> : null}
            </div>}
        </Drawer>
    </>;
}

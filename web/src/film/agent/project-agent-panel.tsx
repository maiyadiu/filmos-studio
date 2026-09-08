import { Suspense, useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Drawer } from "antd";
import { Bot, PanelRightClose } from "lucide-react";

import type { ProjectDetail } from "@/services/api/projects";
import { YingceLocalAgentPanel } from "@/film/adapters/yingce/contributions/agent-panel";
import { buildYingceProjectContext, publishYingceWorkbenchContext } from "@/film/adapters/yingce/contributions/workbench-context-publisher";
import { buildProjectAgentSnapshot, type ProjectChapterContext } from "./project-agent-context";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { useUserStore } from "@/stores/use-user-store";

export function ProjectAgentPanel({ detail, activePanel, chapter }: {
    detail: ProjectDetail;
    activePanel: string;
    chapter?: ProjectChapterContext | null;
}) {
    const [open, setOpen] = useState(false);
    const characterAction = useCanvasAgentStore(state => state.characterAction);
    const userId = useUserStore(state => state.user?.id);
    useLayoutEffect(() => {
        if (characterAction?.status === "queued" && characterAction.userId === userId && characterAction.projectId === detail.project.id) setOpen(true);
    }, [characterAction?.id, characterAction?.status, userId, detail.project.id]);
    const queryClient = useQueryClient();
    const snapshot = useMemo(() => buildProjectAgentSnapshot(detail, activePanel, chapter), [detail, activePanel, chapter]);
    const context = useMemo(() => buildYingceProjectContext(snapshot), [snapshot]);
    useLayoutEffect(() => publishYingceWorkbenchContext(context), [context]);
    const refreshProject = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: ["project", detail.project.id] });
        void queryClient.invalidateQueries({ queryKey: ["project-unit", detail.project.id] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }, [detail.project.id, queryClient]);
    const unit = detail.units.find(item => item.id === snapshot.contentUnitId);
    return <>
        <Button size="small" icon={<Bot className="size-4" />} className="!h-9 !shrink-0" onClick={() => setOpen(true)} aria-label="打开项目 Codex" aria-expanded={open}>Codex</Button>
        <Drawer title="项目 Codex" open={open} onClose={() => setOpen(false)} closable={false}
            extra={<Button size="small" type="text" icon={<PanelRightClose className="size-4" />} onClick={() => setOpen(false)} aria-label="收起项目 Codex">收起</Button>}
            size="min(520px, 100vw)" mask={false} destroyOnHidden={false}
            styles={{ body: { padding: 0, display: "flex", flexDirection: "column", minHeight: 0 } }}>
            <div className="shrink-0 border-b border-border px-4 py-3 text-sm" aria-label="Codex 当前工作范围">
                <p className="truncate font-medium text-foreground">{detail.project.name}{unit ? ` · ${unit.title}` : " · 项目全局"}</p>
                <p className="mt-1 text-xs text-muted-foreground">{snapshot.blockers?.length ? snapshot.blockers.join("；") : "当前项目的已保存内容 · 画布操作请进入对应章节画布"}</p>
            </div>
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在打开 Codex 面板…</p>}>
                <YingceLocalAgentPanel embedded genericRuntime autoConnect snapshot={snapshot} canUndoOps={false}
                    onProjectChanged={refreshProject} onApplyOps={async () => { throw new Error("请进入真实章节画布后操作画布"); }} onUndoOps={() => null} />
            </Suspense>
        </Drawer>
    </>;
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button } from "antd";
import { FolderOpen } from "lucide-react";
import { exportProjectDirectory, getProjectDirectoryStatus, openProjectDirectory, relocateProjectDirectory, syncProjectDirectory } from "@/services/api/project-directories";
import { useUserStore } from "@/stores/use-user-store";

export function ProjectDirectoryStatus({ projectId, revision }: { projectId: string; revision: number }) {
    const local = useUserStore((s) => s.authMode === "desktop_local");
    const userId = useUserStore((s) => s.user?.id);
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [exportedPath, setExportedPath] = useState("");
    const query = useQuery({ queryKey: ["project-directory", userId, projectId, revision], queryFn: () => getProjectDirectoryStatus(projectId), enabled: local });
    if (!local) return null;
    const run = async (operation: () => Promise<unknown>) => {
        setBusy(true);
        try { await operation(); await query.refetch(); }
        catch (error) { message.error(error instanceof Error ? error.message : "目录操作未完成"); await query.refetch(); }
        finally { setBusy(false); }
    };
    if (query.isError) return <div className="border-b border-border px-4 py-2 text-sm" role="alert">暂时无法确认作品目录状态 <Button size="small" onClick={() => void query.refetch()}>重试</Button></div>;
    if (!query.data?.managed) return null;
    const ready = query.data.state === "ready";
    return <section className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-sm text-foreground" aria-label="本地作品目录">
        <FolderOpen className="size-4 shrink-0" />
        <div className="min-w-0 flex-[1_1_15rem]"><details><summary className="cursor-pointer break-words text-sm font-medium">作品目录 · {query.data.path?.split("/").at(-1)}</summary><p className="mt-1 break-all text-xs text-muted-foreground">{query.data.path}</p></details>
            {!ready ? <p className="mt-1 text-sm" role="alert">{query.data.message || "业务记录与目录尚未确认同步，请重试目录同步；不要重复创建内容。"}</p> : <p className="text-xs text-muted-foreground">上次检查已同步 · 内容通过工作台编辑，目录不自动导入手工修改</p>}
            {exportedPath ? <p className="mt-1 break-all text-xs" role="status" title={exportedPath}>已保存至本作品的 导出/{exportedPath.split("/").at(-1)}（内容包，不含数据库）</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
        <Button size="small" disabled={busy} onClick={() => void run(() => openProjectDirectory(projectId))}>打开文件夹</Button>
        <Button size="small" disabled={busy} onClick={() => void query.refetch()}>检查状态</Button>
        {ready ? <Button size="small" loading={busy} onClick={() => void run(async () => { const result = await exportProjectDirectory(projectId); setExportedPath(result.path); })}>导出内容包</Button> : null}
        {!ready ? <><Button size="small" loading={busy} onClick={() => void run(() => syncProjectDirectory(projectId))}>重试同步</Button><Button size="small" disabled={busy} onClick={() => void run(() => relocateProjectDirectory(projectId))}>重新定位原目录</Button></> : null}
        </div>
    </section>;
}

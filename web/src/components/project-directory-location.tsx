import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button } from "antd";
import { FolderOpen } from "lucide-react";
import { chooseProjectDirectory, getProjectDirectoryLocation, setDefaultProjectDirectory, type ProjectDirectoryLocation } from "@/services/api/project-directories";
import { useUserStore } from "@/stores/use-user-store";
import { projectDirectoryPreview } from "@/lib/project-directory";

export function ProjectDirectoryLocation({ selected, onSelect, settings = false, projectName = "", requestId = "" }: {
    selected?: ProjectDirectoryLocation;
    onSelect?: (location?: ProjectDirectoryLocation) => void;
    settings?: boolean;
    projectName?: string;
    requestId?: string;
}) {
    const { message } = App.useApp();
    const client = useQueryClient();
    const userId = useUserStore((s) => s.user?.id);
    const local = useUserStore((s) => s.authMode === "desktop_local");
    const location = useQuery({ queryKey: ["project-directory-location", userId], queryFn: getProjectDirectoryLocation, enabled: local });
    const [choosing, setChoosing] = useState(false);
    const [preview, setPreview] = useState("");
    const parent = selected?.selectedParent || location.data?.defaultParent || "";
    useEffect(() => {
        let current = true;
        setPreview("");
        void projectDirectoryPreview(parent, projectName, userId || "", requestId).then((value) => { if (current) setPreview(value); }).catch(() => {});
        return () => { current = false; };
    }, [parent, projectName, userId, requestId]);
    if (!local) return null;
    const choose = async () => {
        setChoosing(true);
        try {
            const result = await chooseProjectDirectory();
            if (result.cancelled) return;
            if (!result.locationToken || !result.selectedParent) throw new Error("系统未返回有效的目录选择");
            if (settings) {
                await setDefaultProjectDirectory(result.locationToken);
                await client.invalidateQueries({ queryKey: ["project-directory-location", userId] });
                message.success("默认位置已更新，已有项目位置不变");
            } else onSelect?.(result);
        } catch (error) { message.error(error instanceof Error ? error.message : "目录选择失败"); }
        finally { setChoosing(false); }
    };
    return <section className="mb-4 rounded-xl border border-border bg-muted/30 p-4 text-foreground" aria-label="作品保存位置">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{settings ? "新项目默认位置" : "作品保存位置"}</span>
            <Button icon={<FolderOpen className="size-4" />} loading={choosing} onClick={() => void choose()}>选择文件夹</Button>
        </div>
        {location.isError ? <div role="alert"><p>暂时无法读取默认项目位置</p><Button size="small" onClick={() => void location.refetch()}>重试</Button></div> : <p className="break-all text-sm">{selected?.selectedParent || location.data?.defaultParent || "正在读取系统位置…"}</p>}
        <p className="mt-2 text-sm text-muted-foreground">{settings ? "只影响以后新建的项目，不移动已有作品。" : "将在此位置建立独立作品目录；剧本、分镜、提示词及素材按统一结构保存。"}</p>
        {!settings && preview ? <p className="mt-2 break-all text-sm">最终项目目录：{preview}</p> : null}
        {!settings && selected ? <Button type="link" className="!px-0" onClick={() => onSelect?.(undefined)}>恢复默认位置</Button> : null}
    </section>;
}

import { useRef, useState } from "react";
import { App, Radio } from "antd";
import { useNavigate } from "react-router";
import { getProjectShotContext } from "@/services/api/projects";
import { acquireSyncedChapterCanvas, syncSyncedProjectStoryboard } from "@/services/user-data-sync";

export function useChapterCanvas(projectId: string, refreshProject: () => void) {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const pending = useRef(false);
    const [openingUnitId, setOpeningUnitId] = useState("");
    const openChapterCanvas = async (unitId: string, importShots = false) => {
        if (pending.current) return;
        pending.current = true;
        setOpeningUnitId(unitId);
        try {
            let result = await acquireSyncedChapterCanvas(projectId, unitId);
            if (result.disposition === "selection_required") {
                let selected = "";
                const confirmation = modal.confirm({
                    title: "选择本章唯一画布入口",
                    content: <div className="space-y-3"><p>本章已有多个历史画布。选择后所有章节入口使用同一个画布；其他历史画布及内容保留，不合并、不删除。</p><Radio.Group className="flex flex-col gap-2" onChange={event => { selected = event.target.value; confirmation.update({ okButtonProps: { disabled: false } }); }} options={result.candidates!.map(canvas => ({ value: canvas.id, label: `${canvas.title} · ${canvas.id.slice(0, 8)}` }))} /></div>,
                    okText: "使用所选画布", cancelText: "暂不选择",
                    okButtonProps: { disabled: true },
                    onOk: () => selected ? undefined : Promise.reject(new Error("请先选择一个历史画布")),
                });
                const confirmed = await confirmation;
                if (!confirmed) return;
                result = await acquireSyncedChapterCanvas(projectId, unitId, selected);
            }
            if (!result.canvas) throw new Error("尚未取得本章画布");
            const canvasId = result.canvas.id;
            if (result.localPending) {
                if (importShots) throw new Error("画布仍有本地修改，请先保存或核对；未导入分镜、未覆盖内容");
                message.info("已打开本章画布，保留其中尚未同步的本地修改");
            } else if (importShots || result.disposition === "created") {
                const context = await getProjectShotContext(projectId, unitId);
                if (importShots && !context.shots.length) throw new Error("本章没有可导入的已保存分镜，画布已保留");
                if (context.shots.length) {
                    if (context.staleShotIds.length) throw new Error("分镜来源剧本已过期，请先核对；未导入画布");
                    const synced = await syncSyncedProjectStoryboard(canvasId, { projectId, unitId, expectedShotRevision: context.unit.shotRevision, sourceRevision: context.unit.revision, sourceHash: context.sourceHash });
                    if (!synced.verification.ok) throw new Error(synced.issue || "分镜已保存但核对未完成，请回读");
                }
            }
            refreshProject();
            navigate(`/canvas/${canvasId}`);
        } catch (error) {
            refreshProject();
            message.error(error instanceof Error ? error.message : "章节画布打开失败");
        } finally {
            pending.current = false;
            setOpeningUnitId("");
        }
    };
    return { openChapterCanvas, openingUnitId };
}

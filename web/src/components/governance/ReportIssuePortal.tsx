import { App, Badge, Button, Checkbox, Input, Modal, Tag, Upload } from "antd";
import type { UploadFile } from "antd";
import type { RcFile } from "antd/es/upload/interface";
import { Bug, Paperclip, Send } from "lucide-react";
import { useEffect, useMemo, useState, type ClipboardEvent } from "react";

import { currentBuildIdentity, releaseChannelLabel, shortSourceHash } from "@/film/governance/build-identity";
import { createLocalIssueDraft, issueEvidenceFilesFromClipboard, pastedIssueUploadDescriptor, saveIssueDraft, selectPastedIssueEvidence, type IssueAttachment, type IssueSurface } from "@/film/governance/report-issue";

export function ReportIssuePortal() {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [occurred, setOccurred] = useState("");
    const [expected, setExpected] = useState("");
    const [blocking, setBlocking] = useState(false);
    const [files, setFiles] = useState<UploadFile[]>([]);
    const [saving, setSaving] = useState(false);
    const [surface, setSurface] = useState<IssueSurface>();
    const build = useMemo(() => currentBuildIdentity(), []);

    useEffect(() => {
        window.filmOSReportIssue = (requestedSurface) => {
            setSurface(requestedSurface);
            setOpen(true);
        };
        return () => {
            delete window.filmOSReportIssue;
        };
    }, []);

    useEffect(() => {
        const notifyReplay = (event: Event) => {
            const detail = (event as CustomEvent<{ issueId?: string }>).detail;
            if (detail?.issueId) message.warning(`${detail.issueId} 仍在本机等待 Review Bus，应用会继续重试`);
        };
        window.addEventListener("filmos:review-issue-replay", notifyReplay);
        return () => window.removeEventListener("filmos:review-issue-replay", notifyReplay);
    }, [message]);

    const reset = () => {
        setOccurred("");
        setExpected("");
        setBlocking(false);
        setFiles([]);
        setSurface(undefined);
    };

    const submit = async () => {
        setSaving(true);
        try {
            const attachments = files.flatMap<IssueAttachment>((file) => file.originFileObj ? [{
                id: file.uid,
                name: file.name,
                mediaType: file.type || "application/octet-stream",
                size: file.size || file.originFileObj.size,
                content: file.originFileObj,
            }] : []);
            const saved = await saveIssueDraft(createLocalIssueDraft({ occurred, expected, blocking, attachments }, { surface }));
            message.success(saved.delivery === "REVIEW_BUS_ACCEPTED" ? `已创建 ${saved.issueId}` : `已在本机保存 ${saved.issueId}，待 Review Bus 接收`);
            setOpen(false);
            reset();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "问题记录失败");
        } finally {
            setSaving(false);
        }
    };

    const pasteAttachments = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const pasted = selectPastedIssueEvidence(issueEvidenceFilesFromClipboard(event.clipboardData), files.length);
        if (!pasted.accepted.length && !pasted.oversizedCount && !pasted.truncatedCount) return;
        event.preventDefault();
        if (pasted.oversizedCount) message.error("单个截图或录屏不能超过25MB");
        setFiles((current) => [...current, ...pasted.accepted.map<UploadFile>((file) => {
            const uid = `paste-${crypto.randomUUID()}`;
            const descriptor = pastedIssueUploadDescriptor(file, uid);
            return {
                uid: descriptor.uid,
                name: descriptor.name,
                type: descriptor.mediaType,
                size: descriptor.size,
                originFileObj: descriptor.file as RcFile,
                status: descriptor.status,
            };
        })]);
        if (pasted.truncatedCount) message.warning("最多保留5个截图或录屏");
    };

    return (
        <>
            <div className="fixed bottom-5 right-5 z-[1050] flex flex-col items-end gap-1.5" data-filmos-issue-intake>
                <Button type="primary" shape="round" size="large" icon={<Bug className="size-4" />} onClick={() => window.filmOSReportIssue?.()}>报告问题 / 提出调整</Button>
                <button type="button" className="rounded-full border border-border bg-background/92 px-2.5 py-1 text-[10px] tabular-nums text-foreground/55 shadow-sm backdrop-blur" onClick={() => window.filmOSReportIssue?.()} title={`Commit ${build.commit}\nTree ${build.tree}\nBuild ${build.buildId}`}>
                    <Badge status={build.externalPaidSubmitEnabled ? "warning" : "success"} />
                    {releaseChannelLabel(build.channel)} · {shortSourceHash(build.commit)} · {build.buildId}
                </button>
            </div>
            <Modal
                title={<div className="flex items-center gap-2"><Bug className="size-4" /><span>报告问题 / 提出调整</span><Tag>{releaseChannelLabel(build.channel)}</Tag></div>}
                open={open}
                width={620}
                okText="保存问题"
                cancelText="取消"
                confirmLoading={saving}
                okButtonProps={{ icon: <Send className="size-4" /> }}
                onOk={() => void submit()}
                onCancel={() => setOpen(false)}
                destroyOnHidden
            >
                <div className="space-y-5 py-2">
                    <p className="text-xs leading-5 text-foreground/55">只需描述现场，也可以直接在输入框粘贴截图。FilmOS 会附带当前项目、画布、选中节点和构建身份；证据只写入本机 Review Bus，不调用模型 API、付费 Provider、素材上传或外部项目创建。</p>
                    <label className="block"><span className="mb-2 block text-sm font-medium">发生了什么</span><Input.TextArea value={occurred} onChange={(event) => setOccurred(event.target.value)} onPaste={pasteAttachments} autoSize={{ minRows: 3, maxRows: 8 }} maxLength={4000} showCount placeholder="例如：在画布 Agent 中点击连接后显示……（可直接粘贴截图）" /></label>
                    <label className="block"><span className="mb-2 block text-sm font-medium">我本来想达到什么</span><Input.TextArea value={expected} onChange={(event) => setExpected(event.target.value)} onPaste={pasteAttachments} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={4000} showCount placeholder="描述期望结果，不需要判断是 Bug 还是架构问题" /></label>
                    <Checkbox checked={blocking} onChange={(event) => setBlocking(event.target.checked)}>这个问题正在阻止我继续工作</Checkbox>
                    <div>
                        <Upload beforeUpload={() => false} fileList={files} accept="image/*,video/*" maxCount={5} onChange={({ fileList }) => setFiles(fileList)}>
                            <Button icon={<Paperclip className="size-4" />}>添加截图或录屏</Button>
                        </Upload>
                        <p className="mt-2 text-[11px] text-foreground/42">支持按钮选择或直接粘贴；最多5个、单个不超过25MB。原始字节进入本机 Review Bus 证据库，ChatGPT 只读取脱敏别名与安全摘要。</p>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/35 px-3 py-2 text-[11px] leading-5 text-foreground/52">
                        Build: {releaseChannelLabel(build.channel)} / {build.buildId}<br />Commit: {shortSourceHash(build.commit)} / Tree: {shortSourceHash(build.tree)}<br />Paid Submit: {build.externalPaidSubmitEnabled ? "必须另行授权" : "已禁用"}
                    </div>
                </div>
            </Modal>
        </>
    );
}

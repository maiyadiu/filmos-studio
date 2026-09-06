import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Tag } from "antd";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { documentTextFromHtml } from "@/lib/document-text";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { ShotImageSnapshot } from "@/lib/canvas/agent-creative-results";
import { loadShotImagePreview } from "@/services/api/project-shot-image";

export function AgentShotImageView({ evidence, shotNumber, current, onClose }: { evidence: ShotImageSnapshot; shotNumber: number; current: () => CanvasAgentSnapshot; onClose: () => void }) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const [reading] = useState(evidence);
    const currentRef = useRef(current); currentRef.current = current;
    const { binding, image, constraints } = reading;
    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25_000);
        let objectUrl = "";
        let alive = true;
        void loadShotImagePreview(reading, () => currentRef.current(), controller.signal).then(blob => {
            if (controller.signal.aborted) return;
            objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
        }).catch(() => {
            if (alive) setError("未能核验这次诊断所用的原图。资源可能已变化、不可读或当前项目已切换；未用其他图片替代。关闭后可重试。");
        }).finally(() => clearTimeout(timeout));
        return () => { alive = false; controller.abort(); clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [reading]);
    const directionText = Object.entries(constraints.direction).filter(([, value]) => value !== "" && value != null && (!Array.isArray(value) || value.length > 0))
        .map(([key, value]) => `${directionLabels[key] || key}：${directionValue(value)}`).join("\n\n");
    return <Modal open title={`第 ${shotNumber} 镜 · 本次看图依据`} onCancel={onClose} width={1080} footer={<Button onClick={onClose}>关闭</Button>} destroyOnHidden>
        <div className="space-y-4 text-foreground" data-canvas-no-zoom data-canvas-wheel-scroll>
            <Alert type="info" showIcon title="只读历史快照 · 图片未修改" description="显示本次诊断读取的原图及当时要求，不代表当前镜头、图片创建谱系或 QC 批准。新的修改必须重新读取当前来源。" />
            <div className="flex flex-wrap gap-2"><Tag>剧本 v{binding.sourceRevision}</Tag><Tag>镜头 v{binding.shotRevision}</Tag><span className="text-sm text-muted-foreground">读取于 {new Date(evidence.capturedAt).toLocaleString()}</span></div>
            <div className="grid gap-4 md:grid-cols-2">
                <section className="min-w-0 space-y-3" aria-label="诊断所用原图">
                    {error ? <Alert type="warning" showIcon title="原图尚未取得" description={error} /> : url ? <img src={url} alt={`第 ${shotNumber} 镜本次诊断所用原图`} className="max-h-[48vh] w-full rounded-lg border border-border bg-muted object-contain" /> : <p role="status" className="py-16 text-center text-muted-foreground">正在核验原图字节与哈希……</p>}
                    <p className="break-all text-xs leading-5 text-muted-foreground">图片 SHA-256：{image.sha256}<br />资源：{binding.resourceId} · {image.width} × {image.height}<br />镜头：{binding.shotId}<br />图片节点：{binding.imageNodeId}</p>
                </section>
                <section className="thin-scrollbar max-h-[58vh] min-w-0 space-y-4 overflow-auto rounded-lg border border-border p-4 text-sm leading-7 [&_.ai-message-markdown-paragraph]:whitespace-pre-line" aria-label="本次读取的约束依据">
                    <h3 className="font-medium">完整剧本 · 读取时版本</h3>
                    <AIMessageMarkdown>{documentTextFromHtml(constraints.scriptText)}</AIMessageMarkdown>
                    <h3 className="font-medium">镜头与画布要求</h3>
                    <AIMessageMarkdown>{documentTextFromHtml(directionText || "未记录额外画布要求，请参阅完整剧本。")}</AIMessageMarkdown>
                    <details><summary className="cursor-pointer">精确业务镜头及素材记录</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify({ shot: constraints.shot, assets: constraints.assets }, null, 2)}</pre></details>
                    <p className="break-all text-xs text-muted-foreground">章节：{binding.sourceUnitId}<br />正文 SHA-256：{binding.sourceHash}</p>
                </section>
            </div>
        </div>
    </Modal>;
}

const directionLabels: Record<string, string> = { camera: "机位与构图", performanceBlocking: "表演与调度", scene: "场景", characters: "角色", action: "动作", dialogue: "对白", description: "镜头描述", imagePrompt: "图片提示词", imageGenerationPrompt: "图片提示词", videoMotionPrompt: "视频提示词", assetBindings: "素材绑定", audioEffects: "声音", continuityOut: "出镜连续性", durationSeconds: "时长（秒）", emotion: "情绪", lightingAndAtmosphere: "灯光与氛围", motion: "运动", mustHave: "必须保留", narrativeIntent: "叙事目的", negativePrompt: "避免内容", optionalDetails: "可选细节", plotDescription: "剧情", shotNumber: "镜号", shotSize: "景别", timeBeats: "时间节拍", viewerPOV: "观察视角" };
function directionValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(directionValue).join("、");
    if (value && typeof value === "object") {
        const character = value as { characterName?: unknown };
        if (typeof character.characterName === "string") return character.characterName;
        return JSON.stringify(value);
    }
    return String(value);
}

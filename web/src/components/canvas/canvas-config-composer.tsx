import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Alert, Button, Image, Select, Tag } from "antd";
import { FileText, Image as ImageIcon, Music2, Pencil, Sparkles, Video, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { isCanvasWorkflowProvider } from "@/lib/canvas/canvas-workflow";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { NodeGenerationInput } from "./canvas-node-generation";
import { CanvasVideoPromptTools } from "./canvas-video-prompt-tools";
import { CanvasPresetPicker, type CanvasPromptPreset } from "./canvas-preset-picker";
import type { CanvasGenerationMode, CanvasNodeMetadata, CanvasWorkspaceMode } from "@/types/canvas";
import { useLocalDreaminaModelStore } from "@/stores/use-local-dreamina-model-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { createGenerationRoutePreviewHash } from "@/film/generation-routing/preview-contract";

type CanvasConfigComposerProps = {
    value: string;
    inputs: NodeGenerationInput[];
    skillReferences?: CanvasResourceReference[];
    generationMode?: CanvasGenerationMode;
    metadata?: CanvasNodeMetadata;
    onChange: (value: string) => void;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onClose: () => void;
    workspaceMode?: CanvasWorkspaceMode;
};

type Token =
    | { type: "text"; value: string }
    | { type: "reference"; nodeId: string };

type MentionState = {
    query: string;
};

type ComposerCandidate =
    | {
          kind: "input";
          input: NodeGenerationInput;
      }
    | {
          kind: "skill";
          reference: CanvasResourceReference;
      };

export const CONFIG_REFERENCE_PATTERN = /@\[node:([^\]]+)\]/g;

export function CanvasConfigComposer({ value, inputs, skillReferences = [], generationMode, metadata, onChange, onMetadataChange, onClose, workspaceMode = "professional" }: CanvasConfigComposerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [presetOpen, setPresetOpen] = useState(false);
    const simpleMode = workspaceMode === "simple";
    const workflowVideoReferenceMode = generationMode === "video" && isCanvasWorkflowProvider(metadata);
    const effectiveConfig = useEffectiveConfig();
    const dreaminaModels = useLocalDreaminaModelStore((state) => state.models);
    const tokens = useMemo(() => parseComposerTokens(value), [value]);
    const referenceById = useMemo(() => new Map(inputs.map((input) => [input.nodeId, input])), [inputs]);
    const videoFrameOptions = useMemo(
        () =>
            inputs
                .filter((input) => input.type === "image" && input.image)
                .map((input) => ({ nodeId: input.nodeId, label: resourceLabel(input, inputs), title: input.title, previewUrl: input.image?.dataUrl })),
        [inputs],
    );
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = (mention.query || "").trim().toLowerCase();
        const items: ComposerCandidate[] = [...skillReferences.map((reference) => ({ kind: "skill" as const, reference })), ...inputs.map((input) => ({ kind: "input" as const, input }))];
        if (!query) return items;
        return items.filter((item) => candidateSearchText(item, inputs).toLowerCase().includes(query));
    }, [inputs, mention, skillReferences]);

    useEffect(() => {
        if (document.activeElement === editorRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            const input = referenceById.get(token.nodeId);
            if (input) editor.append(createReferenceChip(input, inputs, theme, setImagePreview));
        });
    }, [inputs, referenceById, theme, tokens]);

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditor(editor);
        onChange(next);
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || (!inputs.length && !skillReferences.length)) {
            closeMention();
            return;
        }
        const nextQuery = match[1] || "";
        if (mention?.query !== nextQuery) {
            setMention({ query: nextQuery });
            setActiveIndex(0);
        }
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const insertCandidate = (candidate: ComposerCandidate) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const space = document.createTextNode(" ");
        const node = candidate.kind === "skill" ? document.createTextNode(`@${candidate.reference.label}`) : createReferenceChip(candidate.input, inputs, theme, setImagePreview);
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(node);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(node, space);
            placeCaretAtEnd(editor);
        }
        closeMention();
        onChange(serializeEditor(editor));
    };

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    const insertPreset = (preset: CanvasPromptPreset) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveSlash(editor);
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const text = document.createTextNode(`${preset.prompt} `);
        if (range && editor.contains(range.commonAncestorContainer)) {
            range.insertNode(text);
            range.setStartAfter(text);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(text);
            placeCaretAtEnd(editor);
        }
        onChange(serializeEditor(editor));
    };

    return (
        <div
            data-canvas-no-zoom
            className="canvas-config-composer aceternity-floating-panel rounded-xl p-4 backdrop-blur-2xl"
            style={{ background: theme.spatial.elevated, color: theme.node.text }}
            onMouseDown={stopCanvasInteraction}
            onPointerDown={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-xs font-semibold">{simpleMode ? "快速生成" : "组装提示词"}</div>
                    <div className="truncate text-[var(--fs-label)] opacity-55">{simpleMode ? "已连接素材会自动带入" : workflowVideoReferenceMode ? "已连接媒体会按工作流字段顺序自动带入" : "@ 引用已连接素材或已激活技能，发送前自动组装"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {simpleMode ? null : <CanvasPresetPicker mode={generationMode || "image"} skillReferences={skillReferences} open={presetOpen} onOpenChange={setPresetOpen} onSelect={insertPreset} />}
                    <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !p-0" icon={<X className="size-3.5" />} onClick={onClose} />
                </div>
            </div>
            {generationMode === "video" && onMetadataChange && !simpleMode ? (
                <div className="mb-3 rounded-lg px-2 py-2" style={{ background: theme.node.fill }}>
                    <CanvasVideoPromptTools
                        metadata={metadata}
                        frameOptions={videoFrameOptions}
                        referenceMode={workflowVideoReferenceMode ? "all" : "frames"}
                        referenceSummary={{
                            imageCount: inputs.filter((input) => input.type === "image" || input.type === "character").length,
                            videoCount: inputs.filter((input) => input.type === "video").length,
                            audioCount: inputs.filter((input) => input.type === "audio").length,
                        }}
                        onMetadataChange={onMetadataChange}
                    />
                </div>
            ) : null}
            {!simpleMode && onMetadataChange ? (
                <GenerationRouteComposer
                    mode={generationMode || "image"}
                    metadata={metadata}
                    prompt={value}
                    dreaminaModels={dreaminaModels}
                    runningHubWorkflows={effectiveConfig.runningHub.workflows.map((item) => ({ id: item.workflowId, label: item.title || item.workflowId, capability: item.capability }))}
                    comfyWorkflows={effectiveConfig.comfyBridge.workflows.map((item) => ({ id: item.workflowId, label: item.title || item.workflowId, capability: item.capability }))}
                    onChange={onMetadataChange}
                />
            ) : null}
            <div className="canvas-config-composer-editor relative rounded-lg" style={{ background: theme.node.fill }}>
                {!value.trim() ? <div className="pointer-events-none absolute left-4 top-3 text-sm leading-7" style={{ color: theme.node.placeholder }}>输入提示词，按 @ 引用连接素材或技能</div> : null}
                <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="thin-scrollbar min-h-32 max-h-[min(42vh,360px)] w-full overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 text-sm leading-7 outline-none"
                    style={{ color: theme.node.text }}
                    onInput={() => {
                        if (!composingRef.current) syncFromEditor();
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                        composingRef.current = false;
                        syncFromEditor();
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        event.stopPropagation();
                        if (event.key === "/" && !mention) window.setTimeout(() => setPresetOpen(true));
                        if (mention && candidates.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => (index + 1) % candidates.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                                return;
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                insertCandidate(candidates[Math.min(activeIndex, candidates.length - 1)]);
                                return;
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeMention();
                                return;
                            }
                        }
                        if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                            event.preventDefault();
                            requestAnimationFrame(syncFromEditor);
                            return;
                        }
                        requestAnimationFrame(syncMention);
                    }}
                    onBlur={() => window.setTimeout(closeMention, 120)}
                />
                {mention && candidates.length ? <MentionMenu candidates={candidates} allInputs={inputs} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertCandidate} /> : null}
            </div>
            {imagePreview ? <Image src={imagePreview} alt="引用图片预览" style={{ display: "none" }} preview={{ visible: true, src: imagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );

}

function GenerationRouteComposer({ mode, metadata, prompt, dreaminaModels, runningHubWorkflows, comfyWorkflows, onChange }: {
    mode: CanvasGenerationMode;
    metadata?: CanvasNodeMetadata;
    prompt: string;
    dreaminaModels: Array<{ id: string; displayName: string; modality: "image" | "video"; adapterSupported: boolean; currentlyObservedAvailable: "yes" | "no" | "unknown"; settings: { aspects: string[]; tiers?: string[] } }>;
    runningHubWorkflows: Array<{ id: string; label: string; capability?: string }>;
    comfyWorkflows: Array<{ id: string; label: string; capability?: string }>;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const engineId = metadata?.generationEngineId || "dreamina_cli";
    const draftVersion = metadata?.generationDraftVersion || 0;
    const [previewError, setPreviewError] = useState<string | null>(null);
    const invalidate = (patch: Partial<CanvasNodeMetadata>) => {
        setPreviewError(null);
        onChange({ ...patch, generationDraftVersion: draftVersion + 1, generationPreviewState: metadata?.generationPreviewHash ? "stale" : "draft", generationSubmissionState: "not_submitted" });
    };
    const modelOptions = dreaminaModels.filter((item) => item.modality === (mode === "video" ? "video" : "image") && item.adapterSupported).map((item) => ({ value: item.id, label: `${item.displayName}${item.currentlyObservedAvailable === "no" ? "（当前不可用）" : ""}`, disabled: item.currentlyObservedAvailable === "no" }));
    const workflowOptions = (engineId === "runninghub" ? runningHubWorkflows : comfyWorkflows).filter((item) => !item.capability || item.capability === mode).map((item) => ({ value: item.id, label: item.label }));
    const connectionId = engineId === "dreamina_cli" ? "dreamina-local" : engineId === "runninghub" ? "runninghub-default" : engineId === "comfyui" ? "comfyui-default" : engineId === "manual_web" ? "manual" : "flova-local";
    const previewReady = metadata?.generationPreviewState === "ready";
    return (
        <section className="mb-3 space-y-3 rounded-lg border p-3" style={{ borderColor: "var(--border)" }} aria-label="Generation Composer 路由">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">Generation Composer</strong><div className="flex gap-1"><Tag>Prompt</Tag><Tag>路线</Tag><Tag>规格</Tag><Tag>Reference</Tag><Tag>费用</Tag></div></div>
            <div className="grid gap-2 sm:grid-cols-2">
                <Select aria-label="生成引擎" value={engineId} options={[{ value: "dreamina_cli", label: "Dreamina CLI" }, { value: "flova_cli", label: "Flova CLI（F0 待核验）", disabled: true }, { value: "runninghub", label: "RunningHub" }, { value: "comfyui", label: "ComfyUI" }, { value: "manual_web", label: "Manual Web" }]} onChange={(value) => invalidate({ generationEngineId: value, generationConnectionId: value === "dreamina_cli" ? "dreamina-local" : value === "runninghub" ? "runninghub-default" : value === "comfyui" ? "comfyui-default" : "manual", generationModelId: undefined, generationWorkflowId: undefined })} />
                {engineId === "dreamina_cli" ? <Select aria-label="生成模型" value={metadata?.generationModelId} placeholder={modelOptions.length ? "选择运行时模型" : "目录尚未就绪"} options={modelOptions} onChange={(generationModelId) => invalidate({ generationModelId })} /> : engineId === "runninghub" || engineId === "comfyui" ? <Select aria-label="生成工作流" value={metadata?.generationWorkflowId} placeholder="选择工作流" options={workflowOptions} onChange={(generationWorkflowId) => invalidate({ generationWorkflowId })} /> : <Select aria-label="生成模型" disabled placeholder="人工模式不绑定模型" />}
                <Select aria-label="画面比例" value={metadata?.generationNativeSize || metadata?.size || "9:16"} options={["9:16", "16:9", "1:1"].map((value) => ({ value, label: value }))} onChange={(generationNativeSize) => invalidate({ generationNativeSize })} />
                <Select aria-label="交付分辨率" value={metadata?.generationDeliveryResolution || "native"} options={[{ value: "native", label: "Native Size" }, { value: "720p", label: "交付 720p" }, { value: "1080p", label: "交付 1080p" }]} onChange={(generationDeliveryResolution) => invalidate({ generationDeliveryResolution })} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs opacity-75"><span>Reference：{(metadata?.references?.length || 0)} 项 · Connection：{connectionId}</span><span>费用：{metadata?.generationEstimatedCost || "提交前由引擎估算；未知时逐次确认"}</span></div>
            {metadata?.generationPreviewState === "stale" ? <Alert type="warning" showIcon message="配置已变更，旧预览已 STALE" /> : null}
            {previewError ? <Alert type="error" showIcon message="预览合同生成失败" description={previewError} /> : null}
            {metadata?.generationSubmissionState === "awaiting_authorization" ? <Alert type="info" showIcon message="等待 Broker 授权" description="尚未提交 Provider，未产生费用。必须先生成 Catalog Validation、Budget Reservation 和 Broker Decision Receipt。" /> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs opacity-65">预览零费用；正式提交仍需 Catalog Validation、Broker Confirmation 与预算授权。</span>
                <div className="flex gap-2">
                    <Button size="small" type={previewReady ? "default" : "primary"} disabled={!prompt.trim() || (engineId === "dreamina_cli" && !metadata?.generationModelId) || ((engineId === "runninghub" || engineId === "comfyui") && !metadata?.generationWorkflowId)} onClick={() => {
                        setPreviewError(null);
                        void createGenerationRoutePreviewHash({
                            engineId,
                            connectionId,
                            mode,
                            ...(metadata?.generationModelId ? { modelId: metadata.generationModelId } : {}),
                            ...(metadata?.generationWorkflowId ? { workflowId: metadata.generationWorkflowId } : {}),
                            prompt,
                            nativeSize: metadata?.generationNativeSize || metadata?.size || "9:16",
                            deliveryResolution: metadata?.generationDeliveryResolution || "native",
                            draftVersion,
                        }).then((generationPreviewHash) => onChange({ generationPreviewHash, generationPreviewState: "ready", generationSubmissionState: "not_submitted" })).catch((error: unknown) => {
                            setPreviewError(error instanceof Error ? error.message : "GENERATION_ROUTE_PREVIEW_HASH_FAILED");
                            onChange({ generationPreviewHash: undefined, generationPreviewState: "draft", generationSubmissionState: "not_submitted" });
                        });
                    }}>{previewReady ? "预览已就绪" : "生成预览（零费用）"}</Button>
                    <Button size="small" disabled={!previewReady || metadata?.generationSubmissionState === "awaiting_authorization"} onClick={() => onChange({ generationSubmissionState: "awaiting_authorization" })}>提交（需授权）</Button>
                </div>
            </div>
        </section>
    );
}

function removeActiveSlash(editor: HTMLDivElement) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) return;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const value = node.textContent || "";
    const before = value.slice(0, range.startOffset);
    const match = /(^|\s)\/[\p{L}\p{N}_-]*$/u.exec(before);
    if (!match) return;
    node.textContent = `${before.slice(0, match.index)}${match[1]}${value.slice(range.startOffset)}`;
    range.setStart(node, match.index + match[1].length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function MentionMenu({ candidates, allInputs, activeIndex, theme, onSelect }: { candidates: ComposerCandidate[]; allInputs: NodeGenerationInput[]; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (candidate: ComposerCandidate) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, candidates]);

    const selectInput = (candidate: ComposerCandidate) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(candidate);
    };

    return (
        <div className="aceternity-floating-panel absolute left-2 top-[calc(100%+6px)] z-[var(--z-modal)] max-h-56 w-64 overflow-y-auto rounded-lg border p-1" style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border }}>
            {candidates.map((candidate, index) => (
                <button
                    key={candidate.kind === "skill" ? candidate.reference.id : candidate.input.nodeId}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectInput(candidate);
                    }}
                >
                    <ResourcePreview candidate={candidate} />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{candidate.kind === "skill" ? candidate.reference.label : resourceLabel(candidate.input, allInputs)}</span>
                        {candidate.kind !== "skill" ? <span className="block truncate opacity-65">{candidate.input.text || candidate.input.title}</span> : null}
                    </span>
                </button>
            ))}
        </div>
    );
}

function ResourcePreview({ candidate }: { candidate: ComposerCandidate }) {
    if (candidate.kind === "skill") {
        return (
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-cyan-500/12 text-cyan-600 dark:text-cyan-200">
                <Sparkles className="size-4" />
            </span>
        );
    }
    const input = candidate.input;
    if (input.sourceKind === "drawing") {
        return (
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
                <Pencil className="size-4" />
            </span>
        );
    }
    if (input.type === "image" && input.image) return <img src={input.image.dataUrl} alt="" className="size-9 rounded-md object-cover" />;
    if (input.type === "video" && input.video) return <video src={input.video.url} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function candidateSearchText(candidate: ComposerCandidate, inputs: NodeGenerationInput[]) {
    if (candidate.kind === "skill") return `技能 ${candidate.reference.label} ${candidate.reference.title} ${candidate.reference.text || ""}`;
    return `${resourceLabel(candidate.input, inputs)} ${candidate.input.title} ${candidate.input.text || ""}`;
}

function createReferenceChip(input: NodeGenerationInput, inputs: NodeGenerationInput[], theme: (typeof canvasThemes)[keyof typeof canvasThemes], onImagePreview: (url: string) => void) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.referenceNodeId = input.nodeId;
    wrapper.className = "mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
    Object.assign(wrapper.style, chipStyle(theme));
    if (input.type === "image" && input.image && input.sourceKind !== "drawing") {
        const image = document.createElement("img");
        image.src = input.image.dataUrl;
        image.alt = input.title;
        image.className = "size-6 rounded object-cover";
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.appendChild(image);
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(input.image?.dataUrl || "");
        });
    } else {
        wrapper.title = input.sourceKind === "drawing" ? resourceLabel(input, inputs) : input.text || input.title;
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = input.sourceKind === "drawing" ? resourceLabel(input, inputs) : input.type === "text" ? input.text || input.title : input.title;
        wrapper.appendChild(text);
    }
    return wrapper;
}

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const nodeId = node.dataset.referenceNodeId;
        if (nodeId) result += `@[node:${nodeId}]`;
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes);
    });
    return result;
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.referenceNodeId ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function parseComposerTokens(value: string): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(CONFIG_REFERENCE_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", nodeId: match[1] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function resourceLabel(input: NodeGenerationInput, inputs: NodeGenerationInput[]) {
    const sameTypeInputs = inputs.filter((item) => item.type === input.type && item.sourceKind === input.sourceKind);
    const index = Math.max(0, sameTypeInputs.findIndex((item) => item.nodeId === input.nodeId));
    if (input.sourceKind === "drawing") return `绘图${index + 1}`;
    if (input.type === "image") return `图片${index + 1}`;
    if (input.type === "video") return `视频${index + 1}`;
    if (input.type === "audio") return `音频${index + 1}`;
    return `文本${index + 1}`;
}

function chipStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]): CSSProperties {
    return { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text };
}

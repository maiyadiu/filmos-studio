import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelCapabilityConfigFor, normalizeImageValue } from "@/lib/model-capabilities";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    showCount?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", showCount = true }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const profile = modelCapabilityConfigFor(config, config.model || config.imageModel).image!;
    const normalized = normalizeImageValue(profile, config);
    const summaryParts = [
        ...(profile.size.parameter !== "none" ? [imageSizeLabel(normalized.size)] : []),
        ...(profile.quality.supported ? [imageQualityLabel(normalized.quality)] : []),
        ...(showCount && profile.maxOutputs > 1 ? [`${normalized.count} 张`] : []),
        ...(profile.transparentBackground.supported && normalized.transparentBackground === "true" ? ["透明"] : []),
    ];
    const summary = summaryParts.join(" · ");
    const hasSettings = profile.size.parameter !== "none" || profile.quality.supported || profile.transparentBackground.supported || (showCount && profile.maxOutputs > 1);
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [onOpenChange, open]);

    const panel = open && buttonRect ? <ImageSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} showCount={showCount} onConfigChange={onConfigChange} /> : null;

    if (!hasSettings) return null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={`canvas-generation-settings-trigger ${buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"}`} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} aria-expanded={open} aria-label={`图像设置：${summary}`} title={`图像设置 · ${summary}`} onClick={() => updateOpen(!open)}>
                    <span className="truncate">{summary}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    showCount,
    onConfigChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    showCount: boolean;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
}) {
    const style = {
        position: "fixed",
        zIndex: "var(--z-dialog-popover)",
        ...imageSettingsPopoverLayout(buttonRect, { width: window.innerWidth, height: window.innerHeight }, placement),
        background: theme.canvas.background,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 10,
        boxShadow: `0 24px 72px ${theme.spatial.shadow}`,
        padding: 12,
        overflowY: "auto",
        overscrollBehavior: "contain",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover aceternity-floating-panel backdrop-blur-2xl"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} showCount={showCount} quickCount={3} className="space-y-3" />
        </div>,
        document.body,
    );
}

export function imageSettingsPopoverLayout(anchor: Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width">, viewport: { width: number; height: number }, placement: CanvasImageSettingsPopoverProps["placement"] = "topLeft") {
    const gap = 8, margin = 12;
    const width = Math.max(0, Math.min(420, viewport.width - margin * 2));
    const left = placement.endsWith("Right") ? anchor.right - width : placement === "top" || placement === "bottom" ? anchor.left + anchor.width / 2 - width / 2 : anchor.left;
    const topEdge = Math.min(viewport.height - margin, Math.max(margin, anchor.top - gap));
    const bottomEdge = Math.max(margin, Math.min(viewport.height - margin, anchor.bottom + gap));
    const above = Math.max(0, topEdge - margin), below = Math.max(0, viewport.height - margin - bottomEdge);
    const prefersTop = placement.startsWith("top");
    const useTop = prefersTop ? above >= Math.min(260, below) : below < Math.min(260, above);
    return { width, left: Math.max(margin, Math.min(viewport.width - width - margin, left)), ...(useTop ? { bottom: viewport.height - topEdge, maxHeight: above } : { top: bottomEdge, maxHeight: below }) };
}

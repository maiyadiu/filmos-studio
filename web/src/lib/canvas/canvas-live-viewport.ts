import type { SelectionBox, ViewportTransform } from "@/types/canvas";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";

export const CANVAS_VIEWPORT_PREVIEW_EVENT = "canvas:viewport-preview";
export const CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT = "canvas:graphics-viewport-preview";
export const CANVAS_SELECTION_PREVIEW_EVENT = "canvas:selection-preview";

// 空间网格点模式的点半径（像素单位）。远距时使用更小半径，避免点阵糊成一团。
export function canvasDotPx(scale: number): string {
    return scale < 0.12 ? "0.6px" : "0.8px";
}

// 点阵在缩小时不再无限压缩到屏幕像素，避免密集视觉噪声。
export function canvasDotGridPx(scale: number): number {
    return Math.max(48 * scale, 32);
}

export function canvasWorldTransform(viewport: ViewportTransform, interacting = false): string {
    const translation = interacting ? `translate3d(${viewport.x}px, ${viewport.y}px, 0)` : `translate(${viewport.x}px, ${viewport.y}px)`;
    return `${translation} scale(var(--canvas-live-scale-ratio))`;
}

export function canvasGridTransform(viewport: ViewportTransform, mode: CanvasBackgroundMode): string {
    const period = mode === "dots" ? canvasDotGridPx(viewport.k) : 48 * viewport.k;
    return `translate3d(${viewport.x % period}px, ${viewport.y % period}px, 0)`;
}

export function applyCanvasLiveViewport(container: HTMLDivElement | null, viewport: ViewportTransform, notify = true) {
    if (!container) return;
    const gridSize = 48 * viewport.k;
    const dotGridSize = canvasDotGridPx(viewport.k);
    const committedScale = Number(container.style.getPropertyValue("--canvas-committed-scale")) || viewport.k;
    // 平移只改图层自身的 transform；继承变量会让整张画布的表单/正文逐帧重算样式。
    const world = container.querySelector<HTMLElement>(":scope > [data-canvas-world-layer]");
    if (world) world.style.transform = canvasWorldTransform(viewport, container.dataset.canvasViewportInteracting === "true");
    const grid = container.querySelector<HTMLElement>(":scope > [data-canvas-grid-layer]");
    if (grid) grid.style.transform = canvasGridTransform(viewport, grid.dataset.canvasGridLayer === "dots" ? "dots" : "lines");
    container.style.setProperty("--canvas-live-scale", String(viewport.k));
    // 外置节点标题用同一帧逆倍率抵消世界层缩放，避免等待 React 提交后再校正尺寸。
    container.style.setProperty("--canvas-live-inverse-scale", String(1 / Math.max(viewport.k, 0.05)));
    container.style.setProperty("--canvas-live-scale-ratio", String(viewport.k / committedScale));
    container.style.setProperty("--canvas-grid-size", `${gridSize}px`);
    container.style.setProperty("--canvas-dot-grid-size", `${dotGridSize}px`);
    container.style.setProperty("--canvas-dot-size", canvasDotPx(viewport.k));
    // 图形层必须逐帧跟随 DOM 世界层；浮层和滚动通知仍可按原频率节流。
    container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: viewport }));
    if (notify) {
        container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_VIEWPORT_PREVIEW_EVENT, { detail: viewport }));
        // Ant Design overlays watch scrollable ancestors, but CSS transforms do not emit layout events.
        container.dispatchEvent(new Event("scroll"));
    }
}

export function subscribeCanvasGraphicsViewportPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, handlePreview);
}

export function subscribeCanvasViewportPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, handlePreview);
}

export function applyCanvasSelectionPreview(container: HTMLDivElement | null, selection: SelectionBox) {
    container?.dispatchEvent(new CustomEvent<SelectionBox>(CANVAS_SELECTION_PREVIEW_EVENT, { detail: selection }));
}

export function subscribeCanvasSelectionPreview(container: HTMLDivElement, listener: (selection: SelectionBox) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<SelectionBox>).detail);
    container.addEventListener(CANVAS_SELECTION_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_SELECTION_PREVIEW_EVENT, handlePreview);
}

export function isCanvasTextEditingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target.closest("input, textarea, select")) return true;
    // Both contenteditable="" and plaintext-only are native editing hosts.
    const host = target.closest("[contenteditable]");
    return Boolean(host && host.getAttribute("contenteditable") !== "false");
}

export function isCanvasOverlayTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(
        "[data-canvas-no-zoom], [role='dialog'], .ant-modal, .ant-popover, .ant-dropdown, .ant-select-dropdown",
    ));
}

export function hasBrowserTextSelection(): boolean {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().length);
}

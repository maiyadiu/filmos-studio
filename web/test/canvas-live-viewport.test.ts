import { expect, test } from "bun:test";
import { applyCanvasLiveViewport, canvasGridTransform, canvasWorldTransform, CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, CANVAS_VIEWPORT_PREVIEW_EVENT } from "../src/lib/canvas/canvas-live-viewport";

function fixture(mode: "lines" | "dots" | "blank" = "lines") {
    const values = new Map([["--canvas-committed-scale", ".5"]]);
    const events: Event[] = [];
    const world = { style: { transform: "" } };
    const grid = { style: { transform: "" }, dataset: { canvasGridLayer: mode } };
    const container = {
        dataset: { canvasViewportInteracting: "true" },
        style: { getPropertyValue: (key: string) => values.get(key) || "", setProperty: (key: string, value: string) => values.set(key, value) },
        querySelector: (selector: string) => selector.includes("world-layer") ? world : mode === "blank" ? null : grid,
        dispatchEvent: (event: Event) => events.push(event),
    };
    return { container: container as unknown as HTMLDivElement, values, events, world, grid };
}

test("pan updates only world/grid transforms, not inherited translation variables", () => {
    const f = fixture();
    const viewport = { x: 135, y: -70, k: .5 };
    applyCanvasLiveViewport(f.container, viewport, false);
    expect(f.world.style.transform).toBe("translate3d(135px, -70px, 0) scale(var(--canvas-live-scale-ratio))");
    expect(f.grid.style.transform).toBe("translate3d(15px, -22px, 0)");
    expect([...f.values.keys()].some(key => /-(x|y)$/.test(key))).toBe(false);
    expect(f.values.get("--canvas-live-scale-ratio")).toBe("1");
    expect(f.events.map(e => e.type)).toEqual([CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT]);
    expect((f.events[0] as CustomEvent).detail).toEqual(viewport);
});

test("zoom and floating overlays keep the live viewport contract", () => {
    const f = fixture("dots");
    const viewport = { x: 135, y: -70, k: 1 };
    applyCanvasLiveViewport(f.container, viewport);
    expect(f.values.get("--canvas-live-scale-ratio")).toBe("2");
    expect(f.values.get("--canvas-live-inverse-scale")).toBe("1");
    expect(f.values.get("--canvas-grid-size")).toBe("48px");
    expect(f.grid.style.transform).toBe("translate3d(39px, -22px, 0)");
    expect(f.events.map(e => e.type)).toEqual([CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, CANVAS_VIEWPORT_PREVIEW_EVENT, "scroll"]);
});

test("settled viewport uses the same position without forcing an interaction raster", () => {
    const f = fixture("blank");
    delete f.container.dataset.canvasViewportInteracting;
    applyCanvasLiveViewport(f.container, { x: 1, y: 2, k: .3 });
    expect(f.world.style.transform).toBe(canvasWorldTransform({ x: 1, y: 2, k: .3 }));
    expect(f.world.style.transform).toStartWith("translate(1px, 2px)");
    expect(() => applyCanvasLiveViewport(null, { x: 1, y: 2, k: 1 })).not.toThrow();
});

test("dot grid keeps its minimum spacing while line grid follows canvas scale", () => {
    expect(canvasGridTransform({ x: 35, y: -35, k: .1 }, "dots")).toBe("translate3d(3px, -3px, 0)");
    expect(canvasGridTransform({ x: 35, y: -35, k: 1 }, "lines")).toBe("translate3d(35px, -35px, 0)");
});

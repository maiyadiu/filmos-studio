import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasSyncBaseline = { project: CanvasProject; contentHash: string };

// Object key order may change in Go JSON serialization; arrays and every value
// remain significant. This comparison is not a hash or a version authority.
export function sameCanvasJSON(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, i) => sameCanvasJSON(item, right[i]));
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    const keys = Object.keys(a).filter(key => a[key] !== undefined);
    return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => Object.hasOwn(b, key) && sameCanvasJSON(a[key], b[key]));
}

export function requireCanvasContentHash(value: unknown): string {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("画布缺少服务端版本凭据，未执行写入；请重新同步当前源码服务");
    return value;
}

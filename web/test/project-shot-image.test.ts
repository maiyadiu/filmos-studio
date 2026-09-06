import { expect, test } from "bun:test";
import { readProjectShotImage, loadShotImagePreview } from "../src/services/api/project-shot-image";
import { getResource, getResourceBlob, type RemoteResource } from "../src/services/api/resources";
import { apiClient, ApiError } from "../src/services/api/request";
import { hashScriptContent } from "../src/film/story/script-version";
import type { CanvasPromptContext } from "../src/services/api/canvas-prompts";
import type { ProjectUnit } from "../src/services/api/projects";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { canvasToolFailure } from "../src/lib/canvas/canvas-tool-failure";
import { ShotImageReadError } from "../../packages/filmos-agent-contracts/src/shot-image";

async function fixture() {
    const now = Date.parse("2026-09-06T09:00:00Z"), scriptText = "<p>红衣在左，蓝衣在右；桌上白纸船。</p>", sourceHash = await hashScriptContent(scriptText);
    const raw = { nodeId: "script", rowId: "project-shot:shot" };
    const row = { id: raw.rowId, imageNodeId: "image", camera: "固定全景", projectShotSource: { id: "shot", revision: 2, sourceRevision: 1, sourceHash } };
    const nodes = [{ id: "script", type: CanvasNodeType.Script, metadata: { chapterId: "unit", storyboard: { rows: [row] } } },
        { id: "image", type: CanvasNodeType.Image, title: "相同标题", metadata: { status: "success", storageKey: "resource:correct" } },
        { id: "decoy", type: CanvasNodeType.Image, title: "相同标题", metadata: { status: "success", storageKey: "resource:decoy" } }] as CanvasNodeData[];
    const local = { projectId: "canvas", domainProjectId: "project", nodes: structuredClone(nodes) };
    const project = { id: "canvas", projectId: "project", nodes } as CanvasProject;
    const context = { canvasId: "canvas", projectId: "project", ...raw, kind: "image", prompt: "", managed: false,
        state: { revision: 0, contentHash: await hashScriptContent(""), dependencyHash: "" }, dependencyHash: "b".repeat(64), writeBlockers: [], localOverrides: [],
        dependencies: { project: { id: "project", title: "隔离" }, source: { unitId: "unit", revision: 1, hash: sourceHash },
            shot: { id: "shot", projectId: "project", unitId: "unit", revision: 2, sourceRevision: 1, sourceHash }, direction: {}, assets: [] } } as unknown as CanvasPromptContext;
    const unit = { id: "unit", projectId: "project", revision: 1, sourceText: scriptText } as ProjectUnit;
    // Bytes are opaque here; real pixel decoding is covered by the MCP tests.
    const blob = new Blob(["synthetic-pixel-transport"], { type: "image/png" });
    const resource = { id: "correct", kind: "image", status: "ready", mimeType: "image/png", size: blob.size, updatedAt: new Date(now).toISOString(), etag: "test-etag" } as RemoteResource;
    const requested: string[] = [];
    let tick = now, scope = "fixture-user";
    const io = { getCanvasPrompt: async () => structuredClone(context), getProjectUnit: async () => ({ unit: structuredClone(unit) }),
        getRemoteCanvasProject: async () => ({ project: structuredClone(project), contentHash: "a".repeat(64) }),
        getResource: async (id: string, options?: { fresh?: boolean }) => { expect(options?.fresh).toBe(true); requested.push(id); return structuredClone(resource); },
        getResourceBlob: async (key: string) => { expect(key).toBe("resource:correct"); return blob as Blob | null; },
        imageSize: async () => ({ width: 64, height: 48 }), userScope: () => scope, now: () => tick };
    return { raw, local, project, context, unit, resource, blob, io, requested, expire: () => { tick += 300_000; }, switchUser: () => { scope = "other"; },
        run: () => readProjectShotImage(raw, "project", "canvas", () => local, io) };
}

test("scoped saved row delivers exact bytes/hash and full script; same title cannot redirect it", async () => {
    const f = await fixture(), before = JSON.stringify([f.local, f.project, f.unit]);
    const result = await f.run();
    expect(result.binding).toMatchObject({ projectId: "project", canvasId: "canvas", shotId: "shot", imageNodeId: "image", resourceId: "correct", shotRevision: 2 });
    expect(result.image.sha256).toBe(await hashScriptContent(await f.blob.text()));
    expect(atob(result.bytesBase64)).toBe(await f.blob.text());
    expect(result.constraints.scriptText).toBe(f.unit.sourceText);
    expect(f.requested).toEqual(["correct", "correct"]);
    expect(JSON.stringify([f.local, f.project, f.unit])).toBe(before);
});

test("historical preview fetches the original resource after the row changes, without writing or replacing pixels", async () => {
    const f = await fixture(), reading = await f.run();
    f.local.nodes[0].metadata!.storyboard!.rows[0].imageNodeId = "decoy";
    f.project.nodes[0].metadata!.storyboard!.rows[0].imageNodeId = "decoy";
    f.expire(); // Historical viewing is allowed, not new visual inference.
    const before = JSON.stringify([f.local, f.project, f.unit]);
    const blob = await loadShotImagePreview(reading, () => f.local, new AbortController().signal, f.io);
    expect(await blob.text()).toBe(await f.blob.text());
    expect(f.requested.at(-1)).toBe("correct");
    expect(JSON.stringify([f.local, f.project, f.unit])).toBe(before);
});

test("historical preview rejects changed bytes, metadata, auth scope, deleted resources and altered script evidence", async () => {
    for (const mode of ["hash", "etag", "deleted", "script", "foreign", "user", "canvas", "aborted", "dimensions"]) {
        const f = await fixture(), reading = await f.run(), controller = new AbortController();
        if (mode === "hash") reading.image.sha256 = "0".repeat(64);
        if (mode === "etag") f.resource.etag = "new";
        if (mode === "deleted") f.resource.status = "deleted";
        if (mode === "script") reading.constraints.scriptText += "篡改";
        if (mode === "foreign") f.project.projectId = "other";
        if (mode === "canvas") f.local.projectId = "other";
        if (mode === "aborted") controller.abort();
        if (mode === "dimensions") f.io.imageSize = async () => ({ width: 63, height: 48 });
        if (mode === "user") { const fetch = f.io.getResourceBlob; f.io.getResourceBlob = async key => { const b = await fetch(key); f.switchUser(); return b; }; }
        await expect(loadShotImagePreview(reading, () => f.local, controller.signal, f.io)).rejects.toBeInstanceOf(Error);
    }
});

test("missing image, unsaved pixels, bad target, foreign project and arbitrary URLs fail closed", async () => {
    for (const mode of ["missing", "unsaved", "loading", "foreign", "url", "stale-source", "local-draft"]) {
        const f = await fixture();
        if (mode === "missing") f.local.nodes = [];
        if (mode === "unsaved") f.local.nodes[1].metadata!.storageKey = "local-image";
        if (mode === "loading") f.local.nodes[1].metadata!.status = "loading";
        if (mode === "foreign") f.project.projectId = "other";
        if (mode === "url") Object.assign(f.raw, { url: "https://untrusted.invalid/image" });
        if (mode === "stale-source") f.unit.revision++;
        if (mode === "local-draft") f.local.nodes[0].metadata!.storyboard!.rows[0].camera = "未保存的机位";
        await expect(f.run()).rejects.toBeInstanceOf(ShotImageReadError);
    }
});

test("change during pixel fetch, user/canvas switch, expiry and pinned old hash never return stale evidence", async () => {
    for (const mode of ["resource", "source", "row", "local", "user", "canvas", "expired", "hash"]) {
        const f = await fixture(), fetch = f.io.getResourceBlob;
        f.io.getResourceBlob = async (key: string) => {
            const blob = await fetch(key);
            if (mode === "resource") f.resource.etag = "changed";
            if (mode === "source") f.unit.sourceText += "新稿";
            if (mode === "row") f.project.nodes[0].metadata!.storyboard!.rows[0].imageNodeId = "decoy";
            if (mode === "local") f.local.nodes[0].metadata!.storyboard!.rows[0].camera = "新机位";
            if (mode === "user") f.switchUser();
            if (mode === "canvas") f.local.projectId = "other";
            if (mode === "expired") f.expire();
            return blob;
        };
        if (mode === "hash") Object.assign(f.raw, { expectedImageHash: "0".repeat(64) });
        await expect(f.run()).rejects.toBeInstanceOf(ShotImageReadError);
    }
});

test("null, invalid MIME, too large and unreadable pixels cannot become success; safe errors retain type", async () => {
    for (const mode of ["null", "mime", "size", "decode", "network", "auth"]) {
        const f = await fixture();
        if (mode === "null") f.io.getResourceBlob = async () => null;
        if (mode === "mime") f.resource.mimeType = "image/svg+xml";
        if (mode === "size") f.resource.size = 9 * 1024 * 1024;
        if (mode === "decode") f.io.imageSize = async () => { throw new Error("corrupt"); };
        if (mode === "network") f.io.getResourceBlob = async () => { throw new Error("private endpoint"); };
        if (mode === "auth") f.io.getResource = async () => { throw new ApiError("private cookie", { status: 403 }); };
        try { await f.run(); throw new Error("unexpected success"); }
        catch (error) {
            const safe = canvasToolFailure(error);
            expect(safe.error).not.toContain("private");
            if (mode === "auth") expect(safe.backendStatus).toBe(403);
            else expect(safe.visualError).toMatch(/^canvas_image_/);
        }
    }
});

test("fresh resource reads bypass old display cache and bounded stream refuses over-limit content", async () => {
    const adapter = apiClient.defaults.adapter, originalFetch = globalThis.fetch;
    let version = 0;
    apiClient.defaults.adapter = async config => ({ config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: { resource: { id: "fresh-fixture", etag: String(++version) } }, msg: "ok" } });
    try {
        expect((await getResource("fresh-fixture")).etag).toBe("1");
        expect((await getResource("fresh-fixture")).etag).toBe("1");
        expect((await getResource("fresh-fixture", { fresh: true })).etag).toBe("2");
        globalThis.fetch = (async (_url, options) => { expect(options?.cache).toBe("no-store"); return new Response(new Blob(["123456"]), { headers: { "content-type": "image/png" } }); }) as typeof fetch;
        await expect(getResourceBlob("resource:fixture", { maxBytes: 3 })).rejects.toThrow("RESOURCE_BYTE_LIMIT_EXCEEDED");
        expect((await getResourceBlob("resource:fixture", { maxBytes: 6 }))?.size).toBe(6);
    } finally { apiClient.defaults.adapter = adapter; globalThis.fetch = originalFetch; }
});

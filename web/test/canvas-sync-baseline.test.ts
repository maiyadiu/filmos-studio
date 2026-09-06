import { expect, test } from "bun:test";
import localforage from "localforage";
import { apiClient } from "../src/services/api/request";
import { hashScriptContent } from "../src/film/story/script-version";
import { requireCanvasContentHash, sameCanvasJSON } from "../src/lib/canvas/canvas-sync-baseline";
import { resetRemoteUserDataSync, saveRemoteUserDataNow, syncRemoteUserData, syncSyncedProjectStoryboard, loadSyncedCanvasPrompt, saveSyncedCanvasPrompt } from "../src/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence, useAssetStore } from "../src/stores/use-asset-store";
import { upsertProjectChapterStoryboard } from "../src/lib/canvas/project-chapter-storyboard";
import type { ProjectShotContext } from "../src/services/api/projects";
import type { CanvasNodeData } from "../src/types/canvas";
import { runProjectStoryboardTool } from "../src/services/api/project-storyboard-tools";
import { canvasPromptRequestHash, type CanvasPromptContext, type CanvasPromptInput, type CanvasPromptReceipt } from "../src/services/api/canvas-prompts";

const project = (): CanvasProject => ({ id: "canvas-cas", projectId: "business", title: "初版", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [], createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" });

type Fixture = {
    remote: Map<string, CanvasProject>;
    writes: Array<{ project: CanvasProject; expectedContentHash: string }>;
    reads: string[];
    options: { omitHash?: boolean; loseResponse?: boolean; resetDuringSave?: boolean; corruptResponse?: boolean; onCanvasRead?: () => void };
    protocol?: (method: string, url: string, body: unknown) => unknown;
};

async function fixture(run: (f: Fixture) => Promise<void>) {
    const oldWindow = (globalThis as { window?: unknown }).window;
    const oldGet = localforage.getItem, oldSet = localforage.setItem;
    const oldAdapter = apiClient.defaults.adapter;
    const oldProjects = useCanvasStore.getState().projects, oldAssets = useAssetStore.getState().assets;
    const values = new Map<string, unknown>();
    const f: Fixture = { remote: new Map([["canvas-cas", project()]]), writes: [], reads: [], options: {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 1, clearTimeout: () => undefined, dispatchEvent: () => true, localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } } });
    localforage.getItem = (async (key: string) => values.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: unknown) => { values.set(key, value); return value; }) as typeof localforage.setItem;
    apiClient.defaults.adapter = async config => {
        const url = String(config.url), method = config.method;
        const reply = (data: unknown, status = 200) => ({ config, headers: {}, status, statusText: String(status), data: { code: status === 200 ? 0 : status, data, msg: status === 409 ? "画布内容已变化" : "fixture" } });
        const protocolReply = await f.protocol?.(method || "get", url, (typeof config.data === "string" ? JSON.parse(config.data) : config.data) ?? config.params);
        if (protocolReply !== undefined) return reply(protocolReply);
        if (method === "get") {
            f.reads.push(url);
            if (url === "/user-data/snapshot") return reply({ assets: [], projects: structuredClone([...f.remote.values()]), projectContentHashes: f.options.omitHash ? {} : Object.fromEntries(await Promise.all([...f.remote].map(async ([id, canvas]) => [id, await hashScriptContent(JSON.stringify(canvas))]))) });
            const id = decodeURIComponent(url.slice("/canvas-projects/".length));
            const canvas = f.remote.get(id);
            f.options.onCanvasRead?.();
            return canvas ? reply({ project: structuredClone(canvas), contentHash: await hashScriptContent(JSON.stringify(canvas)) }) : reply({}, 404);
        }
        if (method === "put" && url.startsWith("/canvas-projects/")) {
            const body = JSON.parse(config.data) as { project: CanvasProject; expectedContentHash: string };
            f.writes.push(body);
            const before = f.remote.get(body.project.id);
            const expected = before ? await hashScriptContent(JSON.stringify(before)) : "";
            if (body.expectedContentHash !== expected) return reply({}, 409);
            f.remote.set(body.project.id, structuredClone(body.project));
            if (f.options.resetDuringSave) resetRemoteUserDataSync();
            if (f.options.loseResponse) { f.options.loseResponse = false; throw new Error("lost save response"); }
            return reply({ project: { id: body.project.id, contentHash: f.options.corruptResponse ? "bad" : await hashScriptContent(JSON.stringify(body.project)) } });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
    };
    try { resetRemoteUserDataSync(); await run(f); }
    finally {
        resetRemoteUserDataSync();
        useCanvasStore.setState({ projects: oldProjects }); useAssetStore.setState({ assets: oldAssets });
        await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
        apiClient.defaults.adapter = oldAdapter; localforage.getItem = oldGet; localforage.setItem = oldSet;
        if (oldWindow === undefined) delete (globalThis as { window?: unknown }).window;
        else Object.defineProperty(globalThis, "window", { configurable: true, value: oldWindow });
    }
}

test("canvas comparison ignores object order but preserves text, array order and values", () => {
    expect(sameCanvasJSON({ a: [1, "<p>原稿</p>"], b: { c: true }, missing: undefined }, { b: { c: true }, a: [1, "<p>原稿</p>"] })).toBe(true);
    for (const different of [{ a: ["<p>原稿</p>", 1], b: { c: true } }, { a: [1, "原稿"], b: { c: true } }, { a: [1, "<p>原稿</p>"], b: { c: false } }]) expect(sameCanvasJSON({ a: [1, "<p>原稿</p>"], b: { c: true } }, different)).toBe(false);
    for (const hash of [null, "", "a".repeat(63), "A".repeat(64)]) expect(() => requireCanvasContentHash(hash)).toThrow();
    expect(requireCanvasContentHash("a".repeat(64))).toBe("a".repeat(64));
});

test("canvas autosync refuses a stale remote baseline without discarding local edits", async () => fixture(async f => {
    await syncRemoteUserData("fixture-user");
    const hash = await hashScriptContent(JSON.stringify(f.remote.get("canvas-cas")));
    f.remote.get("canvas-cas")!.title = "另一个已保存新版";
    useCanvasStore.getState().renameProject("canvas-cas", "我的待核对修改");
    await expect(saveRemoteUserDataNow()).rejects.toThrow("画布内容已变化");
    await expect(saveRemoteUserDataNow()).rejects.toThrow("画布内容已变化");
    expect(f.writes.map(write => write.expectedContentHash)).toEqual([hash, hash]);
    expect(f.remote.get("canvas-cas")?.title).toBe("另一个已保存新版");
    expect(useCanvasStore.getState().projects[0]?.title).toBe("我的待核对修改");
}));

test("lost canvas response recovers exact readback once and subsequent edit uses new hash", async () => fixture(async f => {
    await syncRemoteUserData("fixture-user");
    useCanvasStore.getState().renameProject("canvas-cas", "已保存但丢响应");
    f.options.loseResponse = true;
    await saveRemoteUserDataNow();
    expect(f.writes).toHaveLength(1);
    expect(f.reads.filter(path => path === "/canvas-projects/canvas-cas")).toHaveLength(1);
    const hash = await hashScriptContent(JSON.stringify(f.remote.get("canvas-cas")));
    await saveRemoteUserDataNow();
    expect(f.writes).toHaveLength(1);
    useCanvasStore.getState().renameProject("canvas-cas", "后续编辑");
    await saveRemoteUserDataNow();
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]?.expectedContentHash).toBe(hash);
    expect(f.remote.get("canvas-cas")?.title).toBe("后续编辑");
}));

test("missing snapshot hash fails before replacing local canvas or writing", async () => fixture(async f => {
    useCanvasStore.setState({ projects: [{ ...project(), title: "本地缓存保留" }] });
    f.options.omitHash = true;
    await expect(syncRemoteUserData("fixture-user")).rejects.toThrow("服务端版本凭据");
    expect(useCanvasStore.getState().projects[0]?.title).toBe("本地缓存保留");
    await expect(saveRemoteUserDataNow()).rejects.toThrow("基线尚未建立");
    expect(f.writes).toHaveLength(0);
}));

test("new canvas uses create-only CAS and cannot overwrite an unknown remote canvas", async () => fixture(async f => {
    await syncRemoteUserData("fixture-user");
    useCanvasStore.setState({ projects: [...useCanvasStore.getState().projects, { ...project(), id: "new", title: "新画布" }] });
    await saveRemoteUserDataNow();
    expect(f.writes[0]?.expectedContentHash).toBe("");
    expect(f.remote.get("new")?.title).toBe("新画布");
    f.remote.set("unknown", { ...project(), id: "unknown", title: "已有远端" });
    useCanvasStore.setState({ projects: [...useCanvasStore.getState().projects, { ...project(), id: "unknown", title: "不能覆盖" }] });
    await expect(saveRemoteUserDataNow()).rejects.toThrow("画布内容已变化");
    expect(f.remote.get("unknown")?.title).toBe("已有远端");
}));

test("session reset during save refuses acknowledgement and does not read a different account", async () => fixture(async f => {
    await syncRemoteUserData("fixture-user");
    useCanvasStore.getState().renameProject("canvas-cas", "切换前已发出请求");
    f.options.resetDuringSave = true;
    await expect(saveRemoteUserDataNow()).rejects.toThrow("用户会话已改变");
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toEqual(["/user-data/snapshot"]);
    await saveRemoteUserDataNow();
    expect(f.writes).toHaveLength(1);
}));

test("invalid save receipt is recovered only by exact remote payload and valid readback hash", async () => fixture(async f => {
    await syncRemoteUserData("fixture-user");
    useCanvasStore.getState().renameProject("canvas-cas", "回执校验");
    f.options.corruptResponse = true;
    await saveRemoteUserDataNow();
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toContain("/canvas-projects/canvas-cas");
}));

function storyboardFixture(f: Fixture) {
    const input = { projectId: "business", unitId: "unit", expectedShotRevision: 2, sourceRevision: 3, sourceHash: "a".repeat(64) };
    const context = { unit: { id: "unit", projectId: "business", title: "雨夜", revision: 3, shotRevision: 2 }, sourceHash: input.sourceHash, paragraphs: [], staleShotIds: [], shots: [0, 1].map(position => ({ id: `shot-${position}`, projectId: "business", unitId: "unit", position, title: "回应", description: "留在原处回应", durationMs: 5000, revision: 1, sourceRevision: 3, sourceHash: input.sourceHash, content: { scene: "客厅", action: "回应", camera: "固定双人中景", characters: [], dialogue: [] } })) } as unknown as ProjectShotContext;
    const state = { linked: false, failLink: false, changeAfterLink: false };
    f.protocol = (method, url, body) => {
        if (method === "get" && url === "/projects/business/units/unit/shots") return structuredClone(context);
        if (method === "post" && url === "/projects/business/canvas-links") {
            expect(body).toEqual({ canvasId: "canvas-cas", unitId: "unit", role: "storyboard" });
            if (state.failLink) throw new Error("link response unavailable");
            state.linked = true;
            if (state.changeAfterLink) context.unit.revision++;
            return { link: { id: "link", projectId: "business", canvasId: "canvas-cas", unitId: "unit", role: "storyboard" } };
        }
        if (method === "get" && url === "/projects/business") return { project: { id: "business" }, canvasUnitLinks: state.linked ? [{ canvasId: "canvas-cas", unitId: "unit", role: "storyboard" }] : [] };
        return undefined;
    };
    return { input, context, state };
}

test("scoped storyboard sync uses native rows, preserves unrelated dirty canvas and repeats without another PUT", async () => fixture(async f => {
    const s = storyboardFixture(f);
    f.remote.set("other", { ...project(), id: "other", title: "另一个画布" });
    await syncRemoteUserData("fixture-user");
    useCanvasStore.getState().renameProject("other", "不应顺带保存");
    const result = await syncSyncedProjectStoryboard("canvas-cas", s.input);
    expect(result.verification).toEqual({ ok: true, persisted: true, appliedLocally: true, linked: true, sourceCurrent: true });
    expect(result.location).toMatchObject({ canvasId: "canvas-cas", projectId: "business", unitId: "unit", nodeId: "project-chapter:unit", rows: [{ shotId: "shot-0", rowId: "project-shot:shot-0" }, { shotId: "shot-1", rowId: "project-shot:shot-1" }] });
    expect(f.remote.get("other")?.title).toBe("另一个画布");
    const again = await syncSyncedProjectStoryboard("canvas-cas", s.input);
    expect(again.verification.ok).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.remote.get("canvas-cas")?.nodes).toHaveLength(1);
}));

test("storyboard preflight rejects stale source, manual mapped edits and local media without writes", async () => {
    for (const bad of ["stale", "version", "manual", "media"]) await fixture(async f => {
        const s = storyboardFixture(f);
        if (bad === "stale") s.context.staleShotIds = ["shot-0"];
        if (bad === "manual") {
            const seed = upsertProjectChapterStoryboard([], [], { unit: s.context.unit, shots: s.context.shots });
            seed.nodes[0].metadata!.storyboard!.rows[0].camera = "手工特写";
            f.remote.get("canvas-cas")!.nodes = seed.nodes;
        }
        if (bad === "media") f.remote.get("canvas-cas")!.nodes = [{ id: "local", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "data:image/png;base64,aQ==" } }] as CanvasNodeData[];
        await syncRemoteUserData("fixture-user");
        await expect(syncSyncedProjectStoryboard("canvas-cas", { ...s.input, ...(bad === "version" ? { expectedShotRevision: 1 } : {}) })).rejects.toThrow(bad === "media" ? "尚未同步的本地媒体" : bad === "manual" ? "手工修改" : bad === "version" ? "版本已改变" : "没有可同步");
        expect(f.writes).toHaveLength(0);
    });
});

test("lost storyboard response recovers same node and row identities without creating another canvas", async () => fixture(async f => {
    const s = storyboardFixture(f);
    await syncRemoteUserData("fixture-user");
    f.options.loseResponse = true;
    expect((await syncSyncedProjectStoryboard("canvas-cas", s.input)).verification.ok).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect([...f.remote.keys()]).toEqual(["canvas-cas"]);
}));

test("local target edit after remote save is retained and auto-sync cannot undo saved import", async () => fixture(async f => {
    const s = storyboardFixture(f);
    await syncRemoteUserData("fixture-user");
    f.options.onCanvasRead = () => {
        f.options.onCanvasRead = undefined;
        useCanvasStore.getState().updateProject("canvas-cas", { nodes: [{ id: "project-chapter:unit", type: "script", title: "人工临时版本", metadata: { chapterId: "unit" } }] as CanvasNodeData[] });
    };
    const result = await syncSyncedProjectStoryboard("canvas-cas", s.input);
    expect(result.verification).toMatchObject({ ok: false, persisted: true, appliedLocally: false, linked: false });
    expect(useCanvasStore.getState().projects[0]?.nodes[0]?.title).toBe("人工临时版本");
    await expect(saveRemoteUserDataNow()).rejects.toThrow("画布内容已变化");
    expect(f.remote.get("canvas-cas")?.nodes[0]?.title).toBe("分镜脚本 · 雨夜");
}));

test("unrelated edit during storyboard readback remains dirty and next sync keeps both changes", async () => fixture(async f => {
    const s = storyboardFixture(f);
    await syncRemoteUserData("fixture-user");
    f.options.onCanvasRead = () => {
        f.options.onCanvasRead = undefined;
        useCanvasStore.getState().updateProject("canvas-cas", { nodes: [{ id: "manual", type: "text", title: "期间新增便笺" }] as CanvasNodeData[] });
    };
    expect((await syncSyncedProjectStoryboard("canvas-cas", s.input)).verification.ok).toBe(true);
    expect(useCanvasStore.getState().projects[0]?.nodes.map(node => node.id)).toEqual(["manual", "project-chapter:unit"]);
    await saveRemoteUserDataNow();
    expect(f.remote.get("canvas-cas")?.nodes.map(node => node.id)).toEqual(["manual", "project-chapter:unit"]);
}));

test("partial chapter link failure retries existing import; source drift never reports full completion", async () => fixture(async f => {
    const s = storyboardFixture(f);
    await syncRemoteUserData("fixture-user");
    s.state.failLink = true;
    expect((await syncSyncedProjectStoryboard("canvas-cas", s.input)).verification).toMatchObject({ ok: false, persisted: true, appliedLocally: true, linked: false });
    s.state.failLink = false;
    expect((await syncSyncedProjectStoryboard("canvas-cas", s.input)).verification.ok).toBe(true);
    expect(f.writes).toHaveLength(1);
    s.state.changeAfterLink = true;
    expect((await syncSyncedProjectStoryboard("canvas-cas", s.input)).verification).toMatchObject({ ok: false, linked: true, sourceCurrent: false });
}));

test("Agent storyboard wrapper rejects target overrides and exposes only verified native results", async () => fixture(async f => {
    const s = storyboardFixture(f);
    await syncRemoteUserData("fixture-user");
    for (const patch of [{ canvasId: "other" }, { generate: true }, { sourceHash: "bad" }, { projectId: "foreign" }, { expectedShotRevision: -1 }]) await expect(runProjectStoryboardTool({ ...s.input, ...patch }, "business", "canvas-cas")).rejects.toThrow();
    await expect(runProjectStoryboardTool(s.input, "business", undefined)).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    const result = await runProjectStoryboardTool(s.input, "business", "canvas-cas");
    expect(result.ok).toBe(true);
    expect(result.data.location.nodeId).toBe("project-chapter:unit");
}));

test("successive image/video prompt saves acknowledge the server timestamp and preserve CAS for later edits", async () => fixture(async f => {
    const s = storyboardFixture(f);
    await syncRemoteUserData("fixture-user");
    const imported = await syncSyncedProjectStoryboard("canvas-cas", s.input);
    expect(imported.verification.ok).toBe(true);
    const projectProtocol = f.protocol;
    const receipts = new Map<string, CanvasPromptReceipt>();
    const basePath = "/canvas-projects/canvas-cas/prompt-drafts";
    let tick = 0;
    const context = async (kind: "image" | "video") => {
        const canvas = f.remote.get("canvas-cas")!, row = canvas.nodes[0].metadata!.storyboard!.rows[0];
        const prompt = row[kind === "image" ? "imageGenerationPrompt" : "videoMotionPrompt"];
        return { projectId: "business", canvasId: canvas.id, nodeId: imported.location.nodeId, rowId: row.id, kind, prompt, canvasUpdatedAt: canvas.updatedAt, writeToken: canvas.promptWriteToken || "", state: row.promptDrafts?.[kind] || { revision: 0, contentHash: await hashScriptContent(prompt), dependencyHash: "" }, managed: !!row.promptDrafts?.[kind], dependencyHash: "d".repeat(64), dependencies: { project: { id: "business" }, source: { unitId: "unit", revision: 3, hash: s.input.sourceHash, title: "雨夜" }, shot: s.context.shots[0], direction: {}, assets: [] }, stale: false, writeBlockers: [], localOverrides: [] } as CanvasPromptContext;
    };
    f.protocol = async (method, url, raw) => {
        if (!url.startsWith(basePath)) return projectProtocol?.(method, url, raw);
        if (url.includes("/requests/")) { const receipt = receipts.get(url.split("/requests/")[1]); if (!receipt) throw new (await import("../src/services/api/request")).ApiError("missing fixture receipt", { status: 404 }); return structuredClone(receipt); }
        const target = raw as CanvasPromptInput;
        if (url.includes("/history/")) return structuredClone([...receipts.values()].find(r => r.snapshot.kind === target.kind)!.snapshot);
        if (method === "get") return context(target.kind);
        const current = await context(target.kind), canvas = f.remote.get("canvas-cas")!, row = canvas.nodes[0].metadata!.storyboard!.rows[0];
        const createdAt = `2026-09-06T01:00:0${++tick}.123456Z`;
        const snapshot = { id: target.requestId, canvasId: canvas.id, nodeId: target.nodeId, rowId: target.rowId, kind: target.kind, revision: 1, prompt: target.prompt, contentHash: await hashScriptContent(target.prompt), dependencyHash: current.dependencyHash, dependencies: current.dependencies, requestId: target.requestId, createdAt };
        const receipt = { id: target.requestId, canvasId: canvas.id, requestId: target.requestId, requestHash: await canvasPromptRequestHash(target), snapshot, createdAt };
        receipts.set(target.requestId, receipt);
        row[target.kind === "image" ? "imageGenerationPrompt" : "videoMotionPrompt"] = target.prompt;
        row.promptDrafts = { ...row.promptDrafts, [target.kind]: { revision: 1, contentHash: snapshot.contentHash, dependencyHash: snapshot.dependencyHash } };
        canvas.promptWriteToken = await hashScriptContent(target.requestId);
        canvas.updatedAt = createdAt;
        return { receipt: structuredClone(receipt), replayed: false };
    };
    for (const kind of ["image", "video"] as const) {
        const target = { projectId: "business", nodeId: imported.location.nodeId, rowId: imported.location.rows[0].rowId, kind };
        const current = await loadSyncedCanvasPrompt("canvas-cas", target);
        const saved = await saveSyncedCanvasPrompt("canvas-cas", { ...target, requestId: `timestamp-${kind}`, prompt: `${kind} 测试文字`, expectedRevision: current.context.state.revision, expectedContentHash: current.context.state.contentHash, dependencyHash: current.context.dependencyHash });
        expect(saved.persisted).toBe(true); expect(saved.appliedLocally).toBe(true);
    }
    expect(f.writes).toHaveLength(1); // Initial storyboard only; no redundant whole-canvas PUT between drafts.
    useCanvasStore.getState().renameProject("canvas-cas", "正常后续编辑");
    await saveRemoteUserDataNow();
    expect(f.writes).toHaveLength(2);
    expect(f.remote.get("canvas-cas")?.title).toBe("正常后续编辑");
    expect(f.remote.get("canvas-cas")?.nodes[0].metadata?.storyboard?.rows[0]).toMatchObject({ imageGenerationPrompt: "image 测试文字", videoMotionPrompt: "video 测试文字" });
}));

import { afterEach, expect, test } from "bun:test";
import { buildProjectAgentSnapshot, matchesAgentSessionScope } from "../src/film/agent/project-agent-context";
import { hashCanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";
import { buildProjectWorkbenchContext, buildLiveWorkbenchContextDraft, publishWorkbenchContext } from "../src/film/agent/workbench-context";
import { runProjectAgentTool } from "../src/services/api/project-agent-tools";
import { apiClient } from "../src/services/api/request";
import type { ProjectDetail } from "../src/services/api/projects";

const detail = { project: { id: "project", name: "隔离作品", revision: 2, status: "active" }, units: [{ id: "one", title: "第一章" }, { id: "two", title: "第二章" }] } as ProjectDetail;
const chapter = { projectId: "project", unitId: "two", revision: 3, ready: true, dirty: false };
const previousWindow = globalThis.window;
const previousAdapter = apiClient.defaults.adapter;
afterEach(() => { globalThis.window = previousWindow; apiClient.defaults.adapter = previousAdapter; });

test("project scope uses actual selected chapter, never first chapter or a stale project", () => {
    const snapshot = buildProjectAgentSnapshot(detail, "chapters", chapter);
    expect(snapshot).toMatchObject({ contextKind: "project", projectId: "project", domainProjectId: "project", contentUnitId: "two", contentUnitRevision: 3, nodes: [], blockers: [] });
    for (const value of [null, { ...chapter, projectId: "other" }, { ...chapter, unitId: "missing" }]) {
        expect(buildProjectAgentSnapshot(detail, "chapters", value).contentUnitId).toBeUndefined();
        expect(buildProjectAgentSnapshot(detail, "chapters", value).blockers).toHaveLength(1);
    }
    expect(buildProjectAgentSnapshot(detail, "overview", chapter).contentUnitId).toBeUndefined();
    for (const value of [{ ...chapter, dirty: true }, { ...chapter, ready: false }]) expect(buildProjectAgentSnapshot(detail, "chapters", value).blockers).toHaveLength(1);
    expect(buildProjectAgentSnapshot({ ...detail, project: { ...detail.project, status: "archived" } }, "overview").blockers).toHaveLength(1);
});

test("same empty project nodes still fingerprint every meaningful page state", () => {
    const base = buildProjectAgentSnapshot(detail, "chapters", chapter);
    for (const patch of [{ contentUnitId: "one" }, { activePanel: "assets" }, { blockers: ["草稿"] }, { contentUnitRevision: 4 }, { projectRevision: 3 }, { contextKind: "canvas" as const }]) {
        expect(hashCanvasAgentSnapshot({ ...base, ...patch })).not.toBe(hashCanvasAgentSnapshot(base));
    }
    const session = { projectId: "project", domainProjectId: "project", canvasId: null, contentUnitId: "two", brainProfileId: "codex.subscription" };
    expect(matchesAgentSessionScope(session as never, base, "codex.subscription")).toBe(true);
    for (const patch of [{ canvasId: "old-canvas" }, { domainProjectId: "other" }, { contentUnitId: "one" }, { brainProfileId: "openai.api" }]) expect(matchesAgentSessionScope({ ...session, ...patch } as never, base, "codex.subscription")).toBe(false);
});

test("project publisher clears formal canvas and stale cleanup cannot erase new owner", async () => {
    const messages: unknown[] = [];
    globalThis.window = Object.assign(new EventTarget(), { webkit: { messageHandlers: { filmosDesktop: { postMessage: (value: unknown) => messages.push(value) } } } }) as unknown as Window & typeof globalThis;
    const context = buildProjectWorkbenchContext(buildProjectAgentSnapshot(detail, "chapters", chapter));
    expect(context.canvasId).toBeNull();
    await expect(buildLiveWorkbenchContextDraft(context)).rejects.toThrow("LIVE_CANVAS_CONTEXT_REQUIRED");
    const clearOld = publishWorkbenchContext(context);
    const clearNew = publishWorkbenchContext({ ...context, activePanel: "assets" });
    clearOld();
    expect(window.filmOSGetWorkbenchContext?.()?.activePanel).toBe("assets");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ context: null, canvasId: "", projectId: "" });
    clearNew();
    expect(window.filmOSGetWorkbenchContext).toBeUndefined();
    expect(messages).toHaveLength(3);
});

test("project page reads saved content but blocks dirty writes and every canvas-dependent tool before API", async () => {
    const calls: string[] = [];
    apiClient.defaults.adapter = async config => {
        calls.push(config.url || "");
        return { data: { code: 0, data: detail, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
    };
    const snapshot = buildProjectAgentSnapshot(detail, "chapters", { ...chapter, dirty: true });
    expect(await runProjectAgentTool("project_get_context", {}, "project", undefined, () => snapshot)).toEqual(detail);
    for (const name of ["project_create_script", "project_revise_script", "project_sync_storyboard", "project_save_prompt", "project_read_shot_image"] as const) {
        await expect(runProjectAgentTool(name, {}, "project", undefined, () => snapshot)).rejects.toThrow();
    }
    await expect(runProjectAgentTool("project_get_context", {}, "project", "old-canvas", () => snapshot)).rejects.toThrow();
    await expect(runProjectAgentTool("project_get_context", {}, "other", undefined, () => snapshot)).rejects.toThrow();
    expect(calls).toEqual(["/projects/project"]);
});

import { describe, expect, test } from "bun:test";
import { ApiError, apiClient } from "../src/services/api/request";
import { hashScriptContent } from "../src/film/story/script-version";
import { canvasPromptRequestHash, CanvasPromptSaveError, getCanvasPrompt, getCanvasPromptHistory, getCanvasPromptRevision, saveAndVerifyCanvasPrompt, verifyCanvasPromptContext, type CanvasPromptContext, type CanvasPromptInput, type CanvasPromptReceipt, type CanvasPromptRevision } from "../src/services/api/canvas-prompts";
import { localCanvasPromptBaseline, mergeCanvasPromptContext } from "../src/lib/canvas/canvas-prompt-merge";
import { documentTextFromHtml } from "../src/lib/document-text";
import type { CanvasNodeData, StoryboardRow } from "../src/types/canvas";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { projectPromptToolNames, runProjectPromptTool } from "../src/services/api/project-prompt-tools";
import { isProjectAgentReadTool, projectAgentToolNames } from "../src/services/api/project-agent-tools";

async function fixture() {
    const old = "<p>原版 <strong>对白</strong></p>";
    const input: CanvasPromptInput = { projectId: "project", nodeId: "node", rowId: "project-shot:shot", kind: "image", requestId: "once", expectedRevision: 0, expectedContentHash: await hashScriptContent(old), dependencyHash: "d".repeat(64), prompt: "## 测试草稿\n\n<p>精确保留 <>& \u2028 \u2029 与**格式**。</p>" };
    const context = { ...input, canvasId: "canvas", writeToken: "", prompt: old, state: { revision: 0, contentHash: input.expectedContentHash, dependencyHash: "" }, managed: false, dependencies: { project: { id: "project" }, source: { unitId: "unit", revision: 1, hash: "a".repeat(64), title: "隔离章" }, shot: { id: "shot", projectId: "project", unitId: "unit", revision: 1, content: { scene: "测试场景" } }, direction: {}, assets: [] }, dependencyHash: input.dependencyHash, stale: false, writeBlockers: [], localOverrides: [] } as unknown as CanvasPromptContext;
    let receipt: CanvasPromptReceipt | undefined;
    let writes = 0;
    const port = {
        saveCanvasPrompt: async (_id: string, request: CanvasPromptInput) => {
            if (receipt) return { receipt: structuredClone(receipt), replayed: true };
            const revision: CanvasPromptRevision = { id: "revision", canvasId: "canvas", nodeId: request.nodeId, rowId: request.rowId, kind: request.kind, revision: 1, prompt: request.prompt, contentHash: await hashScriptContent(request.prompt), dependencyHash: request.dependencyHash, dependencies: structuredClone(context.dependencies), requestId: request.requestId, createdAt: "2026-09-06T00:00:00Z" };
            receipt = { id: "receipt", canvasId: "canvas", requestId: request.requestId, requestHash: await canvasPromptRequestHash(request), snapshot: revision, createdAt: revision.createdAt };
            Object.assign(context, { prompt: revision.prompt, managed: true, writeToken: "b".repeat(64), canvasUpdatedAt: revision.createdAt, state: { revision: 1, contentHash: revision.contentHash, dependencyHash: revision.dependencyHash } });
            writes++;
            return { receipt: structuredClone(receipt), replayed: false };
        },
        getCanvasPrompt: async () => structuredClone(context),
        getCanvasPromptReceipt: async () => { if (!receipt) throw new ApiError("未找到回执", { status: 404 }); return structuredClone(receipt); },
        getCanvasPromptRevision: async () => { if (!receipt) throw new ApiError("未找到版本", { status: 404 }); return structuredClone(receipt.snapshot); },
    };
    const row = { id: input.rowId, imageGenerationPrompt: old, videoMotionPrompt: "未修改视频词", projectShotSource: { id: "shot", revision: 1 }, camera: "手工镜头", shotNumber: 1 } as StoryboardRow;
    const nodes = [{ id: "node", type: "script", position: { x: 10, y: 20 }, metadata: { chapterId: "unit", storyboard: { rows: [row, { ...row, id: "untouched" }] } } }] as CanvasNodeData[];
    return { input, context, port, nodes, writes: () => writes };
}

describe("native prompt persistence verification", () => {
    test("long saved drafts and unknown fields never enter readback URLs", async () => {
        const f = await fixture();
        const input = { ...f.input, prompt: "完整对白与长段落。\n".repeat(1500), privateField: "test-only-not-a-credential" };
        const adapter = apiClient.defaults.adapter;
        const reads: string[][] = [];
        apiClient.defaults.adapter = async config => {
            let data: unknown;
            if (config.method === "post") {
                data = await f.port.saveCanvasPrompt("canvas", JSON.parse(config.data));
            } else if (config.url?.includes("/requests/")) {
                data = await f.port.getCanvasPromptReceipt();
            } else {
                reads.push(Object.keys(config.params || {}).sort());
                data = config.url?.endsWith("/history") ? [] : config.url?.includes("/history/") ? await f.port.getCanvasPromptRevision() : await f.port.getCanvasPrompt();
            }
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data, msg: "ok" } };
        };
        try {
            expect(await saveAndVerifyCanvasPrompt("canvas", input)).toMatchObject({ persisted: true, matchesCurrent: true });
            await getCanvasPrompt("canvas", input);
            await getCanvasPromptHistory("canvas", input);
            await getCanvasPromptRevision("canvas", input, 1);
            expect(reads).toHaveLength(5);
            for (const keys of reads) expect(keys).toEqual(["kind", "nodeId", "projectId", "rowId"]);
            expect(f.context.prompt).toBe(input.prompt);
            expect(f.writes()).toBe(1);
        } finally { apiClient.defaults.adapter = adapter; }
    });
    test("exact text/readback and original request replay only write once", async () => {
        const f = await fixture();
        expect(await saveAndVerifyCanvasPrompt("canvas", f.input, f.port)).toMatchObject({ persisted: true, matchesCurrent: true, replayed: false });
        expect(await saveAndVerifyCanvasPrompt("canvas", f.input, f.port)).toMatchObject({ persisted: true, matchesCurrent: true, replayed: true });
        expect(f.context.prompt).toBe(f.input.prompt);
        expect(f.writes()).toBe(1);
    });
    test("lost POST response recovers the same persisted receipt; newer current is not replaced", async () => {
        const f = await fixture(), save = f.port.saveCanvasPrompt;
        f.port.saveCanvasPrompt = async (...args) => { await save(...args); throw new Error("lost response"); };
        expect(await saveAndVerifyCanvasPrompt("canvas", f.input, f.port)).toMatchObject({ persisted: true, recoveredResponse: true });
        f.context.prompt = "另一个已保存新稿";
        f.context.state = { ...f.context.state, revision: 2, contentHash: await hashScriptContent(f.context.prompt) };
        expect(await saveAndVerifyCanvasPrompt("canvas", f.input, f.port)).toMatchObject({ persisted: true, matchesCurrent: false });
        expect(f.context.prompt).toBe("另一个已保存新稿");
        expect(f.writes()).toBe(1);
    });
    test("explicit rejection with absent receipt is editable; timeout/5xx remains uncertain", async () => {
        for (const status of [409, 500, 0]) {
            const f = await fixture();
            f.port.saveCanvasPrompt = async () => { throw new ApiError("rejected or uncertain", { status }); };
            try { await saveAndVerifyCanvasPrompt("canvas", f.input, f.port); throw new Error("unexpected success"); }
            catch (error) { expect(error instanceof CanvasPromptSaveError).toBe(status === 409); }
            expect(f.writes()).toBe(0);
        }
    });
    test("bad target/hash/current/receipt must not claim persisted verification", async () => {
        for (const bad of ["target", "literal", "revision", "receipt", "dependencies", "timestamp"]) {
            const f = await fixture();
            if (bad === "receipt") { const get = f.port.getCanvasPromptReceipt; f.port.getCanvasPromptReceipt = async () => ({ ...await get(), requestHash: "0".repeat(64) }); }
            else { const get = f.port.getCanvasPrompt; f.port.getCanvasPrompt = async () => {
                const value = await get();
                if (bad === "target") value.projectId = "other";
                if (bad === "literal") value.prompt += "corrupt";
                if (bad === "revision") value.state.revision = -1;
                if (bad === "dependencies") value.dependencies.shot.unitId = "other-unit";
                if (bad === "timestamp") value.canvasUpdatedAt = "not-a-time";
                return value;
            }; }
            await expect(saveAndVerifyCanvasPrompt("canvas", f.input, f.port)).rejects.toThrow();
        }
    });
    test("invalid and oversized drafts are rejected before POST", async () => {
        const f = await fixture();
        for (const patch of [{ prompt: " " }, { prompt: "文".repeat(22000) }, { expectedRevision: -1 }, { dependencyHash: "bad" }]) await expect(saveAndVerifyCanvasPrompt("canvas", { ...f.input, ...patch }, f.port)).rejects.toThrow();
        expect(f.writes()).toBe(0);
        await expect(verifyCanvasPromptContext(f.context, "other", f.input)).rejects.toThrow();
    });
    test("request hash matches Go JSON ordering and HTML escaping", async () => {
        const f = await fixture();
        const serialized = JSON.stringify(f.input).replace(/[<>&\u2028\u2029]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
        expect(await canvasPromptRequestHash(f.input)).toBe(await hashScriptContent(serialized));
        expect(await canvasPromptRequestHash({ ...f.input, prompt: f.input.prompt + " " })).not.toBe(await canvasPromptRequestHash(f.input));
    });
});

describe("one-row merge and readable presentation", () => {
    test("merge preserves other rows, other kind, manual direction and layout", async () => {
        const f = await fixture(), before = localCanvasPromptBaseline(f.nodes, f.input);
        await saveAndVerifyCanvasPrompt("canvas", f.input, f.port);
        f.nodes[0].metadata!.storyboard!.rows[0].camera = "等待时修改的构图";
        const after = mergeCanvasPromptContext(f.nodes, before, f.context);
        expect(after[0].position).toEqual(f.nodes[0].position);
        expect(after[0].metadata!.storyboard!.rows[1]).toBe(f.nodes[0].metadata!.storyboard!.rows[1]);
        expect(after[0].metadata!.storyboard!.rows[0]).toMatchObject({ imageGenerationPrompt: f.input.prompt, videoMotionPrompt: "未修改视频词", camera: "等待时修改的构图", promptDrafts: { image: f.context.state } });
        expect(mergeCanvasPromptContext(after, before, f.context)).toBe(after);
    });
    test("intervening literal, deletion, source mismatch and newer revision are preserved", async () => {
        for (const change of ["literal", "delete", "source", "newer"]) {
            const f = await fixture(), before = localCanvasPromptBaseline(f.nodes, f.input);
            await saveAndVerifyCanvasPrompt("canvas", f.input, f.port);
            const row = f.nodes[0].metadata!.storyboard!.rows[0];
            if (change === "literal") row.imageGenerationPrompt = "手工未保存草稿";
            if (change === "delete") f.nodes[0].metadata!.storyboard!.rows.shift();
            if (change === "source") f.nodes[0].metadata!.chapterId = "other";
            if (change === "newer") row.promptDrafts = { image: { ...f.context.state, revision: 2 } };
            const unchanged = structuredClone(f.nodes);
            expect(() => mergeCanvasPromptContext(f.nodes, before, f.context)).toThrow();
            expect(f.nodes).toEqual(unchanged);
        }
    });
    test("display conversion reuses chapter reader and never mutates original text", () => {
        const original = "<h2>剧本</h2><p>场景：雨夜。</p><p><strong>林夏：</strong>我陪你。</p>";
        expect(documentTextFromHtml(original)).toBe("## 剧本\n\n场景：雨夜。\n\n**林夏：**我陪你。");
        expect(original).toContain("<p>");
        expect(documentTextFromHtml("## 剧本\n\n**林夏：**我陪你。")).toBe("## 剧本\n\n**林夏：**我陪你。");
    });
});

describe("prompt tools share the native save authority", () => {
    test("current/point revision/original receipt and guarded save expose real verification", async () => {
        const f = await fixture();
        const port = {
            load: async () => ({ context: structuredClone(f.context), appliedLocally: true }),
            save: async (id: string, input: CanvasPromptInput) => ({ ...await saveAndVerifyCanvasPrompt(id, input, f.port), appliedLocally: true }),
            getRemoteCanvasProject: async () => ({ project: { id: "canvas", projectId: "project" } as CanvasProject }),
            getCanvasPromptHistory: async () => [],
            getCanvasPromptRevision: f.port.getCanvasPromptRevision,
            getCanvasPromptReceipt: f.port.getCanvasPromptReceipt,
        };
        expect(await runProjectPromptTool("project_get_prompt", f.input, "project", "canvas", port)).toMatchObject({ managed: false, state: { revision: 0 } });
        expect(await runProjectPromptTool("project_save_prompt", f.input, "project", "canvas", port)).toMatchObject({ ok: true, data: { verification: { persisted: true, matchesCurrent: true, appliedLocally: true }, location: { canvasId: "canvas", rowId: f.input.rowId } } });
        expect(await runProjectPromptTool("project_get_prompt_revision", { ...f.input, revision: 1 }, "project", "canvas", port)).toMatchObject({ historical: true, revision: { prompt: f.input.prompt, revision: 1 } });
        expect(await runProjectPromptTool("project_get_prompt_request", f.input, "project", "canvas", port)).toMatchObject({ historical: true, receipt: { requestId: "once" } });
        f.context.stale = true;
        expect(await runProjectPromptTool("project_save_prompt", f.input, "project", "canvas", port)).toMatchObject({ ok: false, data: { verification: { persisted: true, sourceCurrent: false } } });
        expect(f.writes()).toBe(1);
        for (const name of projectPromptToolNames) {
            expect(projectAgentToolNames.includes(name)).toBe(true);
            expect(isProjectAgentReadTool(name)).toBe(name !== "project_save_prompt");
            await expect(runProjectPromptTool(name, { ...f.input, canvasId: "other" }, "project", "canvas", port)).rejects.toThrow("授权");
            await expect(runProjectPromptTool(name, { ...f.input, projectId: "other" }, "project", "canvas", port)).rejects.toThrow("授权");
            await expect(runProjectPromptTool(name, f.input, "project", undefined, port)).rejects.toThrow("授权");
        }
        port.getRemoteCanvasProject = async () => ({ project: { id: "canvas", projectId: "other-project" } as CanvasProject });
        await expect(runProjectPromptTool("project_get_prompt_request", f.input, "project", "canvas", port)).rejects.toThrow("历史不属于");
    });
});

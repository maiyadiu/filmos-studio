import { describe, expect, test } from "bun:test";
import { applyScriptEdits, runProjectScriptTool } from "../src/services/api/project-script-tools";
import { hashScriptContent } from "../src/film/story/script-version";
import type { ProjectUnit, ProjectScriptRevision, ProjectScriptUpdate } from "../src/services/api/projects";

const source = "<p>场景：客厅</p><p>林夏：我不走。</p><p>动作：门关上。</p>";
const input = { unitId: "unit", expectedRevision: 1, requestId: "edit-one", note: "只改对白", edits: [{ oldText: "我不走。", newText: "我陪你。" }] };
async function fixture() {
    let unit: ProjectUnit = { id: "unit", projectId: "project", kind: "chapter", title: "第一场", sourceText: source, revision: 1, shotRevision: 0, status: "draft", position: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const original: ProjectScriptRevision = { ...unit, unitId: unit.id, sourceHash: await hashScriptContent(source), requestId: "", note: "", createdBy: "" };
    const rows = new Map([[1, original]]);
    let writes = 0;
    const port = {
        getProjectUnit: async () => ({ unit }),
        getProjectScriptRevision: async (_p: string, _u: string, revision: number) => ({ revision: rows.get(revision)! }),
        reviseProjectScript: async (_p: string, _u: string, req: ProjectScriptUpdate) => {
            writes++;
            unit = { ...unit, sourceText: req.sourceText, revision: 2 };
            const revision: ProjectScriptRevision = { ...original, id: "revision-two", revision: 2, sourceText: req.sourceText, sourceHash: await hashScriptContent(req.sourceText), requestId: req.requestId, note: req.note! };
            rows.set(2, revision);
            return { unit, revision, replayed: false };
        },
    };
    return { port, rows, writes: () => writes };
}

describe("script revision tools", () => {
    test("changes only the unique requested fragment", () => {
        expect(applyScriptEdits(source, input.edits)).toBe(source.replace("我不走。", "我陪你。"));
        for (const edits of [[], [{ oldText: "", newText: "x" }], [{ oldText: "不存在", newText: "x" }], [{ oldText: "<p>", newText: "x" }], [{ oldText: "我不走。", newText: "我不走。" }]]) expect(() => applyScriptEdits(source, edits)).toThrow();
    });
    test("reads the full script and persists with verified before/after receipts", async () => {
        const f = await fixture();
        expect(await runProjectScriptTool("project_get_script", { unitId: "unit" }, "project", f.port)).toMatchObject({ unit: { sourceText: source, revision: 1 }, editable: true });
        const result = await runProjectScriptTool("project_revise_script", input, "project", f.port);
        expect(result).toMatchObject({ ok: true, data: { before: { sourceText: source }, after: { revision: 2, sourceText: source.replace("我不走。", "我陪你。") }, verification: { ok: true, persisted: true } } });
        expect(f.writes()).toBe(1);
        expect(await runProjectScriptTool("project_get_script_revision", { unitId: "unit", revision: 1 }, "project", f.port)).toMatchObject({ revision: { sourceText: source } });
    });
    test("rejects a different or absent bound project before any write", async () => {
        const f = await fixture();
        await expect(runProjectScriptTool("project_revise_script", { ...input, projectId: "other" }, "project", f.port)).rejects.toThrow("授权项目");
        await expect(runProjectScriptTool("project_revise_script", input, "", f.port)).rejects.toThrow("授权项目");
        expect(f.writes()).toBe(0);
    });
    test("does not write when the base hash, state, or fragment is invalid", async () => {
        for (const kind of ["hash", "state", "fragment"] as const) {
            const f = await fixture();
            if (kind === "hash") f.rows.get(1)!.sourceHash = "0".repeat(64);
            if (kind === "state") f.rows.get(1)!.status = "completed";
            const next = kind === "fragment" ? { ...input, edits: [{ oldText: "错的正文", newText: "x" }] } : input;
            await expect(runProjectScriptTool("project_revise_script", next, "project", f.port)).rejects.toThrow();
            expect(f.writes()).toBe(0);
        }
    });
    test("does not claim success when save or readback fails", async () => {
        const f = await fixture();
        f.port.reviseProjectScript = async () => { throw new Error("409 stale revision"); };
        await expect(runProjectScriptTool("project_revise_script", input, "project", f.port)).rejects.toThrow("409");
        const g = await fixture();
        const save = g.port.reviseProjectScript;
        g.port.reviseProjectScript = async (...args) => { const result = await save(...args); g.rows.get(2)!.sourceHash = "0".repeat(64); return result; };
        await expect(runProjectScriptTool("project_revise_script", input, "project", g.port)).rejects.toThrow("哈希");
    });
});

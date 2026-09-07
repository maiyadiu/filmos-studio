import { test, expect } from "bun:test";
import { runProjectScriptCreationTool, type ScriptCreationInput, type ScriptCreationResult } from "../src/services/api/project-script-creation";
import { hashScriptContent } from "../src/film/story/script-version";
import type { ProjectUnit } from "../src/services/api/projects";

const input: ScriptCreationInput = { expectedProjectRevision: 1, requestId: "draft", note: "创作", chapters: [{ title: "雨夜", sourceText: "<p>林：等我。</p>" }] };
async function fixture() {
    const unit: ProjectUnit = { id: "u", projectId: "p", kind: "chapter", title: "雨夜", sourceText: input.chapters[0].sourceText, revision: 1, shotRevision: 0, status: "draft", position: 0, createdAt: "now", updatedAt: "now" };
    const result: ScriptCreationResult = { receipt: { id: "b", projectId: "p", requestId: "draft", requestHash: "a".repeat(64), projectRevision: 2, unitIds: ["u"], createdBy: "owner", createdAt: "now" }, revisions: [{ unitId: "u", ...unit, sourceHash: await hashScriptContent(unit.sourceText), requestId: "draft", note: "创作", createdBy: "owner" }], replayed: false };
    let writes = 0;
    const port = { createProjectScript: async () => { writes++; return result; }, getProjectScriptBatch: async () => result, getProjectUnit: async () => ({ unit }) };
    return { result, unit, port, writes: () => writes };
}
test("create script verifies persisted batch, complete text and current version", async () => {
    const f = await fixture();
    expect(await runProjectScriptCreationTool("project_create_script", { ...input }, "p", f.port)).toMatchObject({ ok: true, data: { verification: { persisted: true, matchesCurrent: true } } });
    f.unit.revision = 2; f.unit.sourceText = "已打磨";
    expect(await runProjectScriptCreationTool("project_get_script_batch", { requestId: "draft" }, "p", f.port)).toMatchObject({ data: { verification: { persisted: true, matchesCurrent: false } } });
    expect(f.writes()).toBe(1);
});
test("creation rejects scope, empty body and stale readback without inventing success", async () => {
    const f = await fixture();
    for (const args of [{ ...input, projectId: "other" }, { ...input, chapters: [] }, { ...input, expectedProjectRevision: 0 }, { ...input, chapters: [{ title: "x", sourceText: " " }] }]) {
        await expect(runProjectScriptCreationTool("project_create_script", args, "p", f.port)).rejects.toThrow();
    }
    expect(f.writes()).toBe(0);
    f.result.revisions[0].sourceHash = "0".repeat(64);
    await expect(runProjectScriptCreationTool("project_create_script", { ...input }, "p", f.port)).rejects.toThrow("哈希");
});

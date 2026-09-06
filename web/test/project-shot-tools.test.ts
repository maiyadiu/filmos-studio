import { describe, expect, test } from "bun:test";
import { hashScriptContent } from "../src/film/story/script-version";
import { runProjectShotTool } from "../src/services/api/project-shot-tools";
import { runProjectAgentTool, projectAgentToolNames, isProjectAgentReadTool } from "../src/services/api/project-agent-tools";
import type { ProjectShotBatchInput, ProjectShotBatchReceipt, ProjectShotContext } from "../src/services/api/projects";

async function fixture() {
    const sourceText = "<p>林夏：我陪你。</p>";
    const sourceHash = await hashScriptContent(sourceText);
    const input = {
        unitId: "unit", requestId: "once", expectedShotRevision: 0, sourceRevision: 1, sourceHash, sourceParagraphIds: ["p0001"],
        shots: [{ expectedRevision: 0, title: "回应", description: "林夏回应", position: 0, durationMs: 5000, content: {
            sourceReferences: [{ paragraphId: "p0001", quote: "林夏：我陪你。" }], scene: "客厅", characters: ["林夏"],
            dialogue: [{ speaker: "林夏", text: "我陪你。", paragraphId: "p0001" }], action: "林夏回应", camera: "中景",
        } }],
    };
    const context: ProjectShotContext = {
        unit: { id: "unit", projectId: "p", kind: "chapter", title: "隔离章", sourceText, revision: 1, shotRevision: 0, status: "draft", position: 0, createdAt: "now", updatedAt: "now" },
        sourceHash, paragraphs: [{ id: "p0001", text: "林夏：我陪你。" }], shots: [], staleShotIds: [],
        coverage: { coveredParagraphIds: [], missingParagraphIds: ["p0001"], dialogueMatches: false, chapterComplete: false },
    };
    let receipt: ProjectShotBatchReceipt | undefined;
    let writes = 0;
    const port = {
        getProjectShotContext: async () => structuredClone(context),
        getProjectShotBatch: async () => {
            if (!receipt) throw new Error("404");
            return { receipt: structuredClone(receipt) };
        },
        getProjectShotRevisions: async () => ({ revisions: receipt ? [{ id: "r1", projectId: "p", unitId: "unit", shotId: "s1", revision: 1, shot: structuredClone(receipt.shots[0]), requestId: "once", contentHash: "server-hash", createdBy: "owner", createdAt: "now" }] : [] }),
        saveProjectUnitShots: async (_p: string, _u: string, req: ProjectShotBatchInput) => {
            if (receipt) return { receipt: structuredClone(receipt), replayed: true };
            const { expectedRevision: _, ...shotInput } = structuredClone(req.shots[0]);
            receipt = {
                id: "receipt", projectId: "p", unitId: "unit", requestId: req.requestId, requestHash: "request-hash", shotRevision: 1, sourceRevision: 1, sourceHash, sourceParagraphIds: req.sourceParagraphIds,
                shots: [{ ...shotInput, id: "s1", projectId: "p", unitId: "unit", revision: 1, sourceRevision: 1, sourceHash, status: "draft", createdAt: "now", updatedAt: "now" }], createdBy: "owner", createdAt: "now",
            };
            writes++;
            context.shots = structuredClone(receipt.shots);
            context.unit.shotRevision = 1;
            return { receipt: structuredClone(receipt), replayed: false };
        },
    };
    return { input, port, context, writes: () => writes };
}

describe("business shot tools", () => {
    test("returns source paragraphs and saves one batch with persisted current readback", async () => {
        const f = await fixture();
        expect(await runProjectShotTool("project_get_shots", { unitId: "unit" }, "p", f.port)).toMatchObject({ editable: true, paragraphs: [{ id: "p0001", text: "林夏：我陪你。" }] });
        expect(await runProjectShotTool("project_create_or_update_shots", f.input, "p", f.port)).toMatchObject({ ok: true, data: { replayed: false, verification: { persisted: true, matchesCurrent: true } } });
        expect(await runProjectShotTool("project_get_shot_batch", f.input, "p", f.port)).toMatchObject({ historicalReceipt: true, receipt: { requestId: "once" } });
        expect(await runProjectShotTool("project_get_shot_revisions", { shotId: "s1" }, "p", f.port)).toMatchObject({ revisions: [{ shotId: "s1", revision: 1 }] });
        expect(f.writes()).toBe(1);
    });
    test("lost reply retry does not duplicate and old receipt is not called current", async () => {
        const f = await fixture(), save = f.port.saveProjectUnitShots;
        f.port.saveProjectUnitShots = async (...args) => { await save(...args); throw new Error("lost response"); };
        await expect(runProjectShotTool("project_create_or_update_shots", f.input, "p", f.port)).rejects.toThrow("lost response");
        f.port.saveProjectUnitShots = save;
        expect(await runProjectShotTool("project_create_or_update_shots", f.input, "p", f.port)).toMatchObject({ data: { replayed: true, verification: { matchesCurrent: true } } });
        f.context.shots[0].revision = 2;
        f.context.shots[0].content.camera = "用户改为近景";
        f.context.unit.shotRevision = 2;
        expect(await runProjectShotTool("project_create_or_update_shots", f.input, "p", f.port)).toMatchObject({ data: { verification: { persisted: true, matchesCurrent: false } } });
        expect(f.context.shots[0].content.camera).toBe("用户改为近景");
        expect(f.writes()).toBe(1);
    });
    test("rejects bad scope/version/items without filtering or writing", async () => {
        const f = await fixture();
        for (const input of [{ ...f.input, projectId: "other" }, { ...f.input, expectedShotRevision: undefined }, { ...f.input, sourceRevision: 0 }, { ...f.input, shots: [f.input.shots[0], null] }]) {
            await expect(runProjectShotTool("project_create_or_update_shots", input, "p", f.port)).rejects.toThrow();
        }
        expect(f.writes()).toBe(0);
        for (const name of projectAgentToolNames) {
            await expect(runProjectAgentTool(name, { projectId: "other" }, "p")).rejects.toThrow("授权项目");
            await expect(runProjectAgentTool(name, { projectId: "p" })).rejects.toThrow("授权项目");
        }
        for (const name of ["project_get_shots", "project_get_shot_batch", "project_get_shot_revisions"]) expect(isProjectAgentReadTool(name)).toBe(true);
        expect(isProjectAgentReadTool("project_create_or_update_shots")).toBe(false);
    });
    test("does not claim verification for mismatched hash/receipt/content", async () => {
        for (const bad of ["hash", "receipt", "content"]) {
            const f = await fixture();
            if (bad === "hash") f.context.sourceHash = "0".repeat(64);
            else {
                const get = f.port.getProjectShotBatch;
                f.port.getProjectShotBatch = async () => {
                    const value = await get();
                    if (bad === "receipt") value.receipt.projectId = "other";
                    else value.receipt.shots[0].content.action = "未保存的动作";
                    return value;
                };
            }
            await expect(runProjectShotTool("project_create_or_update_shots", f.input, "p", f.port)).rejects.toThrow();
        }
    });
});

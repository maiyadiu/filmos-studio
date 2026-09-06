import assert from "node:assert/strict";
import test from "node:test";
import { toolInputSchemas } from "../src/schemas.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";

test("shot batch schema requires exact source, versions and structured content", () => {
    const shot = { title: "林夏回应", description: "回应", expectedRevision: 0, position: 0, durationMs: 5000, content: { scene: "客厅", characters: ["林夏"], action: "回应", camera: "中景", dialogue: [{ speaker: "林夏", text: "我陪你。", paragraphId: "p0001" }], sourceReferences: [{ paragraphId: "p0001", quote: "林夏：我陪你。" }] } };
    const input = { unitId: "unit", requestId: "once", sourceRevision: 1, sourceHash: "a".repeat(64), sourceParagraphIds: ["p0001"], expectedShotRevision: 0, shots: [shot] };
    const schema = toolInputSchemas.project_create_or_update_shots;
    assert.equal(schema.safeParse(input).success, true);
    for (const invalid of [
        { shots: [{ title: "legacy" }] }, { ...input, expectedShotRevision: undefined }, { ...input, sourceHash: "bad" },
        { ...input, shots: [shot, { ...shot, content: undefined }] }, { ...input, shots: [{ ...shot, content: { ...shot.content, assetId: "invented" } }] },
        { ...input, shots: [{ ...shot, expectedRevision: undefined }] },
    ]) assert.equal(schema.safeParse(invalid).success, false);
});

test("shot read tools are fresh scoped reads and batch is a non-paid write", () => {
    const manifest = new CanonicalAgentToolManifest();
    for (const name of ["project_get_shots", "project_get_shot_batch", "project_get_shot_revisions", "project_create_or_update_shots"]) {
        const tool = manifest.get(name);
        assert.equal(tool.risk, name === "project_create_or_update_shots" ? "write" : "read");
        assert.equal(tool.provider, "host_project");
        assert.equal(tool.requiresFreshContext, true);
        assert.equal(tool.mayCreateCharges, false);
        assert.ok(tool.surfaces.includes("workbench_operator"));
    }
});

test("native storyboard sync freezes source version and cannot choose another canvas or generation", () => {
    const input = { unitId: "unit", expectedShotRevision: 2, sourceRevision: 3, sourceHash: "a".repeat(64) };
    const schema = toolInputSchemas.project_sync_storyboard;
    assert.equal(schema.safeParse(input).success, true);
    for (const patch of [{ canvasId: "other" }, { generate: true }, { sourceHash: "bad" }, { sourceRevision: 0 }, { expectedShotRevision: undefined }]) assert.equal(schema.safeParse({ ...input, ...patch }).success, false);
    const tool = new CanonicalAgentToolManifest().get("project_sync_storyboard");
    assert.equal(tool.risk, "write");
    assert.equal(tool.provider, "host_project");
    assert.equal(tool.requiresFreshContext, true);
    assert.equal(tool.mayCreateCharges, false);
});

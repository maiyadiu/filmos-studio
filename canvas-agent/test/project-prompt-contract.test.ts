import assert from "node:assert/strict";
import test from "node:test";
import { toolInputSchemas } from "../src/schemas.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";

test("prompt contract binds row/kind, exact source/content state and stable request", () => {
    const target = { nodeId: "node", rowId: "project-shot:shot", kind: "image" };
    const input = { ...target, requestId: "once", expectedRevision: 0, expectedContentHash: "a".repeat(64), dependencyHash: "b".repeat(64), prompt: "隔离验证文字" };
    assert.equal(toolInputSchemas.project_save_prompt.safeParse(input).success, true);
    for (const invalid of [{ ...input, nodeId: "" }, { ...input, kind: "imagegen" }, { ...input, expectedRevision: undefined }, { ...input, expectedContentHash: "bad" }, { ...input, dependencyHash: undefined }, { ...input, generate: true }]) assert.equal(toolInputSchemas.project_save_prompt.safeParse(invalid).success, false);
    assert.equal(toolInputSchemas.project_get_prompt_revision.safeParse({ ...target, revision: 0 }).success, true);
    assert.equal(toolInputSchemas.project_get_prompt_request.safeParse({ ...target, requestId: "once" }).success, true);
});

test("prompt reads and non-paid write stay inside fresh host project broker", () => {
    const manifest = new CanonicalAgentToolManifest();
    for (const name of ["project_get_prompt", "project_save_prompt", "project_get_prompt_revision", "project_get_prompt_request"]) {
        const tool = manifest.get(name);
        assert.equal(tool.risk, name === "project_save_prompt" ? "write" : "read");
        assert.equal(tool.provider, "host_project");
        assert.equal(tool.requiresFreshContext, true);
        assert.equal(tool.mayCreateCharges, false);
        assert.ok(tool.surfaces.includes("workbench_operator"));
    }
});

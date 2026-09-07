import assert from "node:assert/strict";
import test from "node:test";
import { ScriptCreationScope } from "../src/brains/script-creation-scope.js";

test("bounded creation never authorizes old chapters, excess revisions or media", () => {
    const scope = new ScriptCreationScope("p", { requestId: "script-one", chapterCount: 2, polishRounds: 1 });
    assert.equal(scope.allows("project_create_script", { requestId: "script-one", chapters: [{}, {}] }), true);
    for (const bad of [{ projectId: "foreign", requestId: "script-one", chapters: [{}, {}] }, { requestId: "script-two", chapters: [{}, {}] }, { requestId: "script-one", chapters: [{}] }]) assert.equal(scope.allows("project_create_script", bad), false);
    assert.equal(scope.allows("project_revise_script", { unitId: "u", expectedRevision: 1 }), false);
    for (const name of ["generation_submit", "project_save_prompt", "canvas_apply_ops", "film_command_apply", "canvas_delete_nodes"]) assert.equal(scope.allows(name, {}), false);
    scope.observeCreation({ ok: true, data: { receipt: { projectId: "p", requestId: "script-one", unitIds: ["u", "v"] }, verification: { ok: true, persisted: true, matchesCurrent: true } } });
    assert.equal(scope.allows("project_revise_script", { unitId: "u", expectedRevision: 1 }), true);
    for (const input of [{ unitId: "old", expectedRevision: 1 }, { unitId: "u", expectedRevision: 2 }, { projectId: "other", unitId: "u", expectedRevision: 1 }]) assert.equal(scope.allows("project_revise_script", input), false);
    const nextTurn = new ScriptCreationScope("p", { requestId: "script-two", chapterCount: 2, polishRounds: 1 });
    assert.equal(nextTurn.allows("project_revise_script", { unitId: "u", expectedRevision: 1 }), false);
});
test("invalid receipts and bounds fail closed", () => {
    for (const patch of [{ projectId: "foreign" }, { requestId: "another" }, { unitIds: ["u", "u"] }]) {
        const scope = new ScriptCreationScope("p", { requestId: "script-one", chapterCount: 2, polishRounds: 1 });
        scope.observeCreation({ ok: true, data: { receipt: { projectId: "p", requestId: "script-one", unitIds: ["u", "v"], ...patch }, verification: { ok: true, persisted: true, matchesCurrent: true } } });
        assert.equal(scope.allows("project_revise_script", { unitId: "u", expectedRevision: 1 }), false);
    }
    assert.throws(() => new ScriptCreationScope("p", { requestId: "script-one", chapterCount: 2, polishRounds: 4 }), /INVALID/);
});

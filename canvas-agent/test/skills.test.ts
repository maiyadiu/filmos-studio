import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { codexInput, writeSkillFiles } from "../src/agents.js";
import { parseAgentSkills } from "../src/modules/canvas-agent-http.js";

test("codexInput keeps skills as native UserInput items", () => {
    const input = codexInput("请按技能执行", ["/tmp/reference.png"], [{
        type: "skill",
        name: "canvas-shot-list",
        path: "/tmp/skill/SKILL.md",
    }]);

    assert.deepEqual(input, [
        { type: "text", text: "$canvas-shot-list\n\n请按技能执行", text_elements: [] },
        { type: "localImage", path: "/tmp/reference.png" },
        { type: "skill", name: "canvas-shot-list", path: "/tmp/skill/SKILL.md" },
    ]);
    assert.equal(JSON.stringify(input).includes("$canvas-shot-list"), true);
    assert.deepEqual(codexInput("普通消息", [], [])[0], { type: "text", text: "普通消息", text_elements: [] });
});

test("writeSkillFiles creates Codex-compatible SKILL.md inputs and unique names", async () => {
    const prepared = await writeSkillFiles([
        { skillId: "same", name: "第一个技能", description: "first", instruction: "do first" },
        { skillId: "same", name: "第二个技能", description: "second", instruction: "do second" },
        { skillId: "empty", name: "空技能", instruction: "   " },
    ]);

    try {
        assert.equal(prepared.inputs.length, 2);
        assert.deepEqual(prepared.inputs.map((item) => item.type), ["skill", "skill"]);
        assert.deepEqual(prepared.inputs.map((item) => item.name), ["canvas-same", "canvas-same-2"]);
        for (const item of prepared.inputs) {
            assert.equal(item.path.endsWith("/SKILL.md"), true);
            const body = await fs.readFile(item.path, "utf8");
            assert.match(body, /^---\nname: canvas-same(?:-2)?\ndescription: /);
            assert.match(body, /\n---\n\n#/);
        }
    } finally {
        await Promise.all(prepared.directories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    }
});

test("parseAgentSkills validates and bounds browser skill bundles", () => {
    const input = [
        { skillId: "safe", name: " safe ", description: " desc ", instruction: " instruction " },
        { name: "too long", instruction: "x".repeat(25_000) },
    ];
    const parsed = parseAgentSkills(input);

    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], { skillId: "safe", name: "safe", description: "desc", instruction: " instruction " });
    assert.equal(parsed[1].instruction.length, 25_000);
    assert.throws(() => parseAgentSkills([null]), /SKILL_INVALID/);
    assert.throws(() => parseAgentSkills([{ name: "empty" }]), /SKILL_INVALID/);
    assert.throws(() => parseAgentSkills(Array(9).fill(input[0])), /COUNT_EXCEEDED/);
    assert.throws(() => parseAgentSkills([{ name: "over limit", instruction: "字".repeat(50_000) }]), /TOO_LARGE/);
});

test("native skill body is not silently truncated", async () => {
    const instruction = "  " + "打磨对白与动作\n".repeat(4000) + "末尾要求必须保留";
    const prepared = await writeSkillFiles([{ skillId: "polish", name: "打磨", instruction }]);
    try { assert.ok((await fs.readFile(prepared.inputs[0].path, "utf8")).includes(instruction)); }
    finally { await Promise.all(prepared.directories.map(directory => fs.rm(directory, { recursive: true, force: true }))); }
});

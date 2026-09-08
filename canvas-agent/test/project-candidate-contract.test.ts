import assert from "node:assert/strict";
import test from "node:test";

import { toolInputSchemas, toolDescriptions } from "../src/schemas.js";

const schema = toolInputSchemas.project_extract_asset_candidates;
const details = { role: "来源中的报信者", appearance: "原文未设定", clothing: "原文未设定", personality: "紧张", voiceLanguage: "原文未设定", voiceAge: "原文未设定", voiceTimbre: "原文未设定" };
const candidate = (value: unknown, category = "character") => ({ candidates: [{ name: "fixture", category, details: value }] });

test("character candidates expose and enforce all backend required fields before dispatch", () => {
    assert.equal(schema.safeParse(candidate(details)).success, true);
    for (const key of ["role", "voiceLanguage", "voiceAge", "voiceTimbre"]) {
        for (const value of [undefined, "", "   ", 1]) {
            assert.equal(schema.safeParse(candidate({ ...details, [key]: value })).success, false, `${key}:${value}`);
        }
    }
    assert.equal(schema.safeParse(candidate(undefined)).success, false);
});

test("character candidates need three stable descriptions without automatic invented defaults", () => {
    assert.equal(schema.safeParse(candidate({ ...details, personality: undefined })).success, false);
    assert.equal(schema.safeParse(candidate({ ...details, personality: "   " })).success, false);
    assert.equal(schema.safeParse(candidate({ ...details, physique: "", consistencyPrompt: "" })).success, true);
    const input = candidate({ ...details, aliases: ["原名"], evidence: { paragraph: "p1" } });
    assert.deepEqual(schema.parse(input), input);
    assert.match(toolDescriptions.project_extract_asset_candidates, /原文未设定/);
    assert.match(toolDescriptions.project_extract_asset_candidates, /不得盲目重复新增/);
});

test("non-character categories keep their own details without inheriting voice requirements", () => {
    for (const category of ["environment", "wardrobe", "prop", "weapon", "style", "other"]) {
        assert.equal(schema.safeParse(candidate(undefined, category)).success, true);
        assert.equal(schema.safeParse(candidate({ arbitrary: "source fact" }, category)).success, true);
    }
    assert.equal(schema.safeParse(candidate({}, "unsupported")).success, false);
});

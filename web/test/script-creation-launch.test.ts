import { expect, test } from "bun:test";
import { matchesScriptLaunch, type ScriptLaunch } from "../src/services/script-creation-launch";
test("navigation drafts bind user, project, canvas and bounded creation scope", () => {
    const value: ScriptLaunch = { id: "test-id", userId: "owner", projectId: "p", canvasId: "c", prompt: "创意", skillIds: ["s"], chapterCount: 3, polishRounds: 1, createdAt: 100, claimed: false };
    expect(matchesScriptLaunch(value, "owner", "c", "p", 101)).toBe(true);
    expect(matchesScriptLaunch(value, "other", "c", "p", 101)).toBe(false);
    expect(matchesScriptLaunch(value, "owner", "other", "p", 101)).toBe(false);
    expect(matchesScriptLaunch(value, "owner", "c", "other", 101)).toBe(false);
    expect(matchesScriptLaunch(value, "owner", "c", "p", 100 + 3600001)).toBe(false);
    expect(matchesScriptLaunch({ ...value, polishRounds: 4 }, "owner", "c", "p", 101)).toBe(false);
    expect(matchesScriptLaunch({ ...value, chapterCount: 0 }, "owner", "c", "p", 101)).toBe(false);
});

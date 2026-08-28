import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StoryStudioReviewPanel, buildHostStoryReviewPreview, confirmFilmCoreScriptLock, isFilmStoryStudioEnabled, parseScriptReviewDocument, type FilmCoreScriptLockCommand, type StoryCoreCommandPort } from "../src/film/story";

const SOURCE = "场景：客厅\n林夏：别动。\n吴奶奶：灯还亮着。";
const TARGET = "场景：客厅\n林夏：先别动。\n吴奶奶：灯还亮着。";

describe("Story Studio feature boundary", () => {
    test("is disabled unless the dedicated flag is explicitly true", () => {
        expect(isFilmStoryStudioEnabled({})).toBe(false);
        expect(isFilmStoryStudioEnabled({ VITE_FILM_STORY_STUDIO: "false" })).toBe(false);
        expect(isFilmStoryStudioEnabled({ VITE_FILM_STORY_STUDIO: "1" })).toBe(false);
        expect(isFilmStoryStudioEnabled({ VITE_FILM_STORY_STUDIO: " TRUE " })).toBe(true);
    });
});

describe("Story Studio review preview", () => {
    test("keeps Cue and Section IDs stable across exact dialogue text edits", () => {
        const source = parseScriptReviewDocument(SOURCE);
        const target = parseScriptReviewDocument(TARGET);

        expect(target.sections.map((section) => section.sectionId)).toEqual(source.sections.map((section) => section.sectionId));
        expect(target.dialogueCues.map((cue) => cue.cueId)).toEqual(source.dialogueCues.map((cue) => cue.cueId));
        expect(target.dialogueCues[0].text).toBe("先别动。");
    });

    test("preserves dialogue whitespace for verbatim comparison", () => {
        const document = parseScriptReviewDocument("场景：客厅\n林夏：  别动。  ");
        expect(document.dialogueCues[0].text).toBe("  别动。  ");
    });

    test("shows exact dialogue diff and read-only impact recommendation", async () => {
        const model = await buildHostStoryReviewPreview({
            hostUnitId: "unit-1",
            sourceText: SOURCE,
            targetText: TARGET,
            dirty: true,
            shotDependencies: [{ id: "shot-1", description: "林夏说：别动。随后关灯。" }],
        });

        expect(model.mode).toBe("host_preview");
        expect(model.source.formal).toBe(false);
        expect(model.target.formal).toBe(false);
        expect(model.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(model.target.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(model.diff.dialogue.changes).toContainEqual(expect.objectContaining({ kind: "text_changed", sourceText: "别动。", targetText: "先别动。" }));
        expect(model.impact.impacts).toContainEqual(expect.objectContaining({ targetId: "shot-1", recommendation: "mark_stale" }));
        expect(model.impact.automaticWrites).toBe(false);

        const markup = renderToStaticMarkup(<StoryStudioReviewPanel model={model} />);
        expect(markup).toContain("Story / Script Review");
        expect(markup).toContain("本地预览");
        expect(markup).toContain(model.source.contentHash);
        expect(markup).toContain(model.target.contentHash);
        expect(markup).toContain(model.diff.dialogue.changes[0].cueId);
        expect(markup).toContain("建议 STALE");
        expect(markup).toContain("filmScriptVersionLock");
        expect(markup).toContain("不提供伪锁定按钮");
    });
});

describe("Film Core Script Lock command boundary", () => {
    const command: FilmCoreScriptLockCommand = {
        operationId: "filmScriptVersionLock",
        lockedWrite: { targetId: null, expectedVersion: 0, expectedContentHash: "0".repeat(64) },
        decisionWrite: { targetId: null, expectedVersion: 0, expectedContentHash: "0".repeat(64) },
        actorKind: "human",
        sourceScriptVersion: { filmEntityId: "00000000-0000-4000-8000-000000000001", expectedVersion: 3, expectedContentHash: "a".repeat(64) },
        approvedBy: "user-1",
    };

    test("does not call Core for an Agent or absent human confirmation", async () => {
        const lock = mock(async () => ({ lockedScriptVersionId: "version-locked", decisionId: "decision-1", auditEventIds: ["audit-1"] }));
        const port: StoryCoreCommandPort = { filmScriptVersionLock: lock };

        await expect(confirmFilmCoreScriptLock(port, command, { actorKind: "agent", confirmed: true })).rejects.toThrow("Agent cannot approve");
        await expect(confirmFilmCoreScriptLock(port, command, { actorKind: "human", confirmed: false })).rejects.toThrow("human confirmation is required");
        expect(lock).toHaveBeenCalledTimes(0);
    });

    test("calls the explicit Core command only after human confirmation", async () => {
        const receipt = { lockedScriptVersionId: "version-locked", decisionId: "decision-1", auditEventIds: ["audit-1"] };
        const lock = mock(async () => receipt);
        const port: StoryCoreCommandPort = { filmScriptVersionLock: lock };

        await expect(confirmFilmCoreScriptLock(port, command, { actorKind: "human", confirmed: true })).resolves.toEqual(receipt);
        expect(lock).toHaveBeenCalledTimes(1);
        expect(lock).toHaveBeenCalledWith(command, undefined);
    });
});

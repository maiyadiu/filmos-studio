import { describe, expect, test } from "bun:test";
import {
    STORY_STUDIO_DISABLED,
    StoryStudioDisabledError,
    analyzeScriptImpact,
    assessDownstreamEligibility,
    compareDialogueFidelity,
    compareScriptVersions,
    createScriptVersion,
    hashScriptContent,
    lockScriptVersion,
    recordScriptDecision,
    type DialogueCue,
    type ScriptVersion,
} from "../src/film/story";

const enabled = { enabled: true } as const;
const VERSION_1_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_2_ID = "00000000-0000-4000-8000-000000000002";
const SCRIPT_ID = "00000000-0000-4000-8000-000000000010";
const DECISION_ID = "00000000-0000-4000-8000-000000000101";

describe("ScriptVersion and Script Lock", () => {
    test("film.story_studio disabled blocks version creation", async () => {
        await expect(createVersion(STORY_STUDIO_DISABLED)).rejects.toBeInstanceOf(StoryStudioDisabledError);
    });

    test("preserves exact user text and starts unreviewed and unlocked", async () => {
        const scriptText = "林夏：别动。  \n吴奶奶：我只是想把灯关上。\n";
        const version = await createVersion(enabled, { scriptText });

        expect(version.scriptText).toBe(scriptText);
        expect(version.contentHash).toBe(await hashScriptContent(scriptText));
        expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(version.reviewState).toBe("not_reviewed");
        expect(version.lockState).toBe("unlocked");
        expect((await assessDownstreamEligibility(enabled, version)).eligible).toBe(false);
    });

    test("rejects client-selected non-Film IDs", async () => {
        await expect(createVersion(enabled, { id: "version-1" })).rejects.toThrow("Film Core UUIDv4");
    });

    test("requires a human hash-bound approval before explicit lock", async () => {
        const version = await createVersion(enabled);
        await expect(recordScriptDecision(enabled, version, decisionInput(version, { actorKind: "agent", outcome: "approve_for_lock" }))).rejects.toThrow("only a human");
        await expect(recordScriptDecision(enabled, version, decisionInput(version, { expectedVersion: version.version + 1 }))).rejects.toThrow("optimistic concurrency conflict");

        const reviewed = await recordScriptDecision(enabled, version, decisionInput(version));
        expect(reviewed.version.reviewState).toBe("approved");
        expect(reviewed.version.lockState).toBe("unlocked");

        await expect(
            lockScriptVersion(enabled, reviewed.version, {
                expectedVersion: reviewed.version.version,
                expectedContentHash: "0".repeat(64),
                approvalDecision: reviewed.decision,
                lockedAt: "2026-08-28T03:00:00+08:00",
                lockedBy: "user-1",
            }),
        ).rejects.toThrow("content hash conflict");

        const locked = await lockScriptVersion(enabled, reviewed.version, {
            expectedVersion: reviewed.version.version,
            expectedContentHash: reviewed.version.contentHash,
            approvalDecision: reviewed.decision,
            lockedAt: "2026-08-28T03:00:00+08:00",
            lockedBy: "user-1",
        });
        expect(locked.lockState).toBe("locked");
        expect((await assessDownstreamEligibility(enabled, locked)).eligible).toBe(true);
    });

    test("detects text changed after the recorded content hash", async () => {
        const version = await createVersion(enabled);
        const reviewed = await recordScriptDecision(enabled, version, decisionInput(version));
        const tampered = { ...reviewed.version, scriptText: `${reviewed.version.scriptText}擅自追加` } satisfies ScriptVersion;

        await expect(
            lockScriptVersion(enabled, tampered, {
                expectedVersion: reviewed.version.version,
                expectedContentHash: reviewed.version.contentHash,
                approvalDecision: reviewed.decision,
                lockedAt: "2026-08-28T03:00:00+08:00",
                lockedBy: "user-1",
            }),
        ).rejects.toThrow("no longer matches");
        expect((await assessDownstreamEligibility(enabled, tampered)).reasons).toContain("content_hash_mismatch");
    });
});

describe("dialogue fidelity", () => {
    test("keeps long dialogue faithful only when speaker, text and order remain exact", () => {
        const longLine = "我不是不想回家，我只是每次走到楼下，都会想起那天你站在窗边说的那些话。".repeat(24);
        const source: DialogueCue[] = [
            { cueId: "D-001", speaker: "林夏", text: longLine },
            { cueId: "D-002", speaker: "吴奶奶", text: "灯还亮着，你慢慢说。" },
        ];
        const faithful = compareDialogueFidelity(
            source,
            source.map((cue) => ({ ...cue })),
        );
        expect(faithful.faithful).toBe(true);
        expect(faithful.unchangedCueCount).toBe(2);
        expect(faithful.sourceCharacterCount).toBe(Array.from(longLine).length + Array.from(source[1].text).length);

        const changed = compareDialogueFidelity(source, [{ ...source[1] }, { ...source[0], text: `${longLine}。` }]);
        expect(changed.faithful).toBe(false);
        expect(changed.changedCueIds).toEqual(["D-001", "D-002"]);
        expect(changed.changes.map((change) => change.kind)).toContain("text_changed");
        expect(changed.changes.map((change) => change.kind)).toContain("moved");
    });

    test("rejects duplicate cue ids instead of silently matching the wrong line", () => {
        expect(() =>
            compareDialogueFidelity(
                [
                    { cueId: "D-001", speaker: "甲", text: "一" },
                    { cueId: "D-001", speaker: "乙", text: "二" },
                ],
                [],
            ),
        ).toThrow("must be unique");
    });
});

describe("script impact analysis", () => {
    test("recommends STALE only for dependencies bound to changed cues or sections", async () => {
        const source = await createVersion(enabled);
        const target = await createVersion(enabled, { id: VERSION_2_ID, version: 2, parentVersionId: source.id, scriptText: `${source.scriptText}\n吴奶奶：灯灭了。` });
        const diff = compareScriptVersions(source, target, {
            source: [{ cueId: "D-001", speaker: "林夏", text: "别动。" }],
            target: [{ cueId: "D-001", speaker: "林夏", text: "先别动。" }],
            changedSectionIds: ["S-02"],
        });
        const analysis = analyzeScriptImpact(diff, [
            { targetId: "shot-1", targetType: "shot", sourceContentHash: source.contentHash, dialogueCueIds: ["D-001"] },
            { targetId: "shot-2", targetType: "shot", sourceContentHash: source.contentHash, dialogueCueIds: ["D-009"], sectionIds: ["S-09"] },
            { targetId: "director-2", targetType: "director_unit", sourceContentHash: source.contentHash, sectionIds: ["S-02"] },
            { targetId: "old-shot", targetType: "shot", sourceContentHash: "f".repeat(64), dialogueCueIds: ["D-001"] },
        ]);

        expect(analysis.impacts.map((impact) => impact.targetId)).toEqual(["shot-1", "director-2"]);
        expect(analysis.automaticWrites).toBe(false);
        expect(analysis.unresolvedTargetIds).toEqual([]);
    });

    test("reports unmapped rich-text change without automatically staling every target", async () => {
        const source = await createVersion(enabled);
        const target = await createVersion(enabled, { id: VERSION_2_ID, version: 2, parentVersionId: source.id, scriptText: `${source.scriptText}\n动作：她关灯。` });
        const cues = [{ cueId: "D-001", speaker: "林夏", text: "别动。" }];
        const diff = compareScriptVersions(source, target, { source: cues, target: cues });
        const analysis = analyzeScriptImpact(diff, [{ targetId: "shot-1", targetType: "shot", sourceContentHash: source.contentHash, dialogueCueIds: ["D-001"] }]);

        expect(diff.hasUnmappedContentChange).toBe(true);
        expect(analysis.impacts).toEqual([]);
        expect(analysis.unresolvedTargetIds).toEqual(["shot-1"]);
    });
});

async function createVersion(policy: { enabled: boolean }, overrides: Partial<Parameters<typeof createScriptVersion>[1]> = {}) {
    return createScriptVersion(policy, {
        id: VERSION_1_ID,
        scriptId: SCRIPT_ID,
        hostProjectId: "project-1",
        hostUnitId: "unit-1",
        version: 1,
        title: "第一集",
        scriptText: "林夏：别动。",
        sourceKind: "manual",
        createdAt: "2026-08-28T02:00:00+08:00",
        createdBy: "user-1",
        ...overrides,
    });
}

function decisionInput(version: ScriptVersion, overrides: Partial<Parameters<typeof recordScriptDecision>[2]> = {}) {
    return {
        id: DECISION_ID,
        expectedVersion: version.version,
        expectedContentHash: version.contentHash,
        outcome: "approve_for_lock" as const,
        rationale: "用户逐段复核后确认锁定",
        decidedAt: "2026-08-28T02:30:00+08:00",
        decidedBy: "user-1",
        actorKind: "human" as const,
        ...overrides,
    };
}

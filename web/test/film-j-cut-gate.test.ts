import { describe, expect, test } from "bun:test";

import { evaluateDialogueContinuity, type DialogueContinuityInput, type JCutHumanException } from "@/film/director/j-cut-gate";

const FROM_SHOT = "00000000-0000-4000-8000-000000000001";
const TO_SHOT = "00000000-0000-4000-8000-000000000002";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function exception(overrides: Partial<JCutHumanException> = {}): JCutHumanException {
    return {
        kind: "j_cut_audio_lead",
        cueId: "cue-b-03",
        speakerId: "character-b",
        fromShot: { filmEntityId: FROM_SHOT, expectedVersion: 1, expectedContentHash: HASH_A },
        toShot: { filmEntityId: TO_SHOT, expectedVersion: 2, expectedContentHash: HASH_B },
        leadMilliseconds: 600,
        actorKind: "human",
        approvedBy: "director-golden-b",
        approvedAt: "2026-08-28T10:00:00Z",
        rationale: "让B的声音先进入，再切到B的反应镜头。",
        ...overrides,
    };
}

function input(overrides: Partial<DialogueContinuityInput> = {}): DialogueContinuityInput {
    return {
        enabled: true,
        visualChecks: [
            { dimension: "axis", subjectId: "axis-main", expectedValue: "left", actualValue: "left" },
            { dimension: "eyeline", subjectId: "character-b", expectedValue: "character-a", actualValue: "character-a" },
            { dimension: "blocking", subjectId: "character-b", expectedValue: "seat-right", actualValue: "seat-right" },
        ],
        audioLead: { dimension: "audio_lead", cueId: "cue-b-03", speakerId: "character-b", leadMilliseconds: 600 },
        jCutException: exception(),
        ...overrides,
    };
}

describe("Golden B J-cut gate", () => {
    test("is disabled by default and cannot mutate formal facts", async () => {
        const result = await evaluateDialogueContinuity(input({ enabled: undefined }));
        expect(result).toEqual({
            state: "disabled",
            authority: "projection_only",
            formalMutationAllowed: false,
            blockers: [],
            jCutApplied: false,
        });
    });

    test("allows only a hash-bound human audio-lead exception", async () => {
        const result = await evaluateDialogueContinuity(input());
        expect(result.state).toBe("ready");
        expect(result.jCutApplied).toBe(true);
        expect(result.formalMutationAllowed).toBe(false);
        expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("never lets J-cut hide a visual continuity break", async () => {
        const result = await evaluateDialogueContinuity(
            input({
                visualChecks: [
                    { dimension: "axis", subjectId: "axis-main", expectedValue: "left", actualValue: "right" },
                    { dimension: "blocking", subjectId: "character-b", expectedValue: "seat-right", actualValue: "door" },
                ],
            }),
        );
        expect(result.state).toBe("blocked");
        expect(result.jCutApplied).toBe(true);
        expect(result.blockers.map((item) => item.code)).toEqual(["AXIS_CONTINUITY_BROKEN", "BLOCKING_CONTINUITY_BROKEN"]);
    });

    test("rejects Agent approval and excessive audio lead", async () => {
        await expect(evaluateDialogueContinuity(input({ jCutException: exception({ actorKind: "agent" }) }))).rejects.toThrow("explicit human actor");
        await expect(
            evaluateDialogueContinuity(
                input({
                    audioLead: { dimension: "audio_lead", cueId: "cue-b-03", speakerId: "character-b", leadMilliseconds: 3001 },
                    jCutException: exception({ leadMilliseconds: 3001 }),
                }),
            ),
        ).rejects.toThrow("between 0 and 3000");
    });

    test("blocks an unmatched or missing exception", async () => {
        const missing = await evaluateDialogueContinuity(input({ jCutException: undefined }));
        expect(missing.state).toBe("blocked");
        expect(missing.blockers[0]?.code).toBe("AUDIO_LEAD_EXCEPTION_REQUIRED");
        const wrongCue = await evaluateDialogueContinuity(input({ jCutException: exception({ cueId: "cue-a-01" }) }));
        expect(wrongCue.state).toBe("blocked");
        expect(wrongCue.jCutApplied).toBe(false);
    });
});

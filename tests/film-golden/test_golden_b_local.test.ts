import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

describe("Golden B local integration", () => {
  test("keeps script and costume STALE precise while J-cut remains audio-only", () => {
    const ids = {
      scriptA: randomUUID(),
      scriptB: randomUUID(),
      script: randomUUID(),
      promptCue: randomUUID(),
      promptOther: randomUUID(),
      candidateOther: randomUUID(),
      lockA: randomUUID(),
      lockB: randomUUID(),
      scope: randomUUID(),
      costumePrompt: randomUUID(),
      characterPrompt: randomUUID(),
      fromShot: randomUUID(),
      toShot: randomUUID(),
    };
    const payload = {
      sourceScript: script(ids.scriptA, ids.script, 1, HASH_A),
      targetScript: script(ids.scriptB, ids.script, 2, HASH_B, ids.scriptA),
      sourceCues: cues("我不同意。"),
      targetCues: cues("我不同意，现在就说清楚。"),
      changedSectionIds: ["section-confrontation"],
      scriptDependencies: [
        {
          targetId: ids.promptCue,
          targetType: "prompt_draft",
          sourceContentHash: HASH_A,
          dialogueCueIds: ["cue-b-03"],
        },
        {
          targetId: ids.promptOther,
          targetType: "prompt_draft",
          sourceContentHash: HASH_A,
          dialogueCueIds: ["cue-a-01"],
        },
        {
          targetId: ids.candidateOther,
          targetType: "other",
          sourceContentHash: HASH_C,
          dialogueCueIds: ["cue-b-03"],
        },
      ],
      previousVisualLock: visualLock(ids.lockA, ids.scope, 1, {
        "referenceRoleMap:costume:character-b": HASH_A,
        "referenceRoleMap:character:character-b": HASH_C,
      }),
      nextVisualLock: visualLock(ids.lockB, ids.scope, 2, {
        "referenceRoleMap:costume:character-b": HASH_B,
        "referenceRoleMap:character:character-b": HASH_C,
      }),
      visualConsumers: [
        {
          entityId: ids.costumePrompt,
          dependencies: ["referenceRoleMap:costume:character-b"],
        },
        {
          entityId: ids.characterPrompt,
          dependencies: ["referenceRoleMap:character:character-b"],
        },
      ],
      dialogueContinuity: {
        enabled: true,
        visualChecks: [
          {
            dimension: "axis",
            subjectId: "axis-main",
            expectedValue: "left",
            actualValue: "left",
          },
          {
            dimension: "eyeline",
            subjectId: "character-b",
            expectedValue: "character-a",
            actualValue: "character-a",
          },
          {
            dimension: "blocking",
            subjectId: "character-b",
            expectedValue: "seat-right",
            actualValue: "seat-right",
          },
        ],
        audioLead: {
          dimension: "audio_lead",
          cueId: "cue-b-03",
          speakerId: "character-b",
          leadMilliseconds: 600,
        },
        jCutException: {
          kind: "j_cut_audio_lead",
          cueId: "cue-b-03",
          speakerId: "character-b",
          fromShot: {
            filmEntityId: ids.fromShot,
            expectedVersion: 1,
            expectedContentHash: HASH_A,
          },
          toShot: {
            filmEntityId: ids.toShot,
            expectedVersion: 1,
            expectedContentHash: HASH_B,
          },
          leadMilliseconds: 600,
          actorKind: "human",
          approvedBy: "director-golden-b",
          approvedAt: "2026-08-28T10:00:00Z",
          rationale: "声音先入，不改变画面连续性。",
        },
      },
    };
    const result = spawnSync("bun", ["tests/film-golden/golden_b_local.ts"], {
      cwd: ROOT,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.formalApply).toBe(false);
    expect(receipt.externalProviderCalls).toBe(0);
    expect(receipt.dialogue.changedCueIds).toEqual(["cue-b-03"]);
    expect(receipt.scriptImpact.staleTargetIds).toEqual([ids.promptCue]);
    expect(receipt.scriptImpact.automaticWrites).toBe(false);
    expect(receipt.visualImpact.changedDependencies).toEqual([
      "referenceRoleMap:costume:character-b",
    ]);
    expect(receipt.visualImpact.staleEntityIds).toEqual([ids.costumePrompt]);
    expect(receipt.continuity.state).toBe("ready");
    expect(receipt.continuity.jCutApplied).toBe(true);
  });
});

function script(
  id: string,
  scriptId: string,
  version: number,
  contentHash: string,
  parentVersionId?: string,
) {
  return {
    id,
    scriptId,
    hostProjectId: "host-project-golden-b",
    hostUnitId: "host-unit-golden-b",
    ...(parentVersionId ? { parentVersionId } : {}),
    version,
    title: "Golden B",
    scriptText: "多人长对白 fixture",
    contentHash,
    sourceKind: "manual",
    reviewState: "approved",
    lockState: "locked",
    createdAt: "2026-08-28T10:00:00Z",
    createdBy: "golden-b",
  };
}

function cues(changedText: string) {
  return [
    { cueId: "cue-a-01", speaker: "A", text: "你早就知道。" },
    { cueId: "cue-b-01", speaker: "B", text: "我只知道一部分。" },
    { cueId: "cue-c-01", speaker: "C", text: "那就从头说。" },
    { cueId: "cue-a-02", speaker: "A", text: "从雨夜开始。" },
    { cueId: "cue-b-03", speaker: "B", text: changedText },
    { cueId: "cue-c-02", speaker: "C", text: "门外有人。" },
  ];
}

function visualLock(
  id: string,
  scopeId: string,
  version: number,
  dependencyHashes: Record<string, string>,
) {
  return {
    schemaVersion: 1,
    id,
    scopeId,
    version,
    createdAt: "2026-08-28T10:00:00Z",
    components: {},
    componentHashes: {},
    dependencyHashes,
    visualLockHash: version === 1 ? HASH_C : HASH_D,
  };
}

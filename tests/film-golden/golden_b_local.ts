import {
  analyzeScriptImpact,
  compareScriptVersions,
  type DialogueCue,
  type ScriptDependency,
  type ScriptVersion,
} from "../../web/src/film/story";
import {
  diffVisualLockSets,
  type VisualLockConsumer,
  type VisualLockSet,
} from "../../web/src/film/assets/asset-layer";
import {
  evaluateDialogueContinuity,
  type DialogueContinuityInput,
} from "../../web/src/film/director/j-cut-gate";

type GoldenBLocalInput = {
  sourceScript: ScriptVersion;
  targetScript: ScriptVersion;
  sourceCues: DialogueCue[];
  targetCues: DialogueCue[];
  changedSectionIds: string[];
  scriptDependencies: ScriptDependency[];
  previousVisualLock: VisualLockSet;
  nextVisualLock: VisualLockSet;
  visualConsumers: VisualLockConsumer[];
  dialogueContinuity: DialogueContinuityInput;
};

const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as GoldenBLocalInput;
const scriptDiff = compareScriptVersions(
  input.sourceScript,
  input.targetScript,
  {
    source: input.sourceCues,
    target: input.targetCues,
    changedSectionIds: input.changedSectionIds,
  },
);
const scriptImpact = analyzeScriptImpact(scriptDiff, input.scriptDependencies);
const visualImpact = diffVisualLockSets(
  input.previousVisualLock,
  input.nextVisualLock,
  input.visualConsumers,
);
const continuity = await evaluateDialogueContinuity(input.dialogueContinuity);

process.stdout.write(
  JSON.stringify({
    goldenId: "GOLDEN-B-LOCAL",
    formalApply: false,
    externalProviderCalls: 0,
    dialogue: {
      sourceCueCount: scriptDiff.dialogue.sourceCueCount,
      targetCueCount: scriptDiff.dialogue.targetCueCount,
      changedCueIds: scriptDiff.dialogue.changedCueIds,
      faithful: scriptDiff.dialogue.faithful,
    },
    scriptImpact: {
      staleTargetIds: scriptImpact.impacts.map((item) => item.targetId),
      unresolvedTargetIds: scriptImpact.unresolvedTargetIds,
      automaticWrites: scriptImpact.automaticWrites,
    },
    visualImpact,
    continuity,
  }),
);

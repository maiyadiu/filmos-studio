import type { DialogueChange, DialogueCue, DialogueFidelityReport, ScriptVersion, ScriptVersionDiff } from "./types";

export function compareDialogueFidelity(source: readonly DialogueCue[], target: readonly DialogueCue[]): DialogueFidelityReport {
    assertDialogueCues(source, "source");
    assertDialogueCues(target, "target");
    const sourceById = new Map(source.map((cue, index) => [cue.cueId, { cue, index }]));
    const targetById = new Map(target.map((cue, index) => [cue.cueId, { cue, index }]));
    const commonSourceOrder = source.filter((cue) => targetById.has(cue.cueId)).map((cue) => cue.cueId);
    const commonTargetOrder = target.filter((cue) => sourceById.has(cue.cueId)).map((cue) => cue.cueId);
    const stableOrderIds = new Set(longestCommonSubsequence(commonSourceOrder, commonTargetOrder));
    const changes: DialogueChange[] = [];

    for (const [cueId, entry] of sourceById) {
        const next = targetById.get(cueId);
        if (!next) {
            changes.push({ kind: "removed", cueId, sourceIndex: entry.index, sourceSpeaker: entry.cue.speaker, sourceText: entry.cue.text });
            continue;
        }
        if (entry.cue.speaker !== next.cue.speaker) {
            changes.push({ kind: "speaker_changed", cueId, sourceIndex: entry.index, targetIndex: next.index, sourceSpeaker: entry.cue.speaker, targetSpeaker: next.cue.speaker });
        }
        if (entry.cue.text !== next.cue.text) {
            changes.push({ kind: "text_changed", cueId, sourceIndex: entry.index, targetIndex: next.index, sourceText: entry.cue.text, targetText: next.cue.text });
        }
        if (!stableOrderIds.has(cueId)) {
            changes.push({ kind: "moved", cueId, sourceIndex: entry.index, targetIndex: next.index });
        }
    }
    for (const [cueId, entry] of targetById) {
        if (!sourceById.has(cueId)) changes.push({ kind: "added", cueId, targetIndex: entry.index, targetSpeaker: entry.cue.speaker, targetText: entry.cue.text });
    }

    const changedCueIds = Array.from(new Set(changes.map((change) => change.cueId)));
    const unchangedCueCount = commonSourceOrder.filter((cueId) => {
        const before = sourceById.get(cueId)?.cue;
        const after = targetById.get(cueId)?.cue;
        return stableOrderIds.has(cueId) && before?.speaker === after?.speaker && before?.text === after?.text;
    }).length;
    const sourceCharacterCount = source.reduce((total, cue) => total + Array.from(cue.text).length, 0);
    const targetCharacterCount = target.reduce((total, cue) => total + Array.from(cue.text).length, 0);
    return Object.freeze({
        faithful: changes.length === 0,
        sourceCueCount: source.length,
        targetCueCount: target.length,
        unchangedCueCount,
        sourceCharacterCount,
        targetCharacterCount,
        characterDelta: targetCharacterCount - sourceCharacterCount,
        changedCueIds: Object.freeze(changedCueIds),
        changes: Object.freeze(changes),
    });
}

export function compareScriptVersions(
    source: Pick<ScriptVersion, "id" | "contentHash">,
    target: Pick<ScriptVersion, "id" | "contentHash">,
    dialogue: Readonly<{ source: readonly DialogueCue[]; target: readonly DialogueCue[]; changedSectionIds?: readonly string[] }>,
): ScriptVersionDiff {
    const changedSectionIds = uniqueNonEmpty(dialogue.changedSectionIds || []);
    const dialogueReport = compareDialogueFidelity(dialogue.source, dialogue.target);
    const contentChanged = source.contentHash !== target.contentHash;
    return Object.freeze({
        fromVersionId: source.id,
        toVersionId: target.id,
        fromContentHash: source.contentHash,
        toContentHash: target.contentHash,
        contentChanged,
        changedSectionIds: Object.freeze(changedSectionIds),
        dialogue: dialogueReport,
        // Raw rich text cannot prove that all non-dialogue changes were mapped. Callers must provide section ids.
        hasUnmappedContentChange: contentChanged && changedSectionIds.length === 0,
    });
}

function assertDialogueCues(cues: readonly DialogueCue[], label: string) {
    const ids = new Set<string>();
    for (const cue of cues) {
        if (!cue.cueId.trim()) throw new Error(`${label} dialogue cue id is required`);
        if (ids.has(cue.cueId)) throw new Error(`${label} dialogue cue ids must be unique`);
        ids.add(cue.cueId);
    }
}

function uniqueNonEmpty(values: readonly string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): string[] {
    const lengths = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            lengths[leftIndex][rightIndex] = left[leftIndex - 1] === right[rightIndex - 1] ? lengths[leftIndex - 1][rightIndex - 1] + 1 : Math.max(lengths[leftIndex - 1][rightIndex], lengths[leftIndex][rightIndex - 1]);
        }
    }
    const result: string[] = [];
    let leftIndex = left.length;
    let rightIndex = right.length;
    while (leftIndex > 0 && rightIndex > 0) {
        if (left[leftIndex - 1] === right[rightIndex - 1]) {
            result.unshift(left[leftIndex - 1]);
            leftIndex -= 1;
            rightIndex -= 1;
        } else if (lengths[leftIndex - 1][rightIndex] >= lengths[leftIndex][rightIndex - 1]) {
            leftIndex -= 1;
        } else {
            rightIndex -= 1;
        }
    }
    return result;
}

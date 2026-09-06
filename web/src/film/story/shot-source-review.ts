import { compareDialogueFidelity } from "./dialogue-fidelity";
import type { DialogueCue } from "./types";
import type { ProjectShotContext } from "@/services/api/projects";

export function buildShotDialogueReview(context: ProjectShotContext) {
    const source: DialogueCue[] = context.paragraphs.flatMap(p => p.dialogue ? [{ cueId: p.id, speaker: p.dialogue.speaker, text: p.dialogue.text }] : []);
    const target: DialogueCue[] = [];
    const occurrences = new Map<string, number>();
    for (const shot of [...context.shots].sort((a, b) => a.position - b.position)) {
        if (shot.sourceRevision !== context.unit.revision || shot.sourceHash !== context.sourceHash) continue;
        for (const line of shot.content.dialogue || []) {
            const last = target.at(-1);
            if (last?.cueId === line.paragraphId && last.speaker === line.speaker) {
                target[target.length - 1] = { ...last, text: last.text + line.text };
            } else {
                const occurrence = (occurrences.get(line.paragraphId) || 0) + 1;
                occurrences.set(line.paragraphId, occurrence);
                target.push({ cueId: occurrence === 1 ? line.paragraphId : `${line.paragraphId}:repeat:${occurrence}`, speaker: line.speaker, text: line.text });
            }
        }
    }
    // The shared LCS diff is quadratic. Large documents keep full source and
    // server's linear fidelity check; only the optional detailed diff is skipped.
    if (source.length * target.length > 1_000_000) return { faithful: context.coverage.dialogueMatches, sourceCueCount: source.length, targetCueCount: target.length, detailedDiff: "NOT_COMPUTED_SIZE_LIMIT" as const };
    return compareDialogueFidelity(source, target);
}

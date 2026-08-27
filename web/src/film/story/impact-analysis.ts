import type { ScriptDependency, ScriptImpact, ScriptImpactAnalysis, ScriptVersionDiff } from "./types";

export function analyzeScriptImpact(diff: ScriptVersionDiff, dependencies: readonly ScriptDependency[]): ScriptImpactAnalysis {
    if (!diff.contentChanged) return Object.freeze({ impacts: Object.freeze([]), unresolvedTargetIds: Object.freeze([]), automaticWrites: false });
    const changedCueIds = new Set(diff.dialogue.changedCueIds);
    const changedSectionIds = new Set(diff.changedSectionIds);
    const impacts: ScriptImpact[] = [];
    const unresolvedTargetIds: string[] = [];

    for (const dependency of dependencies) {
        // A dependency based on another source hash cannot be safely classified by this diff.
        if (dependency.sourceContentHash !== diff.fromContentHash) continue;
        const affectedDialogueCueIds = uniqueIntersection(dependency.dialogueCueIds || [], changedCueIds);
        const affectedSectionIds = uniqueIntersection(dependency.sectionIds || [], changedSectionIds);
        if (affectedDialogueCueIds.length || affectedSectionIds.length) {
            impacts.push(
                Object.freeze({
                    targetId: dependency.targetId,
                    targetType: dependency.targetType,
                    affectedDialogueCueIds: Object.freeze(affectedDialogueCueIds),
                    affectedSectionIds: Object.freeze(affectedSectionIds),
                    recommendation: "mark_stale",
                }),
            );
        } else if (diff.hasUnmappedContentChange) {
            unresolvedTargetIds.push(dependency.targetId);
        }
    }

    return Object.freeze({
        impacts: Object.freeze(impacts),
        unresolvedTargetIds: Object.freeze(Array.from(new Set(unresolvedTargetIds))),
        // The analyzer only returns recommendations; Film Core remains responsible for formal STALE writes.
        automaticWrites: false,
    });
}

function uniqueIntersection(values: readonly string[], changed: ReadonlySet<string>) {
    return Array.from(new Set(values.filter((value) => changed.has(value))));
}

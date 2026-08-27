export const STORY_STUDIO_FEATURE_FLAG = "film.story_studio" as const;

export type StoryStudioPolicy = Readonly<{
    enabled: boolean;
}>;

export const STORY_STUDIO_DISABLED: StoryStudioPolicy = Object.freeze({ enabled: false });

export type ScriptSourceKind = "manual" | "import" | "ai_proposal";
export type ScriptReviewState = "not_reviewed" | "changes_requested" | "rejected" | "approved";
export type ScriptLockState = "unlocked" | "locked";
export type ScriptDecisionOutcome = "request_changes" | "reject" | "approve_for_lock";
export type ScriptDecisionActorKind = "human" | "agent";

export type ScriptVersion = Readonly<{
    id: string;
    scriptId: string;
    hostProjectId: string;
    hostUnitId: string;
    parentVersionId?: string;
    version: number;
    title: string;
    scriptText: string;
    contentHash: string;
    sourceKind: ScriptSourceKind;
    reviewState: ScriptReviewState;
    lockState: ScriptLockState;
    createdAt: string;
    createdBy: string;
    reviewedAt?: string;
    reviewedBy?: string;
    lockedAt?: string;
    lockedBy?: string;
    approvalDecisionId?: string;
}>;

export type ScriptDecision = Readonly<{
    id: string;
    scriptVersionId: string;
    scriptContentHash: string;
    outcome: ScriptDecisionOutcome;
    rationale: string;
    decidedAt: string;
    decidedBy: string;
    actorKind: ScriptDecisionActorKind;
}>;

export type DialogueCue = Readonly<{
    cueId: string;
    speaker: string;
    text: string;
}>;

export type DialogueChangeKind = "added" | "removed" | "speaker_changed" | "text_changed" | "moved";

export type DialogueChange = Readonly<{
    kind: DialogueChangeKind;
    cueId: string;
    sourceIndex?: number;
    targetIndex?: number;
    sourceSpeaker?: string;
    targetSpeaker?: string;
    sourceText?: string;
    targetText?: string;
}>;

export type DialogueFidelityReport = Readonly<{
    faithful: boolean;
    sourceCueCount: number;
    targetCueCount: number;
    unchangedCueCount: number;
    sourceCharacterCount: number;
    targetCharacterCount: number;
    characterDelta: number;
    changedCueIds: readonly string[];
    changes: readonly DialogueChange[];
}>;

export type ScriptVersionDiff = Readonly<{
    fromVersionId: string;
    toVersionId: string;
    fromContentHash: string;
    toContentHash: string;
    contentChanged: boolean;
    changedSectionIds: readonly string[];
    dialogue: DialogueFidelityReport;
    hasUnmappedContentChange: boolean;
}>;

export type ScriptDependencyTargetType = "scene" | "director_unit" | "shot" | "prompt_draft" | "generation_package" | "other";

export type ScriptDependency = Readonly<{
    targetId: string;
    targetType: ScriptDependencyTargetType;
    sourceContentHash: string;
    dialogueCueIds?: readonly string[];
    sectionIds?: readonly string[];
}>;

export type ScriptImpact = Readonly<{
    targetId: string;
    targetType: ScriptDependencyTargetType;
    affectedDialogueCueIds: readonly string[];
    affectedSectionIds: readonly string[];
    recommendation: "mark_stale";
}>;

export type ScriptImpactAnalysis = Readonly<{
    impacts: readonly ScriptImpact[];
    unresolvedTargetIds: readonly string[];
    automaticWrites: false;
}>;

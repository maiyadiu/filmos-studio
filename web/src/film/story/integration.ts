import type { ScriptDecision, ScriptDependency, ScriptImpactAnalysis, ScriptVersion, ScriptVersionDiff } from "./types";
import type { CreateScriptVersionInput, LockScriptVersionInput, RecordScriptDecisionInput } from "./script-version";

export type StoryStudioScope = Readonly<{
    hostProjectId: string;
    hostUnitId: string;
}>;

export type StoryStudioSnapshot = Readonly<{
    enabled: boolean;
    versions: readonly ScriptVersion[];
    decisions: readonly ScriptDecision[];
}>;

// UI and persistence adapters can implement this port without importing an unfinished Film Core runtime.
export interface StoryStudioPort {
    load(scope: StoryStudioScope, signal?: AbortSignal): Promise<StoryStudioSnapshot>;
    createVersion(input: CreateScriptVersionInput, signal?: AbortSignal): Promise<ScriptVersion>;
    recordDecision(versionId: string, input: RecordScriptDecisionInput, signal?: AbortSignal): Promise<Readonly<{ version: ScriptVersion; decision: ScriptDecision }>>;
    lockVersion(versionId: string, input: LockScriptVersionInput, signal?: AbortSignal): Promise<ScriptVersion>;
    analyzeImpact(diff: ScriptVersionDiff, dependencies: readonly ScriptDependency[], signal?: AbortSignal): Promise<ScriptImpactAnalysis>;
}

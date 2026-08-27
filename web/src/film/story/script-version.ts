import { STORY_STUDIO_FEATURE_FLAG, type ScriptDecision, type ScriptDecisionActorKind, type ScriptDecisionOutcome, type ScriptSourceKind, type ScriptVersion, type StoryStudioPolicy } from "./types";

const contentHashPattern = /^[0-9a-f]{64}$/;
const filmEntityIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class StoryStudioDisabledError extends Error {
    readonly code = "STORY_STUDIO_DISABLED";

    constructor() {
        super(`${STORY_STUDIO_FEATURE_FLAG} is disabled`);
        this.name = "StoryStudioDisabledError";
    }
}

export type CreateScriptVersionInput = Readonly<{
    id: string;
    scriptId: string;
    hostProjectId: string;
    hostUnitId: string;
    parentVersionId?: string;
    version: number;
    title: string;
    scriptText: string;
    sourceKind: ScriptSourceKind;
    createdAt: string;
    createdBy: string;
}>;

export type RecordScriptDecisionInput = Readonly<{
    id: string;
    expectedVersion: number;
    expectedContentHash: string;
    outcome: ScriptDecisionOutcome;
    rationale: string;
    decidedAt: string;
    decidedBy: string;
    actorKind: ScriptDecisionActorKind;
}>;

export type LockScriptVersionInput = Readonly<{
    expectedVersion: number;
    expectedContentHash: string;
    approvalDecision: ScriptDecision;
    lockedAt: string;
    lockedBy: string;
}>;

export type DownstreamEligibility = Readonly<{
    eligible: boolean;
    reasons: readonly ("feature_disabled" | "review_not_approved" | "script_not_locked" | "content_hash_mismatch")[];
}>;

export async function hashScriptContent(scriptText: string): Promise<string> {
    const bytes = new TextEncoder().encode(scriptText);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createScriptVersion(policy: StoryStudioPolicy, input: CreateScriptVersionInput): Promise<ScriptVersion> {
    assertStoryStudioEnabled(policy);
    // IDs are issued by Film Core; this isolated Web domain only validates them.
    assertFilmEntityId("id", input.id);
    assertFilmEntityId("scriptId", input.scriptId);
    if (input.parentVersionId) assertFilmEntityId("parentVersionId", input.parentVersionId);
    assertNonEmpty("hostProjectId", input.hostProjectId);
    assertNonEmpty("hostUnitId", input.hostUnitId);
    assertNonEmpty("title", input.title);
    assertNonEmpty("createdAt", input.createdAt);
    assertNonEmpty("createdBy", input.createdBy);
    if (!Number.isInteger(input.version) || input.version < 1) throw new Error("version must be a positive integer");

    return freezeScriptVersion({
        ...input,
        contentHash: await hashScriptContent(input.scriptText),
        reviewState: "not_reviewed",
        lockState: "unlocked",
    });
}

export async function recordScriptDecision(policy: StoryStudioPolicy, version: ScriptVersion, input: RecordScriptDecisionInput): Promise<Readonly<{ version: ScriptVersion; decision: ScriptDecision }>> {
    assertStoryStudioEnabled(policy);
    assertVersionIntegrityMetadata(version, input.expectedVersion, input.expectedContentHash);
    if ((await hashScriptContent(version.scriptText)) !== version.contentHash) throw new Error("script text no longer matches its content hash");
    assertFilmEntityId("decision id", input.id);
    assertNonEmpty("decision rationale", input.rationale);
    assertNonEmpty("decidedAt", input.decidedAt);
    assertNonEmpty("decidedBy", input.decidedBy);
    if (version.lockState === "locked") throw new Error("locked script versions cannot receive a new formal decision");
    if (input.outcome === "approve_for_lock" && input.actorKind !== "human") {
        throw new Error("only a human decision can approve a script version for lock");
    }

    const decision = Object.freeze({
        id: input.id,
        scriptVersionId: version.id,
        scriptVersion: version.version,
        scriptContentHash: version.contentHash,
        outcome: input.outcome,
        rationale: input.rationale,
        decidedAt: input.decidedAt,
        decidedBy: input.decidedBy,
        actorKind: input.actorKind,
    } satisfies ScriptDecision);
    const reviewState = input.outcome === "approve_for_lock" ? "approved" : input.outcome === "reject" ? "rejected" : "changes_requested";
    const reviewed = freezeScriptVersion({
        ...version,
        reviewState,
        reviewedAt: input.decidedAt,
        reviewedBy: input.decidedBy,
        approvalDecisionId: input.outcome === "approve_for_lock" ? decision.id : undefined,
    });
    return Object.freeze({ version: reviewed, decision });
}

export async function lockScriptVersion(policy: StoryStudioPolicy, version: ScriptVersion, input: LockScriptVersionInput): Promise<ScriptVersion> {
    assertStoryStudioEnabled(policy);
    assertVersionIntegrityMetadata(version, input.expectedVersion, input.expectedContentHash);
    if ((await hashScriptContent(version.scriptText)) !== version.contentHash) throw new Error("script text no longer matches its content hash");
    if (version.lockState === "locked") throw new Error("script version is already locked");
    if (version.reviewState !== "approved") throw new Error("script version must be approved before lock");
    const decision = input.approvalDecision;
    if (decision.outcome !== "approve_for_lock" || decision.actorKind !== "human") throw new Error("a human approval decision is required for lock");
    if (decision.scriptVersionId !== version.id || decision.scriptVersion !== version.version || decision.scriptContentHash !== version.contentHash || decision.id !== version.approvalDecisionId) {
        throw new Error("approval decision does not match this script version and content hash");
    }
    assertNonEmpty("lockedAt", input.lockedAt);
    assertNonEmpty("lockedBy", input.lockedBy);
    return freezeScriptVersion({ ...version, lockState: "locked", lockedAt: input.lockedAt, lockedBy: input.lockedBy });
}

export async function assessDownstreamEligibility(policy: StoryStudioPolicy, version: ScriptVersion): Promise<DownstreamEligibility> {
    const reasons: DownstreamEligibility["reasons"][number][] = [];
    if (!policy.enabled) reasons.push("feature_disabled");
    if (version.reviewState !== "approved") reasons.push("review_not_approved");
    if (version.lockState !== "locked") reasons.push("script_not_locked");
    if (!contentHashPattern.test(version.contentHash) || (await hashScriptContent(version.scriptText)) !== version.contentHash) reasons.push("content_hash_mismatch");
    return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function assertStoryStudioEnabled(policy: StoryStudioPolicy): void {
    if (!policy.enabled) throw new StoryStudioDisabledError();
}

function assertVersionIntegrityMetadata(version: ScriptVersion, expectedVersion: number, expectedContentHash: string) {
    assertFilmEntityId("script version id", version.id);
    assertFilmEntityId("script id", version.scriptId);
    if (version.parentVersionId) assertFilmEntityId("parent version id", version.parentVersionId);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== version.version) throw new Error("script version optimistic concurrency conflict");
    if (!contentHashPattern.test(version.contentHash)) throw new Error("script version has an invalid content hash");
    if (expectedContentHash !== version.contentHash) throw new Error("script version content hash conflict");
}

function assertFilmEntityId(label: string, value: string) {
    if (!filmEntityIdPattern.test(value)) throw new Error(`${label} must be a Film Core UUIDv4`);
}

function assertNonEmpty(label: string, value: string) {
    if (!value.trim()) throw new Error(`${label} is required`);
}

function freezeScriptVersion(version: ScriptVersion): ScriptVersion {
    return Object.freeze(version);
}

import { canonicalize } from "json-canonicalize";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type VisualContinuityDimension = "axis" | "eyeline" | "blocking" | "action" | "prop_contact";

export type VisualContinuityObservation = {
    dimension: VisualContinuityDimension;
    subjectId: string;
    expectedValue: string;
    actualValue: string;
};

export type AudioLeadObservation = {
    dimension: "audio_lead";
    cueId: string;
    speakerId: string;
    leadMilliseconds: number;
};

export type JCutHumanException = {
    kind: "j_cut_audio_lead";
    cueId: string;
    speakerId: string;
    fromShot: EntityGuard;
    toShot: EntityGuard;
    leadMilliseconds: number;
    actorKind: "human" | "agent";
    approvedBy: string;
    approvedAt: string;
    rationale: string;
};

export type EntityGuard = {
    filmEntityId: string;
    expectedVersion: number;
    expectedContentHash: string;
};

export type DialogueContinuityInput = {
    enabled?: boolean;
    visualChecks: readonly VisualContinuityObservation[];
    audioLead: AudioLeadObservation;
    jCutException?: JCutHumanException;
};

export type DialogueContinuityBlocker = {
    code: string;
    dimension: VisualContinuityDimension | "audio_lead";
    subjectId: string;
    expectedValue: string;
    actualValue: string;
};

export type DialogueContinuityResult = {
    state: "disabled" | "blocked" | "ready";
    authority: "projection_only";
    formalMutationAllowed: false;
    blockers: DialogueContinuityBlocker[];
    jCutApplied: boolean;
    receiptHash?: string;
};

export async function evaluateDialogueContinuity(input: DialogueContinuityInput): Promise<DialogueContinuityResult> {
    if (input.enabled !== true) return disabledResult();
    const blockers: DialogueContinuityBlocker[] = [];
    for (const check of input.visualChecks) {
        requireOpaqueId(check.subjectId, "visualChecks.subjectId");
        requireText(check.expectedValue, "visualChecks.expectedValue");
        requireText(check.actualValue, "visualChecks.actualValue");
        if (check.expectedValue !== check.actualValue) {
            blockers.push({
                code: `${check.dimension.toUpperCase()}_CONTINUITY_BROKEN`,
                dimension: check.dimension,
                subjectId: check.subjectId,
                expectedValue: check.expectedValue,
                actualValue: check.actualValue,
            });
        }
    }

    const audio = input.audioLead;
    requireOpaqueId(audio.cueId, "audioLead.cueId");
    requireOpaqueId(audio.speakerId, "audioLead.speakerId");
    requireLead(audio.leadMilliseconds, "audioLead.leadMilliseconds", true);
    let jCutApplied = false;
    if (audio.leadMilliseconds > 0) {
        if (input.jCutException && exceptionMatches(input.jCutException, audio)) {
            validateHumanException(input.jCutException);
            jCutApplied = true;
        } else {
            blockers.push({
                code: "AUDIO_LEAD_EXCEPTION_REQUIRED",
                dimension: "audio_lead",
                subjectId: `${audio.speakerId}:${audio.cueId}`,
                expectedValue: "0",
                actualValue: String(audio.leadMilliseconds),
            });
        }
    }

    const receiptHash = await sha256(
        canonicalize({
            visualChecks: input.visualChecks,
            audioLead: input.audioLead,
            jCutException: jCutApplied ? input.jCutException : null,
            blockers,
        }),
    );
    return {
        state: blockers.length ? "blocked" : "ready",
        authority: "projection_only",
        formalMutationAllowed: false,
        blockers,
        jCutApplied,
        receiptHash,
    };
}

function exceptionMatches(exception: JCutHumanException, audio: AudioLeadObservation) {
    return exception.kind === "j_cut_audio_lead" && exception.cueId === audio.cueId && exception.speakerId === audio.speakerId && exception.leadMilliseconds === audio.leadMilliseconds;
}

function validateHumanException(exception: JCutHumanException) {
    if (exception.actorKind !== "human") throw new Error("J-cut exception requires an explicit human actor");
    requireOpaqueId(exception.cueId, "jCutException.cueId");
    requireOpaqueId(exception.speakerId, "jCutException.speakerId");
    requireGuard(exception.fromShot, "jCutException.fromShot");
    requireGuard(exception.toShot, "jCutException.toShot");
    if (exception.fromShot.filmEntityId === exception.toShot.filmEntityId) throw new Error("J-cut exception must cross two distinct Shots");
    requireLead(exception.leadMilliseconds, "jCutException.leadMilliseconds", false);
    requireText(exception.approvedBy, "jCutException.approvedBy");
    requireText(exception.rationale, "jCutException.rationale");
    if (!Number.isFinite(Date.parse(exception.approvedAt))) throw new Error("jCutException.approvedAt must be an ISO timestamp");
}

function requireGuard(guard: EntityGuard, field: string) {
    if (!UUID_V4.test(guard.filmEntityId)) throw new Error(`${field}.filmEntityId must be a Film Core UUIDv4`);
    if (!Number.isSafeInteger(guard.expectedVersion) || guard.expectedVersion < 1) throw new Error(`${field}.expectedVersion must be positive`);
    if (!SHA_256.test(guard.expectedContentHash)) throw new Error(`${field}.expectedContentHash must be a SHA-256`);
}

function requireLead(value: number, field: string, allowZero: boolean) {
    const minimum = allowZero ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > 3000) throw new Error(`${field} must be between ${minimum} and 3000`);
}

function requireOpaqueId(value: string, field: string) {
    if (!OPAQUE_ID.test(value)) throw new Error(`${field} must be an opaque ID, not a path or URL`);
}

function requireText(value: string, field: string) {
    if (!value.trim()) throw new Error(`${field} is required`);
}

async function sha256(value: string) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function disabledResult(): DialogueContinuityResult {
    return {
        state: "disabled",
        authority: "projection_only",
        formalMutationAllowed: false,
        blockers: [],
        jCutApplied: false,
    };
}

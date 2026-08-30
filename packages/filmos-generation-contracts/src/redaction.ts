import { hashEnvelope, hashProjection, hashRedactedProjection } from "./canonical.js";
import type { RedactionReceipt } from "./types.js";

export async function createRedactionReceipt(input: {
    redactionReceiptId: string;
    sourceObjectType: string;
    sourceContentHash: string;
    redactedObjectType: string;
    redactedProjection: Record<string, unknown>;
    aliasScopeId: string;
    redactionPolicyVersion: string;
    redactedFieldPaths: string[];
    sourceCommit: string;
    sourceRunId: string;
    sourceArtifactId: string;
    createdAt: string;
}): Promise<{ redactedProjection: Record<string, unknown> & { redactedContentHash: string }; receipt: RedactionReceipt }> {
    if ("aliasMapping" in input.redactedProjection) throw new Error("REDACTION_ALIAS_MAPPING_FORBIDDEN");
    const redactedContentHash = await hashRedactedProjection(input.redactedProjection);
    const redactionSemanticHash = await hashProjection("redaction-receipt", "semantic", {
        sourceObjectType: input.sourceObjectType, sourceContentHash: input.sourceContentHash,
        redactedObjectType: input.redactedObjectType, redactedContentHash, aliasScopeId: input.aliasScopeId,
        redactionPolicyVersion: input.redactionPolicyVersion, redactedFieldPaths: [...input.redactedFieldPaths].sort(),
    });
    const envelope: Omit<RedactionReceipt, "contentHash"> = {
        schemaVersion: 1, redactionReceiptId: input.redactionReceiptId,
        sourceObjectType: input.sourceObjectType, sourceContentHash: input.sourceContentHash,
        redactedObjectType: input.redactedObjectType, redactedContentHash,
        aliasScopeId: input.aliasScopeId, redactionPolicyVersion: input.redactionPolicyVersion,
        redactedFieldPaths: [...input.redactedFieldPaths].sort(), sourceCommit: input.sourceCommit,
        sourceRunId: input.sourceRunId, sourceArtifactId: input.sourceArtifactId,
        redactionSemanticHash, createdAt: input.createdAt,
    };
    const receipt = { ...envelope, contentHash: await hashEnvelope("redaction-receipt", envelope as unknown as Record<string, unknown>) };
    return { redactedProjection: { ...input.redactedProjection, redactedContentHash }, receipt };
}

export async function verifyRedactedProjection(projection: Record<string, unknown>): Promise<void> {
    const expected = projection.redactedContentHash;
    if (typeof expected !== "string" || expected !== await hashRedactedProjection(projection)) throw new Error("REDACTED_PROJECTION_TAMPERED");
}

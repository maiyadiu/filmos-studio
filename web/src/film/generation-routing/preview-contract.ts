import { hashProjection } from "@filmos/generation-contracts";

export type GenerationRoutePreviewInput = {
    engineId: string;
    connectionId: string;
    mode: string;
    modelId?: string;
    workflowId?: string;
    skillId?: string;
    prompt: string;
    nativeSize: string;
    deliveryResolution: string;
    draftVersion: number;
};

export function buildGenerationRoutePreviewProjection(input: GenerationRoutePreviewInput): Record<string, string | number> {
    return {
        engineId: input.engineId,
        connectionId: input.connectionId,
        mode: input.mode,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.skillId ? { skillId: input.skillId } : {}),
        prompt: input.prompt,
        nativeSize: input.nativeSize,
        deliveryResolution: input.deliveryResolution,
        draftVersion: input.draftVersion,
    };
}

export function createGenerationRoutePreviewHash(input: GenerationRoutePreviewInput): Promise<string> {
    return hashProjection("generation-route-draft", "semantic", buildGenerationRoutePreviewProjection(input));
}

export async function createGenerationRoutePreviewReceipt(input: GenerationRoutePreviewInput & { projectId: string; nodeId: string; descriptorKind: "model" | "workflow" | "skill"; descriptorId: string }) {
    const draftHash = await createGenerationRoutePreviewHash(input);
    const generationAttemptId = `attempt-${draftHash.slice(0, 24)}`;
    const descriptorReceiptHash = await hashProjection("resolved-generation-descriptor", "semantic", { engineId: input.engineId, connectionId: input.connectionId, descriptorKind: input.descriptorKind, descriptorId: input.descriptorId });
    const compiledPromptHash = await hashProjection("compiled-prompt", "semantic", { prompt: input.prompt, engineId: input.engineId, descriptorId: input.descriptorId, compilerVersion: "filmos-v2.4-production" });
    const routeContentHash = await hashProjection("generation-route", "semantic", { ...buildGenerationRoutePreviewProjection(input), descriptorReceiptHash, compiledPromptHash, projectId: input.projectId, nodeId: input.nodeId });
    const routeSnapshotContentHash = await hashProjection("generation-route", "envelope", { routeContentHash, generationAttemptId, createdFromDraftHash: draftHash });
    const proposalHash = await hashProjection("generation-submission-proposal", "semantic", { routeContentHash, projectId: input.projectId, nodeId: input.nodeId });
    return {
        generationAttemptId,
        routeSnapshotId: `route-${routeContentHash.slice(0, 24)}`,
        routeSnapshotContentHash,
        routeContentHash,
        descriptorReceiptId: `descriptor-${descriptorReceiptHash.slice(0, 24)}`,
        compiledPromptReceiptId: `compiled-prompt-${compiledPromptHash.slice(0, 24)}`,
        proposalId: `proposal-${proposalHash.slice(0, 24)}`,
        previewReceiptId: `preview-${draftHash.slice(0, 24)}`,
        previewReceiptHash: draftHash,
        externalCostMicrounits: "0" as const,
        externalWritePerformed: false as const,
    };
}

import { hashProjection } from "@filmos/generation-contracts";

export type GenerationRoutePreviewInput = {
    engineId: string;
    connectionId: string;
    mode: string;
    modelId?: string;
    workflowId?: string;
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
        prompt: input.prompt,
        nativeSize: input.nativeSize,
        deliveryResolution: input.deliveryResolution,
        draftVersion: input.draftVersion,
    };
}

export function createGenerationRoutePreviewHash(input: GenerationRoutePreviewInput): Promise<string> {
    return hashProjection("generation-route-draft", "semantic", buildGenerationRoutePreviewProjection(input));
}

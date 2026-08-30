import { hashEnvelope, hashProjection, sha256Hex } from "./canonical.js";
import type { CompiledPromptReceipt, GenerationReferenceBinding, GenerationTaskKind, PromptIntent } from "./types.js";

const ORDER: Array<keyof PromptIntent> = ["subject", "identityLocks", "action", "environment", "sceneLayout", "camera", "lens", "composition", "lighting", "color", "continuity", "deliveryRequirements"];

export async function compilePrompt(input: { id: string; intent: PromptIntent; engineId: string; modelId?: string; taskKind: GenerationTaskKind; templateVersion: string; compilerVersion: string; parameterSchema: Record<string, unknown>; references?: readonly GenerationReferenceBinding[]; maxLength?: number; supportsNegativePrompt?: boolean; createdAt: string }): Promise<CompiledPromptReceipt> {
    const text = ORDER.flatMap((key) => input.intent[key]).map((item) => item.trim()).filter(Boolean).join("; ");
    if (!text) throw new Error("PROMPT_INTENT_EMPTY");
    if (input.maxLength !== undefined && text.length > input.maxLength) throw new Error("PROMPT_LENGTH_EXCEEDED");
    const negativeText = input.supportsNegativePrompt === false ? undefined : input.intent.negativeConstraints.map((item) => item.trim()).filter(Boolean).join("; ") || undefined;
    const referenceSlots = (input.references ?? []).map((item) => ({ role: item.role, assetVersionId: item.assetVersionId, assetVersionContentHash: item.assetVersionContentHash }));
    const intentHash = await hashProjection("prompt-intent", "semantic", input.intent);
    const compiledTextHash = await sha256Hex(text);
    const negativeTextHash = negativeText ? await sha256Hex(negativeText) : undefined;
    const semantic = { engineId: input.engineId, ...(input.modelId ? { modelId: input.modelId } : {}), taskKind: input.taskKind, compilerVersion: input.compilerVersion, templateVersion: input.templateVersion, parameterSchema: input.parameterSchema, intentHash, compiledTextHash, ...(negativeTextHash ? { negativeTextHash } : {}), referenceSlots };
    const compiledPromptSemanticHash = await hashProjection("compiled-prompt", "semantic", semantic);
    const envelope: Omit<CompiledPromptReceipt, "contentHash"> = { schemaVersion: 1, compiledPromptReceiptId: input.id, text, ...(negativeText ? { negativeText } : {}), referenceSlots, engineId: input.engineId, ...(input.modelId ? { modelId: input.modelId } : {}), compilerVersion: input.compilerVersion, templateVersion: input.templateVersion, intentHash, compiledTextHash, ...(negativeTextHash ? { negativeTextHash } : {}), compiledPromptSemanticHash, createdAt: input.createdAt };
    return { ...envelope, contentHash: await hashEnvelope("compiled-prompt", envelope as unknown as Record<string, unknown>) };
}

export function assertCompiledPromptCurrent(receipt: CompiledPromptReceipt, input: { engineId: string; modelId?: string; intentHash: string }): void {
    if (receipt.engineId !== input.engineId || receipt.modelId !== input.modelId || receipt.intentHash !== input.intentHash) throw new Error("COMPILED_PROMPT_STALE");
}

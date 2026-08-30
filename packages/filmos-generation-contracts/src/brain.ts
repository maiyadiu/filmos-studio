import { hashEnvelope } from "./canonical.js";
import type { AgentProviderKind, BrainProfileBinding, ProjectBrainPolicy, UserSelectableBrainProfileId } from "./types.js";

export const USER_SELECTABLE_BRAIN_PROFILE_IDS = [
    "codex.subscription", "chatgpt.subscription.host", "openai.api",
    "anthropic.api", "deepseek.api", "local.model",
] as const satisfies readonly UserSelectableBrainProfileId[];

export type ExactBrainRuntimeBinding = {
    profileId: UserSelectableBrainProfileId;
    channelId?: string;
    modelId?: string;
    transport: BrainProfileBinding["transport"];
    billingMode: BrainProfileBinding["billingMode"];
};

export function selectEffectiveBrainProfile(input: {
    explicitProfileId?: UserSelectableBrainProfileId;
    projectPolicy?: ProjectBrainPolicy;
    globalDefaultProfileId?: UserSelectableBrainProfileId;
}): { profileId: UserSelectableBrainProfileId; source: "explicit_task" | "project_default" | "global_default" } {
    const selected = input.explicitProfileId
        ? { profileId: input.explicitProfileId, source: "explicit_task" as const }
        : input.projectPolicy?.defaultProfileId
            ? { profileId: input.projectPolicy.defaultProfileId, source: "project_default" as const }
            : input.globalDefaultProfileId
                ? { profileId: input.globalDefaultProfileId, source: "global_default" as const }
                : undefined;
    if (!selected) throw new Error("BRAIN_PROFILE_NEEDS_CONFIGURATION");
    if (input.projectPolicy && !input.projectPolicy.allowedProfileIds.includes(selected.profileId)) throw new Error("BRAIN_PROFILE_NOT_ALLOWED");
    return selected;
}

/** @deprecated Use selectEffectiveBrainProfile; retained only for source compatibility. */
export const selectBrainProfile = selectEffectiveBrainProfile;

const PROFILE_PROVIDER: Partial<Record<UserSelectableBrainProfileId, AgentProviderKind>> = {
    "openai.api": "openai",
    "anthropic.api": "anthropic",
    "deepseek.api": "deepseek",
    "local.model": "local_openai_compatible",
};

export function assertBrainProviderCompatibility(binding: BrainProfileBinding): void {
    const expected = PROFILE_PROVIDER[binding.profileId];
    if (!expected) return;
    if (binding.providerKind !== expected) throw new Error("BRAIN_PROVIDER_KIND_MISMATCH");
    const evidence = binding.modelCapabilityEvidence;
    if (!evidence?.text || !evidence.evidenceSource || !evidence.evidenceRevision) throw new Error("BRAIN_MODEL_CAPABILITY_EVIDENCE_REQUIRED");
    if (binding.requiredCapabilities.includes("tool_calling") && !evidence.toolCalling) throw new Error("BRAIN_MODEL_TOOL_CALLING_UNSUPPORTED");
    if (binding.requiredCapabilities.includes("structured_output") && !evidence.structuredOutput) throw new Error("BRAIN_MODEL_STRUCTURED_OUTPUT_UNSUPPORTED");
    const allowedProtocols: Record<AgentProviderKind, readonly string[]> = {
        openai: ["openai_responses", "openai_chat_completions"],
        anthropic: ["anthropic_messages"],
        deepseek: ["openai_chat_completions"],
        local_openai_compatible: ["local_openai_compatible"],
    };
    if (!binding.protocol || !allowedProtocols[expected].includes(binding.protocol)) throw new Error("BRAIN_PROTOCOL_INCOMPATIBLE");
    if (binding.profileId === "local.model" && binding.channelId === "local:dreamina-cli") throw new Error("LOCAL_LLM_DREAMINA_FORBIDDEN");
}

export function resolveExactBrainBinding(input: {
    profileId: UserSelectableBrainProfileId;
    bindings: readonly BrainProfileBinding[];
    projectPolicy?: ProjectBrainPolicy;
}): ExactBrainRuntimeBinding {
    const matches = input.bindings.filter((binding) => binding.profileId === input.profileId && binding.enabled);
    if (matches.length !== 1) throw new Error(matches.length ? "BRAIN_BINDING_DUPLICATE" : "BRAIN_BINDING_NEEDS_CONFIGURATION");
    const binding = matches[0];
    assertBrainProviderCompatibility(binding);
    const override = input.projectPolicy?.profileOverrides[input.profileId];
    const channelId = override?.channelId ?? binding.channelId;
    const modelId = override?.modelId ?? binding.modelId;
    if (["openai.api", "anthropic.api", "deepseek.api", "local.model"].includes(input.profileId) && (!channelId || !modelId)) {
        throw new Error("BRAIN_BINDING_NEEDS_CONFIGURATION");
    }
    if (binding.allowApiFallback !== false) throw new Error("BRAIN_API_FALLBACK_FORBIDDEN");
    return { profileId: input.profileId, channelId, modelId, transport: binding.transport, billingMode: binding.billingMode };
}

export async function hashBrainBinding(binding: Omit<BrainProfileBinding, "contentHash">): Promise<string> {
    return hashEnvelope("brain-profile-binding", binding as unknown as Record<string, unknown>);
}

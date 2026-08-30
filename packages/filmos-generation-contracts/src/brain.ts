import { hashEnvelope } from "./canonical.js";
import type { BrainProfileBinding, ProjectBrainPolicy, UserSelectableBrainProfileId } from "./types.js";

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

export function selectBrainProfile(input: {
    explicitProfileId?: UserSelectableBrainProfileId;
    projectPolicy?: ProjectBrainPolicy;
    globalDefaultProfileId?: UserSelectableBrainProfileId;
}): { profileId: UserSelectableBrainProfileId; source: "explicit_task" | "project_default" | "global_default" | "builtin_default" } {
    const selected = input.explicitProfileId
        ? { profileId: input.explicitProfileId, source: "explicit_task" as const }
        : input.projectPolicy?.defaultProfileId
            ? { profileId: input.projectPolicy.defaultProfileId, source: "project_default" as const }
            : input.globalDefaultProfileId
                ? { profileId: input.globalDefaultProfileId, source: "global_default" as const }
                : { profileId: "codex.subscription" as const, source: "builtin_default" as const };
    if (input.projectPolicy && !input.projectPolicy.allowedProfileIds.includes(selected.profileId)) throw new Error("BRAIN_PROFILE_NOT_ALLOWED");
    return selected;
}

export function resolveExactBrainBinding(input: {
    profileId: UserSelectableBrainProfileId;
    bindings: readonly BrainProfileBinding[];
    projectPolicy?: ProjectBrainPolicy;
}): ExactBrainRuntimeBinding {
    const matches = input.bindings.filter((binding) => binding.profileId === input.profileId && binding.enabled);
    if (matches.length !== 1) throw new Error(matches.length ? "BRAIN_BINDING_DUPLICATE" : "BRAIN_BINDING_NEEDS_CONFIGURATION");
    const binding = matches[0];
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

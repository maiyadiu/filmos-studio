import type { AgentModelCapabilityEvidence, AgentProviderKind, BrainProfileBinding, UserSelectableBrainProfileId } from "@filmos/generation-contracts";

import type { ModelChannel } from "@/stores/use-config-store";

const EXPECTED_PROVIDER: Partial<Record<UserSelectableBrainProfileId, AgentProviderKind>> = {
    "openai.api": "openai",
    "anthropic.api": "anthropic",
    "deepseek.api": "deepseek",
    "local.model": "local_openai_compatible",
};

const EXPECTED_PROTOCOLS: Record<AgentProviderKind, readonly string[]> = {
    openai: ["openai_responses", "openai_chat_completions"],
    anthropic: ["anthropic_messages"],
    deepseek: ["openai_chat_completions"],
    local_openai_compatible: ["local_openai_compatible"],
};

export function compatibleBrainChannels(profileId: UserSelectableBrainProfileId, channels: readonly ModelChannel[]): ModelChannel[] {
    const providerKind = EXPECTED_PROVIDER[profileId];
    if (!providerKind) return [];
    return channels.filter((channel) => {
        if (channel.enabled === false || channel.providerKind !== providerKind || !channel.agentProtocol || !EXPECTED_PROTOCOLS[providerKind].includes(channel.agentProtocol)) return false;
        if (profileId === "local.model" && channel.transport !== "local-llm-runtime") return false;
        if (profileId !== "local.model" && channel.transport === "local-runtime") return false;
        return channel.models.some((modelId) => modelHasRequiredEvidence(channel.agentModelCapabilities?.[modelId]));
    });
}

export function compatibleBrainModels(channel: ModelChannel | undefined): string[] {
    if (!channel) return [];
    return channel.models.filter((modelId) => modelHasRequiredEvidence(channel.agentModelCapabilities?.[modelId]));
}

export function brainBindingEvidencePatch(channel: ModelChannel, modelId?: string): Pick<BrainProfileBinding, "providerKind" | "protocol"> & Partial<Pick<BrainProfileBinding, "modelCapabilityEvidence">> {
    if (!channel.providerKind || !channel.agentProtocol) throw new Error("BRAIN_CHANNEL_PROVIDER_EVIDENCE_REQUIRED");
    const evidence = modelId ? channel.agentModelCapabilities?.[modelId] : undefined;
    if (modelId && !modelHasRequiredEvidence(evidence)) throw new Error("BRAIN_MODEL_CAPABILITY_EVIDENCE_REQUIRED");
    return { providerKind: channel.providerKind, protocol: channel.agentProtocol, ...(evidence ? { modelCapabilityEvidence: evidence } : {}) };
}

function modelHasRequiredEvidence(evidence: AgentModelCapabilityEvidence | undefined): evidence is AgentModelCapabilityEvidence {
    return Boolean(evidence?.text && evidence.toolCalling && evidence.structuredOutput && evidence.evidenceSource && evidence.evidenceRevision);
}

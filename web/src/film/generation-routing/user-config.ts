import {
    hashBrainBinding,
    createPseudonymousBindingRef,
    hashGenerationEngineConnection,
    type BrainProfileBinding,
    type AgentProviderKind,
    type GenerationEngineConnection,
    type GenerationTaskKind,
    type LocalConfigMigrationResult,
    type UserSelectableBrainProfileId,
} from "@filmos/generation-contracts";

import { apiClient, request } from "@/services/api/request";
import type { AiConfig } from "@/stores/use-config-store";

export type GenerationDefaultRoute = { engineId: string; connectionId: string; modelId?: string; workflowId?: string; skillId?: string };

export type BrainGenerationRoutingConfig = {
    schemaVersion: 1;
    globalDefaultProfileId: UserSelectableBrainProfileId;
    bindings: BrainProfileBinding[];
    engineConnections: GenerationEngineConnection[];
    generationDefaults: Partial<Record<GenerationTaskKind, GenerationDefaultRoute>>;
    migration: {
        status: LocalConfigMigrationResult;
        source: "scoped_local_storage";
        migratedAt: string;
        ambiguousProfileIds: UserSelectableBrainProfileId[];
    };
};

export type DesktopUserConfigDocument = {
    format: "filmos.local-user-config/v1";
    schema_version: 1;
    entity_version: number;
    content_hash: string;
    created_at: string;
    updated_at: string;
    payload: { brain_generation_routing: BrainGenerationRoutingConfig | null };
};

export async function readBrainGenerationRoutingConfig(signal?: AbortSignal) {
    return request<DesktopUserConfigDocument>(apiClient.get("/desktop/user-config", { signal }));
}

export async function writeBrainGenerationRoutingConfig(document: DesktopUserConfigDocument, config: BrainGenerationRoutingConfig, signal?: AbortSignal) {
    return request<DesktopUserConfigDocument>(apiClient.put("/desktop/user-config", {
        expected_version: document.entity_version,
        expected_content_hash: document.content_hash,
        payload: { brain_generation_routing: config },
    }, { signal }));
}

export async function normalizeBrainGenerationRoutingConfig(config: BrainGenerationRoutingConfig, now = new Date().toISOString()): Promise<BrainGenerationRoutingConfig> {
    const exactProfiles = new Set<UserSelectableBrainProfileId>(["openai.api", "anthropic.api", "deepseek.api", "local.model"]);
    const ambiguous = new Set(config.migration.ambiguousProfileIds);
    let changed = false;
    const bindings = await Promise.all(config.bindings.map(async (binding) => {
        if (!exactProfiles.has(binding.profileId) || !binding.enabled) return binding;
        const evidence = binding.modelCapabilityEvidence;
        const exact = Boolean(binding.channelId && binding.modelId && binding.providerKind && binding.protocol && evidence?.text && evidence.toolCalling && evidence.structuredOutput && evidence.evidenceSource && evidence.evidenceRevision);
        const localBoundaryOk = binding.profileId !== "local.model" || binding.channelId !== "local:dreamina-cli";
        if (exact && localBoundaryOk) return binding;
        changed = true;
        ambiguous.add(binding.profileId);
        const { contentHash: _contentHash, channelId: _channelId, modelId: _modelId, modelCapabilityEvidence: _modelCapabilityEvidence, ...base } = binding;
        return completeBinding({ ...base, enabled: false, entityVersion: binding.entityVersion + 1, updatedAt: now });
    }));
    const sourceConnections = Array.isArray(config.engineConnections) && config.engineConnections.length ? config.engineConnections : await defaultEngineConnections(now);
    if (sourceConnections !== config.engineConnections) changed = true;
    const engineConnections = await Promise.all(sourceConnections.map(async (connection) => {
        if (connection.authScope !== "account" || connection.accountBindingRef || connection.status !== "ready") return connection;
        changed = true;
        const { contentHash: _contentHash, ...base } = connection;
        const next = { ...base, status: "not_configured" as const, entityVersion: connection.entityVersion + 1, updatedAt: now };
        return { ...next, contentHash: await hashGenerationEngineConnection(next) };
    }));
    if (!changed) return config;
    return {
        ...config,
        bindings,
        engineConnections,
        migration: {
            ...config.migration,
            status: ambiguous.size ? "SKIPPED_NEEDS_CONFIGURATION" : "MIGRATED_AUTOMATICALLY",
            migratedAt: now,
            ambiguousProfileIds: [...ambiguous].sort(),
        },
    };
}

function bindingBase(profileId: UserSelectableBrainProfileId, now: string): Omit<BrainProfileBinding, "contentHash"> {
    const api = ["openai.api", "anthropic.api", "deepseek.api"].includes(profileId);
    const local = profileId === "local.model";
    const chatgpt = profileId === "chatgpt.subscription.host";
    const providerKind: Partial<Record<UserSelectableBrainProfileId, AgentProviderKind>> = {
        "openai.api": "openai", "anthropic.api": "anthropic", "deepseek.api": "deepseek", "local.model": "local_openai_compatible",
    };
    const protocol: Partial<Record<UserSelectableBrainProfileId, BrainProfileBinding["protocol"]>> = {
        "openai.api": "openai_responses", "anthropic.api": "anthropic_messages", "deepseek.api": "openai_chat_completions", "local.model": "local_openai_compatible",
    };
    return {
        schemaVersion: 1,
        entityVersion: 1,
        profileId,
        enabled: profileId === "codex.subscription" || chatgpt,
        requiredCapabilities: ["text", "tool_calling", "structured_output"],
        transport: profileId === "codex.subscription" ? "codex_app_server" : chatgpt ? "chatgpt_host_mcp" : local ? "local_model" : "model_api",
        authMode: profileId === "codex.subscription" ? "chatgpt_managed" : chatgpt ? "chatgpt_host" : api ? "api_key" : "local",
        billingMode: profileId === "codex.subscription" || chatgpt ? "subscription" : api ? "metered_api" : "local_compute",
        interactionSurface: chatgpt ? "host_handoff" : "native_stream",
        allowApiFallback: false,
        ...(providerKind[profileId] ? { providerKind: providerKind[profileId], protocol: protocol[profileId] } : {}),
        createdAt: now,
        updatedAt: now,
    };
}

async function completeBinding(binding: Omit<BrainProfileBinding, "contentHash">): Promise<BrainProfileBinding> {
    return { ...binding, contentHash: await hashBrainBinding(binding) };
}

async function defaultEngineConnections(now: string): Promise<GenerationEngineConnection[]> {
    const definitions: Array<Pick<GenerationEngineConnection, "connectionId" | "engineId" | "authScope" | "status" | "enabled">> = [
        { connectionId: "dreamina-local", engineId: "dreamina_cli", authScope: "account", status: "not_configured", enabled: true },
        { connectionId: "flova-local", engineId: "flova_cli", authScope: "account", status: "not_configured", enabled: true },
        { connectionId: "runninghub-default", engineId: "runninghub", authScope: "account", status: "not_configured", enabled: false },
        { connectionId: "comfyui-default", engineId: "comfyui", authScope: "local_instance", status: "not_configured", enabled: false },
        { connectionId: "manual", engineId: "manual_web", authScope: "manual", status: "ready", enabled: true },
    ];
    return Promise.all(definitions.map(async (definition) => {
        const connection: Omit<GenerationEngineConnection, "contentHash"> = { schemaVersion: 1, entityVersion: 1, ...definition, connectionInstanceRef: createPseudonymousBindingRef("instance"), createdAt: now, updatedAt: now };
        return { ...connection, contentHash: await hashGenerationEngineConnection(connection) };
    }));
}

export async function defaultBrainGenerationRoutingConfig(now = new Date().toISOString()): Promise<BrainGenerationRoutingConfig> {
    const profiles: UserSelectableBrainProfileId[] = ["codex.subscription", "chatgpt.subscription.host", "openai.api", "anthropic.api", "deepseek.api", "local.model"];
    return {
        schemaVersion: 1,
        globalDefaultProfileId: "codex.subscription",
        bindings: await Promise.all(profiles.map((profileId) => completeBinding(bindingBase(profileId, now)))),
        engineConnections: await defaultEngineConnections(now),
        generationDefaults: {},
        migration: { status: "NO_OP_EQUIVALENT", source: "scoped_local_storage", migratedAt: now, ambiguousProfileIds: [] },
    };
}

/** Strict migration: protocol metadata may prove Claude/local; names and URLs are never evidence. */
export async function migrateLegacyAiConfig(legacy: AiConfig, now = new Date().toISOString()): Promise<BrainGenerationRoutingConfig> {
    const config = await defaultBrainGenerationRoutingConfig(now);
    const ambiguous = new Set<UserSelectableBrainProfileId>();
    const candidates: Partial<Record<UserSelectableBrainProfileId, Array<{ channelId: string; modelId: string }>>> = {};
    for (const channel of legacy.channels.filter((item) => item.enabled !== false)) {
        const textModels = channel.models.filter((model) => {
            const cost = channel.modelCosts?.find((item) => item.model === model);
            return cost?.capability === "text" || cost?.capability === undefined;
        });
        let profileId: UserSelectableBrainProfileId | undefined;
        if (channel.providerKind === "local_openai_compatible" && channel.transport === "local-llm-runtime") profileId = "local.model";
        else if (channel.providerKind === "anthropic") profileId = "anthropic.api";
        else if (channel.providerKind === "openai") profileId = "openai.api";
        else if (channel.providerKind === "deepseek") profileId = "deepseek.api";
        else for (const candidate of channel.transport === "local-llm-runtime" ? ["local.model"] as const : ["openai.api", "anthropic.api", "deepseek.api"] as const) ambiguous.add(candidate);
        if (profileId && textModels.length === 1 && channel.agentProtocol && channel.agentModelCapabilities?.[textModels[0]]) (candidates[profileId] ??= []).push({ channelId: channel.id, modelId: textModels[0] });
        else if (profileId && textModels.length !== 1) ambiguous.add(profileId);
    }
    config.bindings = await Promise.all(config.bindings.map(async (binding) => {
        const exact = candidates[binding.profileId];
        if (exact?.length !== 1) return binding;
        const channel = legacy.channels.find((item) => item.id === exact[0].channelId)!;
        ambiguous.delete(binding.profileId);
        const next = { ...binding, enabled: true, channelId: exact[0].channelId, modelId: exact[0].modelId, providerKind: channel.providerKind, protocol: channel.agentProtocol, modelCapabilityEvidence: channel.agentModelCapabilities?.[exact[0].modelId], entityVersion: binding.entityVersion + 1, updatedAt: now };
        return completeBinding(next);
    }));
    config.migration = {
        status: ambiguous.size ? "SKIPPED_NEEDS_CONFIGURATION" : "MIGRATED_AUTOMATICALLY",
        source: "scoped_local_storage", migratedAt: now, ambiguousProfileIds: [...ambiguous].sort(),
    };
    return config;
}

export async function updateBrainBinding(config: BrainGenerationRoutingConfig, profileId: UserSelectableBrainProfileId, patch: Partial<Pick<BrainProfileBinding, "enabled" | "channelId" | "modelId" | "providerKind" | "protocol" | "modelCapabilityEvidence">>, now = new Date().toISOString()): Promise<BrainGenerationRoutingConfig> {
    const current = config.bindings.find((item) => item.profileId === profileId);
    if (!current) throw new Error("BRAIN_BINDING_NOT_FOUND");
    const next = { ...current, ...patch, entityVersion: current.entityVersion + 1, updatedAt: now };
    const { contentHash: _contentHash, ...unhashed } = next;
    return { ...config, bindings: await Promise.all(config.bindings.map((item) => item.profileId === profileId ? completeBinding(unhashed) : item)) };
}

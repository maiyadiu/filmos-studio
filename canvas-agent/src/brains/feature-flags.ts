export const AGENT_FEATURE_FLAG_IDS = [
    "film.agent_native_brain_selector",
    "film.agent_generic_runtime",
    "film.agent_context_broker",
    "film.agent_canonical_tool_manifest",
    "film.agent_canonical_tool_broker",
    "film.agent_codex_subscription",
    "film.agent_chatgpt_host",
    "film.agent_model_api_profiles",
    "film.agent_no_silent_api_fallback",
    "film.agent_request_scoped_identity",
] as const;

export type AgentFeatureFlagId = typeof AGENT_FEATURE_FLAG_IDS[number];
export type AgentFeatureFlags = Record<AgentFeatureFlagId, boolean>;

const envNames: Record<AgentFeatureFlagId, string> = {
    "film.agent_native_brain_selector": "FILMOS_AGENT_NATIVE_BRAIN_SELECTOR",
    "film.agent_generic_runtime": "FILMOS_AGENT_GENERIC_RUNTIME",
    "film.agent_context_broker": "FILMOS_AGENT_CONTEXT_BROKER",
    "film.agent_canonical_tool_manifest": "FILMOS_AGENT_CANONICAL_TOOL_MANIFEST",
    "film.agent_canonical_tool_broker": "FILMOS_AGENT_CANONICAL_TOOL_BROKER",
    "film.agent_codex_subscription": "FILMOS_AGENT_CODEX_SUBSCRIPTION",
    "film.agent_chatgpt_host": "FILMOS_AGENT_CHATGPT_HOST",
    "film.agent_model_api_profiles": "FILMOS_AGENT_MODEL_API_PROFILES",
    "film.agent_no_silent_api_fallback": "FILMOS_AGENT_NO_SILENT_API_FALLBACK",
    "film.agent_request_scoped_identity": "FILMOS_AGENT_REQUEST_SCOPED_IDENTITY",
};

export function resolveAgentFeatureFlags(
    configured: Partial<Record<AgentFeatureFlagId, boolean>> = {},
    env: Record<string, string | undefined> = process.env,
): AgentFeatureFlags {
    return Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map((id) => {
        const value = env[envNames[id]];
        return [id, value === undefined ? configured[id] === true : value.trim().toLowerCase() === "true"];
    })) as AgentFeatureFlags;
}

export function assertGenericAgentRuntimeDependencies(flags: AgentFeatureFlags) {
    if (!flags["film.agent_generic_runtime"]) return;
    const required: AgentFeatureFlagId[] = [
        "film.agent_context_broker",
        "film.agent_canonical_tool_manifest",
        "film.agent_canonical_tool_broker",
        "film.agent_no_silent_api_fallback",
        "film.agent_request_scoped_identity",
    ];
    const missing = required.filter((id) => !flags[id]);
    if (missing.length) throw new Error(`AGENT_FEATURE_DEPENDENCIES_DISABLED:${missing.join(",")}`);
}

export function enabledAgentProfileIds(flags: AgentFeatureFlags) {
    return new Set([
        ...(flags["film.agent_codex_subscription"] ? ["codex.subscription"] : []),
        ...(flags["film.agent_chatgpt_host"] ? ["chatgpt.subscription.host"] : []),
        ...(flags["film.agent_model_api_profiles"] ? ["openai.api", "anthropic.api", "deepseek.api"] : []),
        ...(flags["film.agent_model_api_profiles"] ? ["local.model"] : []),
        "human.only",
    ]);
}

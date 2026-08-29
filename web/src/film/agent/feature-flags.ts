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

const envNames: Record<AgentFeatureFlagId, string> = {
    "film.agent_native_brain_selector": "VITE_FILM_AGENT_NATIVE_BRAIN_SELECTOR",
    "film.agent_generic_runtime": "VITE_FILM_AGENT_GENERIC_RUNTIME",
    "film.agent_context_broker": "VITE_FILM_AGENT_CONTEXT_BROKER",
    "film.agent_canonical_tool_manifest": "VITE_FILM_AGENT_CANONICAL_TOOL_MANIFEST",
    "film.agent_canonical_tool_broker": "VITE_FILM_AGENT_CANONICAL_TOOL_BROKER",
    "film.agent_codex_subscription": "VITE_FILM_AGENT_CODEX_SUBSCRIPTION",
    "film.agent_chatgpt_host": "VITE_FILM_AGENT_CHATGPT_HOST",
    "film.agent_model_api_profiles": "VITE_FILM_AGENT_MODEL_API_PROFILES",
    "film.agent_no_silent_api_fallback": "VITE_FILM_AGENT_NO_SILENT_API_FALLBACK",
    "film.agent_request_scoped_identity": "VITE_FILM_AGENT_REQUEST_SCOPED_IDENTITY",
};

export function isAgentFeatureEnabled(id: AgentFeatureFlagId, env: Record<string, unknown> = import.meta.env) {
    const value = env[envNames[id]];
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export function readAgentFeatureFlags(env: Record<string, unknown> = import.meta.env) {
    return Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map((id) => [id, isAgentFeatureEnabled(id, env)])) as Record<AgentFeatureFlagId, boolean>;
}

export const BRAIN_PROFILE_IDS = [
    "codex.subscription",
    "chatgpt.subscription.host",
    "openai.api",
    "anthropic.api",
    "deepseek.api",
    "local.model",
] as const;

export type NativeBrainProfileId = typeof BRAIN_PROFILE_IDS[number];
export type LegacyCanvasAgentMode = "online" | "local";
export type CanvasAgentMode = NativeBrainProfileId | LegacyCanvasAgentMode;

export type BrainProfilePresentation = {
    id: NativeBrainProfileId;
    label: string;
    detail: string;
    billing: "订阅" | "API 计费" | "本地";
    interaction: "native" | "hosted";
};

export const BRAIN_PROFILE_PRESENTATIONS: readonly BrainProfilePresentation[] = [
    { id: "codex.subscription", label: "Codex", detail: "订阅 · 原生", billing: "订阅", interaction: "native" },
    { id: "chatgpt.subscription.host", label: "ChatGPT", detail: "订阅 · Host 协作", billing: "订阅", interaction: "hosted" },
    { id: "openai.api", label: "OpenAI", detail: "API 计费", billing: "API 计费", interaction: "native" },
    { id: "anthropic.api", label: "Claude", detail: "API 计费", billing: "API 计费", interaction: "native" },
    { id: "deepseek.api", label: "DeepSeek", detail: "API 计费", billing: "API 计费", interaction: "native" },
    { id: "local.model", label: "Local", detail: "本地", billing: "本地", interaction: "native" },
] as const;

export function normalizeBrainProfileId(value: CanvasAgentMode | string | null | undefined): NativeBrainProfileId {
    if (value === "local") return "codex.subscription";
    if (value === "online") return "openai.api";
    return BRAIN_PROFILE_IDS.includes(value as NativeBrainProfileId) ? value as NativeBrainProfileId : "codex.subscription";
}

export function legacyAgentModeFromProfile(value: CanvasAgentMode | string): LegacyCanvasAgentMode {
    return normalizeBrainProfileId(value) === "codex.subscription" ? "local" : "online";
}

export function brainProfilePresentation(value: CanvasAgentMode | string) {
    const id = normalizeBrainProfileId(value);
    return BRAIN_PROFILE_PRESENTATIONS.find((profile) => profile.id === id) ?? BRAIN_PROFILE_PRESENTATIONS[0];
}

export function isModelApiBrainProfile(value: CanvasAgentMode | string) {
    return ["openai.api", "anthropic.api", "deepseek.api"].includes(normalizeBrainProfileId(value));
}

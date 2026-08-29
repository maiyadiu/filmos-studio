import type { AgentRuntimeAdapter, BrainProfile } from "../src/brains/contracts.js";

export function profile(id: string, provider: BrainProfile["provider"] = "openai.codex"): BrainProfile {
    return {
        id,
        displayName: id,
        provider,
        transport: provider === "openai.chatgpt" ? "chatgpt_host_mcp" : provider === "openai.gpt" ? "model_api" : "codex_app_server",
        authMode: provider === "openai.chatgpt" ? "chatgpt_host" : provider === "openai.gpt" ? "api_key" : "chatgpt_managed",
        billingMode: provider === "openai.gpt" ? "metered_api" : "subscription",
        interactionSurface: provider === "openai.chatgpt" ? "host_handoff" : "native_stream",
        toolSurface: provider === "openai.chatgpt" ? "chatgpt_hosted" : "workbench_operator",
        requiresApiKey: provider === "openai.gpt",
        mayCreateSeparateCharges: provider === "openai.gpt",
        availability: "enabled",
        capabilities: {
            streamingChat: provider !== "openai.chatgpt",
            threadHistory: true,
            threadResume: true,
            imageInput: true,
            automaticVisualContext: true,
            mcpTools: true,
            read: true,
            preview: true,
            applyAfterHumanConfirmation: provider !== "openai.chatgpt",
            hostedProposalReturn: provider === "openai.chatgpt",
            cancelTurn: true,
        },
    };
}

export function adapter(id: string, calls: string[] = []): AgentRuntimeAdapter {
    return {
        connectionId: id,
        profileId: id,
        probe: async () => ({ profileId: id, status: "ready", checkedAt: new Date(0).toISOString() }),
        createSession: async (input) => {
            calls.push(`create:${id}:${input.projectId}:${input.canvasId}`);
            return { providerThreadId: `${id}-thread-${input.projectId}` };
        },
        resumeSession: async ({ sessionId, providerThreadId }) => ({ id: sessionId, providerThreadId }),
        sendTurn: async (input) => ({ sessionId: input.session.id, turnId: input.turnId, providerThreadId: input.session.providerThreadId, text: id, status: id.includes("hosted") ? "handoff_pending" : "completed" }),
        cancelTurn: async () => undefined,
        closeSession: async () => undefined,
    };
}

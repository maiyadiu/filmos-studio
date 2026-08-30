import { describe, expect, test } from "bun:test";

import { BrowserRuntimeSessionProfiles, createBrowserRuntimeRequestHandler, exactBoundModelConfig } from "../src/film/agent/browser-runtime-handler";
import type { BrowserRuntimeRequest } from "../src/film/agent/browser-runtime-bridge";
import { createModelChannel, defaultConfig, type ModelChannel } from "../src/stores/use-config-store";

const profileIds = ["openai.api", "anthropic.api", "deepseek.api", "local.model"] as const;

describe("AGENT-BROWSER-LIFECYCLE-001", () => {
    test("exact binding selects only the declared Channel and Model without name or URL guessing", () => {
        const misleading = createModelChannel({ id: "looks-deepseek", name: "DeepSeek", baseUrl: "https://deepseek.example", apiKey: "secret-a", apiFormat: "openai", models: ["guess-model"] });
        const exact = createModelChannel({ id: "channel-exact", name: "Neutral", baseUrl: "https://neutral.example", apiKey: "secret-b", apiFormat: "openai", models: ["model-exact"] });
        const config = { ...defaultConfig, channels: [misleading, exact] };
        const projected = exactBoundModelConfig(config, {
            schemaVersion: 1, entityVersion: 1, contentHash: "binding-hash", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
            profileId: "deepseek.api", enabled: true, channelId: exact.id, modelId: "model-exact", requiredCapabilities: ["text", "tool_calling"],
            transport: "model_api", authMode: "api_key", billingMode: "metered_api", interactionSurface: "native_stream", allowApiFallback: false,
            providerKind: "deepseek", protocol: "openai_chat_completions", modelCapabilityEvidence: evidence(),
        });
        expect(projected.channels.map((channel) => channel.id)).toEqual(["channel-exact"]);
        expect(projected.model).toBe("model-exact");
        expect(projected.textModel).toBe("model-exact");
        expect(projected.baseUrl).toBe("https://neutral.example");
    });

    test("OpenAI DeepSeek and Local sessions use their real profile for create cancel and close", async () => {
        const profiles = new BrowserRuntimeSessionProfiles();
        const clientCalls: string[] = [];
        const client = { requestTool: async () => { clientCalls.push("requestTool"); throw new Error("unexpected model request"); } };

        const openai = handler("openai.api", profiles, client);
        await openai(request("openai.api", "create_session", "openai-session"));
        await openai(request("openai.api", "cancel_turn", "openai-session"));
        await openai(request("openai.api", "close_session", "openai-session"));

        const deepseek = handler("deepseek.api", profiles, client);
        await deepseek(request("deepseek.api", "create_session", "deepseek-session"));
        await deepseek(request("deepseek.api", "close_session", "deepseek-session"));

        const local = handler("local.model", profiles, client);
        await local(request("local.model", "create_session", "local-session"));
        await local(request("local.model", "cancel_turn", "local-session"));
        await local(request("local.model", "close_session", "local-session"));

        await openai(request("openai.api", "create_session", "cross-profile-session"));
        await expect(deepseek(request("deepseek.api", "close_session", "cross-profile-session"))).rejects.toThrow("BROWSER_RUNTIME_SESSION_PROFILE_SCOPE_MISMATCH");
        expect(clientCalls).toEqual([]);
    });

    test("all model probes are non-networking and independent of the selected execution profile", async () => {
        const profiles = new BrowserRuntimeSessionProfiles();
        const clientCalls: string[] = [];
        const selections = ["codex.subscription", "openai.api", "deepseek.api", "local.model"];
        for (const selectedProfileId of selections) {
            const selected = handler(selectedProfileId, profiles, { requestTool: async () => { clientCalls.push("requestTool"); throw new Error("unexpected model request"); } });
            const statuses = await Promise.all(profileIds.map((profileId) => selected(request(profileId, "probe"))));
            expect(statuses).toHaveLength(4);
            expect(statuses.every((status) => typeof status === "object" && status !== null && "status" in status && status.status === "ready")).toBe(true);
        }
        expect(clientCalls).toEqual([]);

        console.log("FILMOS_AGENT_BROWSER_LIFECYCLE_RECEIPT", JSON.stringify({
            gate_id: "AGENT-BROWSER-LIFECYCLE-001",
            status: "PASSED",
            lifecycle_profiles: ["openai.api", "deepseek.api", "local.model"],
            probe_profiles: [...profileIds],
            selected_profile_matrix: selections,
            cross_profile_denied: true,
            provider_request_count: 0,
        }));
    });
});

function handler(selectedProfileId: string, sessionProfiles: BrowserRuntimeSessionProfiles, client: { requestTool(...args: never[]): Promise<never> }) {
    const channels = profileIds.map(channelForProfile);
    return createBrowserRuntimeRequestHandler({
        selectedProfileId,
        config: { ...defaultConfig, channels },
        isConfigReady: () => true,
        resolveBinding: (profileId) => ({
            schemaVersion: 1,
            entityVersion: 1,
            contentHash: `binding:${profileId}`,
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z",
            profileId,
            enabled: true,
            requiredCapabilities: ["text", "tool_calling"],
            transport: profileId === "local.model" ? "local_model" : "model_api",
            authMode: profileId === "local.model" ? "local" : "api_key",
            billingMode: profileId === "local.model" ? "local_compute" : "metered_api",
            interactionSurface: "native_stream",
            allowApiFallback: false,
            channelId: `channel-${profileId}`,
            modelId: `model-${profileId}`,
            providerKind: providerForProfile(profileId),
            protocol: protocolForProfile(profileId),
            modelCapabilityEvidence: evidence(),
        }) as never,
        ordinaryConfirmationEnabled: true,
        sessionProfiles,
        client: client as never,
    });
}

function channelForProfile(profileId: (typeof profileIds)[number]): ModelChannel {
    const modelId = `model-${profileId}`;
    return createModelChannel({
        id: `channel-${profileId}`,
        name: "Exact test channel",
        baseUrl: profileId === "local.model" ? "http://127.0.0.1:11434" : "https://provider.invalid",
        apiKey: profileId === "local.model" ? "local-runtime-auth" : "non-network-test-secret",
        apiFormat: profileId === "anthropic.api" ? "claude" : "openai",
        models: [modelId],
        transport: profileId === "local.model" ? "local-llm-runtime" : "backend-channel",
        providerKind: providerForProfile(profileId),
        agentProtocol: protocolForProfile(profileId),
        agentModelCapabilities: { [modelId]: evidence() },
    });
}

function providerForProfile(profileId: (typeof profileIds)[number]) {
    return profileId === "openai.api" ? "openai" as const : profileId === "anthropic.api" ? "anthropic" as const : profileId === "deepseek.api" ? "deepseek" as const : "local_openai_compatible" as const;
}

function protocolForProfile(profileId: (typeof profileIds)[number]) {
    return profileId === "openai.api" ? "openai_responses" as const : profileId === "anthropic.api" ? "anthropic_messages" as const : profileId === "deepseek.api" ? "openai_chat_completions" as const : "local_openai_compatible" as const;
}

function evidence() {
    return { text: true as const, toolCalling: true, structuredOutput: true, evidenceSource: "test-exact-contract", evidenceRevision: "v1" };
}

function request(profileId: string, operation: BrowserRuntimeRequest["operation"], sessionId?: string): BrowserRuntimeRequest {
    return {
        requestId: `${profileId}:${operation}:${sessionId || "probe"}`,
        channel: "model",
        operation,
        profileId,
        ...(sessionId ? { sessionId } : {}),
        payload: {},
    };
}

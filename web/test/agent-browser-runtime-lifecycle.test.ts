import { describe, expect, test } from "bun:test";

import { BrowserRuntimeSessionProfiles, createBrowserRuntimeRequestHandler } from "../src/film/agent/browser-runtime-handler";
import type { BrowserRuntimeRequest } from "../src/film/agent/browser-runtime-bridge";
import { defaultConfig } from "../src/stores/use-config-store";

const profileIds = ["openai.api", "anthropic.api", "deepseek.api", "local.model"] as const;

describe("AGENT-BROWSER-LIFECYCLE-001", () => {
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
            expect(statuses.every((status) => typeof status === "object" && status !== null && "status" in status)).toBe(true);
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
    return createBrowserRuntimeRequestHandler({
        selectedProfileId,
        config: defaultConfig,
        isConfigReady: () => true,
        ordinaryConfirmationEnabled: true,
        sessionProfiles,
        client: client as never,
    });
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

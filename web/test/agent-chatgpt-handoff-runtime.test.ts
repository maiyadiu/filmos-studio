import { afterEach, describe, expect, test } from "bun:test";

import { createBrowserRuntimeRequestHandler } from "../src/film/agent/browser-runtime-handler";
import type { BrowserRuntimeRequest } from "../src/film/agent/browser-runtime-bridge";
import { defaultConfig } from "../src/stores/use-config-store";

describe("CHATGPT-HANDOFF-STATE-001 browser boundary", () => {
    afterEach(() => { delete (globalThis as { window?: unknown }).window; });

    test("only an observation bound to the persisted handoff advances lifecycle state", async () => {
        const expected = "handoff-expected";
        const observed = await resume(expected, expected, "filmos_get_pending_agent_handoff");
        expect(observed.status).toBe("observed");
        expect(observed.observedHandoffId).toBe(expected);

        const proposed = await resume(expected, expected, "filmos_prepare_proposal_export");
        expect(proposed.status).toBe("proposal_received");
        expect(proposed.proposalReceivedAt).toBe("2099-01-01T00:01:00.000Z");

        const unrelated = await resume(expected, "handoff-other", "filmos_prepare_proposal_export");
        expect(unrelated.status).toBe("waiting_for_host");
        expect(unrelated.observedHandoffId).toBeUndefined();
    });
});

async function resume(expectedHandoffId: string, observedHandoffId: string, toolName: string) {
    (globalThis as { window?: unknown }).window = {
        filmOSChatGPTHostStatus: {
            profileId: "chatgpt.subscription.host.pro_readonly",
            state: "CHATGPT_REACHED_FILMOS",
            authorizedProjectId: "project-a",
            authorizedGrantId: "project-grant-a",
            tunnelConnected: true,
            externalAccountConnected: true,
            mcpToolCount: 20,
            mcpReadToolCount: 20,
            mcpWriteToolCount: 0,
            mcpPaidToolCount: 0,
            mcpDestructiveToolCount: 0,
            billingMode: "subscription_host_no_extra_model_api",
            proposalHandoffEnabled: true,
            lastReadAt: "2099-01-01T00:01:00.000Z",
            lastExternalToolName: toolName,
            lastExternalRequestId: "request-a",
            observedHandoffId,
        },
    };
    const handler = createBrowserRuntimeRequestHandler({
        selectedProfileId: "chatgpt.subscription.host",
        config: defaultConfig,
        isConfigReady: () => false,
        resolveBinding: () => undefined,
        ordinaryConfirmationEnabled: true,
        client: { requestTool: async () => { throw new Error("CHATGPT_HANDOFF_GATE_MUST_NOT_CALL_LOCAL_RUNTIME"); } } as never,
    });
    return await handler({
        requestId: `resume:${expectedHandoffId}:${observedHandoffId}`,
        channel: "chatgpt_host",
        operation: "resume_session",
        profileId: "chatgpt.subscription.host",
        sessionId: "session-a",
        payload: { input: {
            projectId: "project-a",
            canvasId: "canvas-a",
            hostHandoff: { handoffId: expectedHandoffId },
        } },
    } satisfies BrowserRuntimeRequest) as Record<string, unknown>;
}

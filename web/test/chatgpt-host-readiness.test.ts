import { expect, test } from "bun:test";

import { chatGPTHostReadiness } from "../src/film/agent/chatgpt-host-readiness";
import type { FilmOSDesktopChatGPTHostStatus } from "../src/film/agent/workbench-context";

const now = Date.parse("2026-08-31T00:00:00.000Z");

test("ChatGPT Host readiness requires a fresh current-project read-only Tunnel contract", () => {
    const ready = chatGPTHostReadiness(status(), "project-a", now);
    expect(ready).toMatchObject({ handoffReady: true, externalConnected: false, code: "chatgpt_host_waiting" });

    expect(chatGPTHostReadiness(status({ publishedAt: "2026-08-30T23:59:00.000Z" }), "project-a", now).code).toBe("chatgpt_host_status_stale");
    expect(chatGPTHostReadiness(status({ authorizedProjectId: "project-b" }), "project-a", now).code).toBe("chatgpt_host_project_mismatch");
    expect(chatGPTHostReadiness(status({ tunnelConnected: false }), "project-a", now).code).toBe("chatgpt_host_tunnel_unavailable");
    expect(chatGPTHostReadiness(status({ mcpWriteToolCount: 1 }), "project-a", now).code).toBe("chatgpt_host_mcp_contract_invalid");
});

test("ChatGPT is only labelled connected after a proven external Host read", () => {
    expect(chatGPTHostReadiness(status(), "project-a", now).message).toBe("Host 已就绪，等待 ChatGPT 接管");
    expect(chatGPTHostReadiness(status({ externalAccountConnected: true, state: "CHATGPT_REACHED_FILMOS" }), "project-a", now)).toMatchObject({
        handoffReady: true,
        externalConnected: true,
        message: "ChatGPT 已连接",
    });
});

function status(patch: Partial<FilmOSDesktopChatGPTHostStatus> = {}): FilmOSDesktopChatGPTHostStatus {
    return {
        publishedAt: "2026-08-31T00:00:00.000Z",
        profileId: "chatgpt.subscription.host.pro_readonly",
        state: "WAITING_FOR_CHATGPT",
        authorizedProjectId: "project-a",
        authorizedGrantId: "grant-a",
        grantExpiresAt: "2026-08-31T00:10:00.000Z",
        tunnelConnected: true,
        externalAccountConnected: false,
        mcpToolCount: 20,
        mcpReadToolCount: 20,
        mcpWriteToolCount: 0,
        mcpPaidToolCount: 0,
        mcpDestructiveToolCount: 0,
        billingMode: "subscription_host_no_extra_model_api",
        proposalHandoffEnabled: true,
        ...patch,
    };
}

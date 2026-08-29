import { describe, expect, test } from "bun:test";

import { createFilmChatGPTHandoffClient } from "./handoff-client.ts";

const projectId = "project-real-a";

describe("ChatGPT handoff local boundary", () => {
    test("unauthenticated health is readiness only and scoped status proves the external observation", async () => {
        const requests = [];
        const client = createFilmChatGPTHandoffClient({
            baseUrl: "http://127.0.0.1:17840",
            proposalHandoffEnabled: true,
            grantToken: () => "short-lived-project-grant",
            fetchImpl: async (url, init) => {
                requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
                if (String(url).endsWith("/health")) return json({
                    ok: true,
                    feature: "film.chatgpt_app",
                    enabled: true,
                    public_listener: false,
                    proposal_handoff_enabled: true,
                    external_account_connected: false,
                });
                return json({
                    connection: "connected",
                    local_mcp_ready: true,
                    external_account_connected: true,
                    authorized_project: { project_id: projectId, grant_id: "grant-a", expires_at: "2026-08-29T12:00:00.000Z" },
                    last_read_at: "2026-08-29T11:00:00.000Z",
                    last_context_snapshot: { uri: `filmos://project/${projectId}`, version: 3, state_hash: "a".repeat(64) },
                    proposal_handoff_enabled: true,
                    status_code: "CHATGPT_REACHED_FILMOS",
                });
            },
        });
        const status = await client.getStatus(projectId);
        expect(status.connection).toBe("connected");
        expect(status.external_account_connected).toBe(true);
        expect(status.authorized_project?.project_id).toBe(projectId);
        expect(requests).toEqual([
            { url: "http://127.0.0.1:17840/health", authorization: null },
            { url: `http://127.0.0.1:17840/handoff/status?project_id=${projectId}`, authorization: "Bearer short-lived-project-grant" },
        ]);
    });

    test("missing project grant never promotes unauthenticated health to connected", async () => {
        const client = createFilmChatGPTHandoffClient({
            baseUrl: "http://127.0.0.1:17840",
            proposalHandoffEnabled: false,
            grantToken: () => undefined,
            fetchImpl: async () => json({
                ok: true,
                feature: "film.chatgpt_app",
                enabled: true,
                public_listener: false,
                proposal_handoff_enabled: false,
                external_account_connected: true,
            }),
        });
        const status = await client.getStatus(projectId);
        expect(status.connection).toBe("disconnected");
        expect(status.external_account_connected).toBe(false);
        expect(status.status_code).toBe("PROJECT_GRANT_REQUIRED");
    });
});

function json(value) {
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

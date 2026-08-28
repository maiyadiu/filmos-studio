import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProjectDetail } from "@/services/api/projects";

import { parseProposalPreviewReceipt, parseUntrustedProposalPackage, type ChatGPTHandoffStatus } from "@/film/chatgpt/contracts";
import { createFilmChatGPTHandoffClient, resolveFilmChatGPTHandoffConfig } from "@/film/chatgpt/handoff-client";
import { FilmChatGPTHandoffEntry } from "@/film/chatgpt/handoff-entry";
import { ChatGPTHandoffPanel } from "@/film/chatgpt/handoff-panel";

describe("FilmOS ChatGPT Handoff Web boundary", () => {
    test("all ChatGPT DOM and requests stay absent when the feature flag is off", () => {
        let detailReads = 0;
        const detail = new Proxy({} as ProjectDetail, {
            get() {
                detailReads += 1;
                throw new Error("disabled entry must not inspect ProjectDetail");
            },
        });
        const client = {
            async getStatus() { throw new Error("disabled entry must not request status"); },
            async previewProposal() { throw new Error("disabled entry must not preview"); },
            async revokeGrant() { throw new Error("disabled entry must not revoke"); },
        };
        expect(resolveFilmChatGPTHandoffConfig({})).toEqual({ enabled: false, proposalHandoffEnabled: false, baseUrl: "http://127.0.0.1:17840" });
        expect(renderToStaticMarkup(<FilmChatGPTHandoffEntry detail={detail} env={{}} client={client} />)).toBe("");
        expect(detailReads).toBe(0);
    });

    test("enabled config accepts only an explicit loopback HTTP port", () => {
        expect(resolveFilmChatGPTHandoffConfig({ VITE_FILM_CHATGPT_APP: " TRUE ", VITE_FILM_CHATGPT_PROPOSAL_HANDOFF: "true", VITE_FILM_CHATGPT_HANDOFF_URL: "http://localhost:17840/" })).toEqual({
            enabled: true,
            proposalHandoffEnabled: true,
            baseUrl: "http://localhost:17840",
        });
        expect(() => resolveFilmChatGPTHandoffConfig({ VITE_FILM_CHATGPT_APP: "true", VITE_FILM_CHATGPT_HANDOFF_URL: "https://remote.example/mcp" })).toThrow("本机 HTTP");
        expect(() => resolveFilmChatGPTHandoffConfig({ VITE_FILM_CHATGPT_APP: "true", VITE_FILM_CHATGPT_HANDOFF_URL: "http://127.0.0.1:17840/?token=secret" })).toThrow("凭据或参数");
    });

    test("panel reports receipts without implying a ChatGPT subscription or formal apply", () => {
        const markup = renderToStaticMarkup(<ChatGPTHandoffPanel
            project={{ id: "project-golden", name: "Golden" }}
            state={{ state: "ready", status: connectedStatus() }}
            proposalHandoffEnabled
            onRefresh={() => {}}
            onPreviewProposal={async () => previewReceipt()}
            onRevoke={async () => {}}
            onOpenChatGPT={() => {}}
        />);
        expect(markup).toContain('data-film-feature="chatgpt-handoff"');
        expect(markup).toContain("ChatGPT Handoff");
        expect(markup).toContain("当前授权项目");
        expect(markup).toContain("Golden");
        expect(markup).toContain("Context Snapshot");
        expect(markup).toContain("导入 ChatGPT Proposal");
        expect(markup).toContain("撤销授权");
        expect(markup).toContain("不模拟 ChatGPT 订阅");
        expect(markup).not.toContain("Formal Apply 已执行");
    });

    test("health is the only request without a memory-only Project Grant", async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const client = createFilmChatGPTHandoffClient({
            baseUrl: "http://127.0.0.1:17840",
            proposalHandoffEnabled: true,
            fetchImpl: async (input, init) => {
                calls.push({ url: String(input), init });
                return Response.json({ ok: true, feature: "film.chatgpt_app", enabled: true, proposal_handoff_enabled: true, public_listener: false, external_account_connected: false });
            },
        });
        const status = await client.getStatus("project one");
        expect(status).toMatchObject({ connection: "disconnected", local_mcp_ready: true, authorized_project: null, status_code: "PROJECT_GRANT_REQUIRED" });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("http://127.0.0.1:17840/health");
        expect(new Headers(calls[0].init?.headers).has("Authorization")).toBe(false);
        expect(calls[0].init?.credentials).toBe("omit");
    });

    test("status and revoke use one injected grant without browser persistence", async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const client = createFilmChatGPTHandoffClient({
            baseUrl: "http://127.0.0.1:17840",
            proposalHandoffEnabled: true,
            grantToken: () => "fg_memory_only",
            fetchImpl: async (input, init) => {
                const url = String(input);
                calls.push({ url, init });
                if (url.endsWith("/health")) return Response.json({ ok: true, feature: "film.chatgpt_app", enabled: true, proposal_handoff_enabled: true, public_listener: false, external_account_connected: false });
                if (url.includes("/handoff/status")) return Response.json(localServiceStatus());
                return Response.json({ revoked: true, grant_id: "grant-1", revoked_at: "2026-08-28T10:03:00.000Z" });
            },
        });
        const status = await client.getStatus("project one");
        expect(status.authorized_project?.grant_id).toBe("grant-1");
        expect(status).toMatchObject({ connection: "disconnected", local_mcp_ready: true, external_account_connected: false, status_code: "BLOCKED_EXTERNAL_ACCOUNT" });
        expect(calls[1].url).toBe("http://127.0.0.1:17840/handoff/status?project_id=project%20one");
        expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer fg_memory_only");
        const receipt = await client.revokeGrant(status.authorized_project!);
        expect(receipt.revoked_at).toBe("2026-08-28T10:03:00.000Z");
        expect(JSON.parse(String(calls[2].init?.body))).toEqual({ grant_id: "grant-1" });
    });

    test("Web treats package fields as untrusted display and accepts only Core Preview authority", async () => {
        const untrusted = parseUntrustedProposalPackage(JSON.stringify({
            proposal_id: "proposal-1",
            host_project_id: "wrong-project",
            proposal_type: "Approved",
            summary: "untrusted summary",
            expires_at: "2000-01-01T00:00:00Z",
            items: [{ command: "delete" }],
        }));
        expect(untrusted.display).toEqual({ proposal_id: "proposal-1", host_project_id: "wrong-project", proposal_type: "Approved", summary: "untrusted summary" });
        expect(() => parseProposalPreviewReceipt({ ...previewReceipt(), preview: { ...previewReceipt().preview, formal_write_executed: true } }, "project-golden", untrusted)).toThrow("Preview 安全边界");
        const accepted = parseProposalPreviewReceipt(previewReceipt(), "project-golden", untrusted);
        expect(accepted.preview.status).toBe("PREVIEW_REQUIRES_HUMAN_APPROVAL");
        expect(accepted.preview.outputs).toEqual([{ kind: "Candidate", status: "DRAFT", source_index: 0, payload: { title: "candidate" } }]);
    });

    test("proposal preview forwards only the parsed package to the loopback authority", async () => {
        let recorded: { url: string; init?: RequestInit } | undefined;
        const client = createFilmChatGPTHandoffClient({
            baseUrl: "http://localhost:17840",
            proposalHandoffEnabled: true,
            grantToken: () => "fg_preview",
            fetchImpl: async (input, init) => {
                recorded = { url: String(input), init };
                return Response.json(previewReceipt());
            },
        });
        const untrusted = parseUntrustedProposalPackage(JSON.stringify({ proposal_id: "proposal-1", host_project_id: "project-golden", proposal_type: "Candidate", summary: "candidate", items: [] }));
        const receipt = await client.previewProposal("project-golden", untrusted);
        expect(receipt.kind).toBe("FILMOS_PROPOSAL_IMPORT_PREVIEW");
        expect(recorded?.url).toBe("http://localhost:17840/handoff/proposals/preview");
        expect(JSON.parse(String(recorded?.init?.body))).toEqual({ package: untrusted.raw });
        expect(new Headers(recorded?.init?.headers).get("Authorization")).toBe("Bearer fg_preview");
    });
});

function connectedStatus(): ChatGPTHandoffStatus {
    return {
        connection: "connected",
        local_mcp_ready: true,
        external_account_connected: true,
        authorized_project: { project_id: "project-golden", project_name: "Golden", grant_id: "grant-1", expires_at: "2026-08-28T11:00:00.000Z" },
        last_read_at: "2026-08-28T10:00:00.000Z",
        last_context_snapshot: { uri: "filmos://project/project-golden", version: 3, state_hash: "a".repeat(64) },
        proposal_handoff_enabled: true,
        status_code: "CONNECTED",
    };
}

function localServiceStatus(): ChatGPTHandoffStatus {
    return {
        ...connectedStatus(),
        connection: "disconnected",
        external_account_connected: false,
        authorized_project: { project_id: "project one", grant_id: "grant-1", expires_at: "2026-08-28T11:00:00.000Z" },
        status_code: "BLOCKED_EXTERNAL_ACCOUNT",
    };
}

function previewReceipt() {
    return {
        ok: true as const,
        kind: "FILMOS_PROPOSAL_IMPORT_PREVIEW" as const,
        preview: {
            proposal_id: "proposal-1",
            content_hash: "b".repeat(64),
            host_project_id: "project-golden",
            base_state_hash: "c".repeat(64),
            status: "PREVIEW_REQUIRES_HUMAN_APPROVAL" as const,
            outputs: [{ kind: "Candidate" as const, status: "DRAFT" as const, source_index: 0, payload: { title: "candidate" } }],
            audit_action: "external_brain.proposal.previewed" as const,
            formal_write_executed: false as const,
            provider_task_created: false as const,
            deletion_executed: false as const,
            idempotent_replay: false,
        },
        untrusted_display_summary: "candidate",
    };
}

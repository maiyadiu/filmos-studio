import type { FilmOSDesktopChatGPTHostStatus } from "./workbench-context";

const LIVE_STATES = new Set(["WAITING_FOR_CHATGPT", "CHATGPT_REACHED_FILMOS"]);
const MAX_STATUS_AGE_MS = 15_000;

export type ChatGPTHostReadiness = {
    handoffReady: boolean;
    externalConnected: boolean;
    code: string;
    message: string;
};

export function chatGPTHostReadiness(
    status: FilmOSDesktopChatGPTHostStatus | null | undefined,
    projectId: string,
    now = Date.now(),
): ChatGPTHostReadiness {
    if (!status) return blocked("chatgpt_host_status_missing", "未收到当前 FilmOS App 的 ChatGPT Host 实时状态");
    const publishedAt = Date.parse(status.publishedAt);
    if (!Number.isFinite(publishedAt) || publishedAt > now + 5_000 || now - publishedAt > MAX_STATUS_AGE_MS) {
        return blocked("chatgpt_host_status_stale", "ChatGPT Host 状态已过期，请重新连接");
    }
    if (!projectId) return blocked("chatgpt_host_project_required", "当前画布尚未绑定 Film Project");
    if (status.authorizedProjectId !== projectId) return blocked("chatgpt_host_project_mismatch", "当前项目尚未获得 ChatGPT Project Grant");
    if (!LIVE_STATES.has(status.state) || !status.tunnelConnected) return blocked("chatgpt_host_tunnel_unavailable", "Secure Tunnel 尚未连接");
    if (!status.authorizedGrantId || !validGrant(status.grantExpiresAt, now)) return blocked("chatgpt_host_grant_unavailable", "当前项目的 ChatGPT Project Grant 尚未就绪");
    if (status.mcpReadToolCount < 1 || status.mcpWriteToolCount !== 0 || status.mcpPaidToolCount !== 0 || status.mcpDestructiveToolCount !== 0) {
        return blocked("chatgpt_host_mcp_contract_invalid", "ChatGPT MCP 只读安全合同未通过");
    }
    if (status.billingMode !== "subscription_host_no_extra_model_api") return blocked("chatgpt_host_billing_contract_invalid", "ChatGPT Host 计费边界无效");
    return {
        handoffReady: true,
        externalConnected: status.externalAccountConnected,
        code: status.externalAccountConnected ? "chatgpt_host_connected" : "chatgpt_host_waiting",
        message: status.externalAccountConnected ? "ChatGPT 已连接" : "Host 已就绪，等待 ChatGPT 接管",
    };
}

function validGrant(value: string | undefined, now: number) {
    const expiresAt = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(expiresAt) && expiresAt - now > 60_000;
}

function blocked(code: string, message: string): ChatGPTHostReadiness {
    return { handoffReady: false, externalConnected: false, code, message };
}

import {
    parseProposalPreviewReceipt,
    type ChatGPTAuthorizedProject,
    type ChatGPTConnectionState,
    type ChatGPTHandoffStatus,
    type ContextSnapshotSummary,
    type ProposalPreviewReceipt,
    type UntrustedProposalPackage,
} from "./contracts";

export const FILM_CHATGPT_APP_ENV = "VITE_FILM_CHATGPT_APP" as const;
export const FILM_CHATGPT_PROPOSAL_HANDOFF_ENV = "VITE_FILM_CHATGPT_PROPOSAL_HANDOFF" as const;
export const FILM_CHATGPT_HANDOFF_URL_ENV = "VITE_FILM_CHATGPT_HANDOFF_URL" as const;
export const DEFAULT_FILM_CHATGPT_HANDOFF_URL = "http://127.0.0.1:17840";

export type FilmChatGPTHandoffConfig = {
    enabled: boolean;
    proposalHandoffEnabled: boolean;
    baseUrl: string;
};

export type GrantTokenProvider = () => string | undefined | Promise<string | undefined>;

export type FilmChatGPTHandoffClient = {
    getStatus(projectId: string, signal?: AbortSignal): Promise<ChatGPTHandoffStatus>;
    previewProposal(projectId: string, proposal: UntrustedProposalPackage, signal?: AbortSignal): Promise<ProposalPreviewReceipt>;
    revokeGrant(project: ChatGPTAuthorizedProject, signal?: AbortSignal): Promise<{ revoked_at: string }>;
};

export function resolveFilmChatGPTHandoffConfig(env: Record<string, unknown> = import.meta.env): FilmChatGPTHandoffConfig {
    const enabled = isExplicitTrue(env[FILM_CHATGPT_APP_ENV]);
    return {
        enabled,
        proposalHandoffEnabled: enabled && isExplicitTrue(env[FILM_CHATGPT_PROPOSAL_HANDOFF_ENV]),
        baseUrl: enabled ? normalizeLoopbackBaseUrl(env[FILM_CHATGPT_HANDOFF_URL_ENV]) : DEFAULT_FILM_CHATGPT_HANDOFF_URL,
    };
}

export function createFilmChatGPTHandoffClient(options: {
    baseUrl: string;
    proposalHandoffEnabled: boolean;
    fetchImpl?: typeof fetch;
    grantToken?: GrantTokenProvider;
}): FilmChatGPTHandoffClient {
    const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    const fetchImpl = options.fetchImpl ?? fetch;
    const grantToken = options.grantToken ?? (() => undefined);
    const request = async (path: string, init: RequestInit, signal?: AbortSignal, authorizationRequired = false, suppliedToken?: string): Promise<unknown> => {
        const token = authorizationRequired ? suppliedToken ?? await grantToken() : undefined;
        if (authorizationRequired && !token) throw new HandoffClientError("PROJECT_GRANT_REQUIRED", "当前 Web session 没有桌面 Keychain 中的短期 Project Grant");
        const response = await fetchImpl(`${baseUrl}${path}`, {
            ...init,
            credentials: "omit",
            cache: "no-store",
            headers: {
                Accept: "application/json",
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...init.headers,
            },
            signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const code = isRecord(body) && typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
            throw new HandoffClientError(code, `FilmOS ChatGPT 本机边界返回 ${code}`);
        }
        return body;
    };
    return {
        async getStatus(projectId, signal) {
            const health = parseHealth(await request("/health", { method: "GET" }, signal));
            if (!health.enabled) return emptyStatus("disabled", health.proposal_handoff_enabled, "FILM_CHATGPT_APP_DISABLED");
            const token = await grantToken();
            if (!token) {
                return emptyStatus(health.external_account_connected ? "connected" : "disconnected", health.proposal_handoff_enabled, "PROJECT_GRANT_REQUIRED", true);
            }
            const body = await request(`/handoff/status?project_id=${encodeURIComponent(projectId)}`, { method: "GET" }, signal, true, token);
            return parseStatus(body, health, projectId);
        },
        async previewProposal(projectId, proposal, signal) {
            if (!options.proposalHandoffEnabled) throw new HandoffClientError("PROPOSAL_HANDOFF_DISABLED", "Proposal Handoff Feature Flag 未开启");
            const body = await request("/handoff/proposals/preview", { method: "POST", body: JSON.stringify({ package: proposal.raw }) }, signal, true);
            return parseProposalPreviewReceipt(body, projectId, proposal);
        },
        async revokeGrant(project, signal) {
            const body = requireRecord(await request("/handoff/grants/revoke", { method: "POST", body: JSON.stringify({ grant_id: project.grant_id }) }, signal, true), "revoke receipt");
            if (body.revoked !== true || body.grant_id !== project.grant_id) throw new HandoffClientError("INVALID_REVOKE_RECEIPT", "本机边界未返回匹配的撤销回执");
            return { revoked_at: requireIsoDate(body.revoked_at, "revoked_at") };
        },
    };
}

export class HandoffClientError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
    }
}

function parseHealth(value: unknown): { enabled: boolean; proposal_handoff_enabled: boolean; external_account_connected: boolean } {
    const body = requireRecord(value, "health");
    if (body.ok !== true || body.feature !== "film.chatgpt_app" || body.public_listener !== false) throw new HandoffClientError("INVALID_HEALTH_RECEIPT", "本机端口不是可验证的 FilmOS ChatGPT 边界");
    return {
        enabled: body.enabled === true,
        proposal_handoff_enabled: body.proposal_handoff_enabled === true,
        external_account_connected: body.external_account_connected === true,
    };
}

function parseStatus(value: unknown, health: ReturnType<typeof parseHealth>, expectedProjectId: string): ChatGPTHandoffStatus {
    const body = requireRecord(value, "handoff status");
    const connection = body.connection as ChatGPTConnectionState;
    if (!new Set<ChatGPTConnectionState>(["connected", "disconnected", "unavailable", "disabled"]).has(connection)) throw new HandoffClientError("INVALID_STATUS_RECEIPT", "本机边界返回了未知连接状态");
    if (typeof body.local_mcp_ready !== "boolean") throw new HandoffClientError("INVALID_STATUS_RECEIPT", "本机边界缺少 local_mcp_ready 回执");
    if (typeof body.external_account_connected !== "boolean" || body.external_account_connected !== health.external_account_connected) throw new HandoffClientError("INVALID_STATUS_RECEIPT", "本机状态与 health 的外部连接回执矛盾");
    const authorizedProject = body.authorized_project === null ? null : parseAuthorizedProject(body.authorized_project);
    if (authorizedProject && authorizedProject.project_id !== expectedProjectId) throw new HandoffClientError("PROJECT_SCOPE_DENIED", "本机状态回执不属于当前 Host 项目");
    return {
        connection,
        local_mcp_ready: body.local_mcp_ready,
        external_account_connected: health.external_account_connected,
        authorized_project: authorizedProject,
        last_read_at: body.last_read_at === null ? null : requireIsoDate(body.last_read_at, "last_read_at"),
        last_context_snapshot: body.last_context_snapshot === null ? null : parseSnapshot(body.last_context_snapshot),
        proposal_handoff_enabled: health.proposal_handoff_enabled && body.proposal_handoff_enabled === true,
        status_code: typeof body.status_code === "string" ? body.status_code : connection.toUpperCase(),
    };
}

function parseAuthorizedProject(value: unknown): ChatGPTAuthorizedProject {
    const body = requireRecord(value, "authorized_project");
    return {
        project_id: requireString(body.project_id, "project_id"),
        ...(typeof body.project_name === "string" && body.project_name.trim() ? { project_name: body.project_name } : {}),
        grant_id: requireString(body.grant_id, "grant_id"),
        expires_at: requireIsoDate(body.expires_at, "expires_at"),
    };
}

function parseSnapshot(value: unknown): ContextSnapshotSummary {
    const body = requireRecord(value, "last_context_snapshot");
    const uri = body.uri === null ? null : requireString(body.uri, "uri");
    if (uri !== null && !uri.startsWith("filmos://")) throw new HandoffClientError("INVALID_STATUS_RECEIPT", "Context Snapshot uri 不是 FilmOS 稳定 URI");
    const version = body.version === null ? null : body.version;
    if (version !== null && (!Number.isSafeInteger(version) || (version as number) < 1)) throw new HandoffClientError("INVALID_STATUS_RECEIPT", "Context Snapshot version 必须是正整数");
    const stateHash = body.state_hash === null ? null : requireString(body.state_hash, "state_hash");
    if (stateHash !== null && !/^[0-9a-f]{64}$/.test(stateHash)) throw new HandoffClientError("INVALID_STATUS_RECEIPT", "Context Snapshot state_hash 不是 SHA-256");
    return {
        uri,
        version: version as number | null,
        state_hash: stateHash,
    };
}

function emptyStatus(connection: ChatGPTConnectionState, proposalHandoffEnabled: boolean, statusCode: string, localMcpReady = false): ChatGPTHandoffStatus {
    return {
        connection,
        local_mcp_ready: localMcpReady,
        external_account_connected: false,
        authorized_project: null,
        last_read_at: null,
        last_context_snapshot: null,
        proposal_handoff_enabled: proposalHandoffEnabled,
        status_code: statusCode,
    };
}

function normalizeLoopbackBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FILM_CHATGPT_HANDOFF_URL;
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase()) || !url.port) {
        throw new Error("VITE_FILM_CHATGPT_HANDOFF_URL 必须是带显式端口的本机 HTTP 地址");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("FilmOS ChatGPT 本机地址不得包含凭据或参数");
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
}

function isExplicitTrue(value: unknown): boolean {
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
    if (!isRecord(value)) throw new HandoffClientError("INVALID_LOCAL_RECEIPT", `${name} 必须是 JSON object`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new HandoffClientError("INVALID_LOCAL_RECEIPT", `${name} 必须是非空字符串`);
    return value;
}

function requireIsoDate(value: unknown, name: string): string {
    const result = requireString(value, name);
    if (!Number.isFinite(new Date(result).getTime())) throw new HandoffClientError("INVALID_LOCAL_RECEIPT", `${name} 必须是 ISO 时间`);
    return result;
}

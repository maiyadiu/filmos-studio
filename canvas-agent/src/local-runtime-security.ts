import crypto from "node:crypto";
import { CanvasToolApiError, CanvasPromptConflictError, ShotImageReadError } from "@filmos/agent-contracts";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { LocalRuntimeScope } from "./local-runtime-contract.js";
import {
    LocalRuntimeSessionError,
    type LocalRuntimeSessionManager,
} from "./local-runtime-session.js";

const PROOF_HEADERS = [
    "x-framefield-runtime-session",
    "x-framefield-runtime-timestamp",
    "x-framefield-runtime-nonce",
    "x-framefield-runtime-proof",
];

export type RuntimeCorsPolicy = {
    methods: readonly string[];
    headers: readonly string[];
    publicInfo?: boolean;
    trustedOrigin?: boolean;
    legacyOrigins?: readonly string[];
    legacyHeaders?: readonly string[];
};

export function exactAuthorityGuard(authority: string): RequestHandler {
    const expected = authority.trim().toLowerCase();
    return (req, res, next) => {
        const host = singleHeader(req, "host");
        if (!host || host.toLowerCase() !== expected) {
            res.status(421).json({ ok: false, code: "authority_invalid", message: "本机运行时地址无效" });
            return;
        }
        next();
    };
}

export function noStore(_req: Request, res: Response, next: NextFunction) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    next();
}

export function runtimeCors(
    policies: ReadonlyMap<string, RuntimeCorsPolicy>,
    sessions: LocalRuntimeSessionManager,
): RequestHandler {
    return (req, res, next) => {
        const policy = findCorsPolicy(policies, req.path);
        const origin = safeOrigin(singleHeader(req, "origin"));
        if (req.method === "OPTIONS") {
            const trusted = Boolean(origin && sessions.isTrustedOrigin(origin));
            const legacy = Boolean(origin && policy?.legacyOrigins?.includes(origin));
            if (!policy || !origin || (!policy.publicInfo && !trusted && !legacy)) {
                res.status(403).end();
                return;
            }
            const requestedMethod = singleHeader(req, "access-control-request-method")?.toUpperCase();
            const requestedHeaders = parseRequestedHeaders(singleHeader(req, "access-control-request-headers"));
            const allowedHeaders = trusted || policy.publicInfo
                ? policy.headers
                : policy.legacyHeaders ?? [];
            if (!requestedMethod
                || !policy.methods.includes(requestedMethod)
                || requestedHeaders.some((header) => !allowedHeaders.includes(header))) {
                res.status(403).end();
                return;
            }
            setCorsHeaders(res, origin);
            res.setHeader("Access-Control-Allow-Methods", policy.methods.join(","));
            if (allowedHeaders.length) {
                res.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(","));
            }
            if (singleHeader(req, "access-control-request-private-network") === "true") {
                res.setHeader("Access-Control-Allow-Private-Network", "true");
            }
            res.status(204).end();
            return;
        }
        if (policy && origin && (policy.publicInfo
            || sessions.isTrustedOrigin(origin)
            || policy.legacyOrigins?.includes(origin))) {
            setCorsHeaders(res, origin);
        }
        next();
    };
}

export function trustedOriginGuard(sessions: LocalRuntimeSessionManager): RequestHandler {
    return (req, res, next) => {
        const origin = safeOrigin(singleHeader(req, "origin"));
        if (!origin || !sessions.isTrustedOrigin(origin)) {
            res.removeHeader("Access-Control-Allow-Origin");
            res.status(403).json({ ok: false, code: "origin_not_trusted", message: "来源未获本机授权" });
            return;
        }
        next();
    };
}

export function signedRuntimeGuard(
    sessions: LocalRuntimeSessionManager,
    scope: LocalRuntimeScope,
    options: { queryKeys?: readonly string[] } = {},
): RequestHandler {
    return (req, res, next) => {
        try {
            const origin = requiredOrigin(req);
            const pathAndQuery = canonicalRequestTarget(req, options.queryKeys);
            if (req.method !== "GET" && !isStrictJson(req)) {
                throw new LocalRuntimeSessionError("content_type_invalid", "请求必须使用 JSON", 415);
            }
            const sessionId = requiredHeader(req, "x-framefield-runtime-session");
            const timestampValue = requiredHeader(req, "x-framefield-runtime-timestamp");
            const requestNonce = requiredHeader(req, "x-framefield-runtime-nonce");
            const proof = requiredHeader(req, "x-framefield-runtime-proof");
            const timestamp = Number(timestampValue);
            const lastEventId = singleHeader(req, "last-event-id") ?? null;
            const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            const session = sessions.verifyRequest({
                sessionId,
                origin,
                method: req.method,
                pathAndQuery,
                body,
                lastEventId,
                requestNonce,
                timestamp,
                proof,
                scope,
            });
            // Keep the public session contract free of origin while exposing the
            // already verified origin to module handlers that scope local data.
            res.locals.runtimeSession = { ...session, origin, runtimeInstanceId: sessions.runtimeInstanceId };
            next();
        } catch (error) {
            next(error);
        }
    };
}

export function legacyOrSignedRuntimeGuard(
    sessions: LocalRuntimeSessionManager,
    scope: LocalRuntimeScope,
    options: {
        queryKeys?: readonly string[];
        masterToken?: string;
        origins?: readonly string[];
    },
): RequestHandler {
    const signed = signedRuntimeGuard(sessions, scope, { queryKeys: options.queryKeys });
    return (req, res, next) => {
        const url = new URL(req.originalUrl || req.url, "http://runtime.invalid");
        const queryTokens = url.searchParams.getAll("token");
        const headerToken = singleHeader(req, "x-canvas-agent-token");
        if (!queryTokens.length && !headerToken) return signed(req, res, next);
        if (queryTokens.length > 1 || (queryTokens.length && headerToken)) {
            res.status(401).json({ ok: false, code: "legacy_auth_invalid", message: "旧版 Canvas 认证无效" });
            return;
        }
        const candidate = queryTokens[0] ?? headerToken ?? "";
        if (!options.masterToken || !constantTimeTextEqual(options.masterToken, candidate)) {
            res.status(401).json({ ok: false, code: "legacy_auth_invalid", message: "旧版 Canvas 认证无效" });
            return;
        }
        const origin = safeOrigin(singleHeader(req, "origin"));
        if (origin && !options.origins?.includes(origin)) {
            res.status(403).json({ ok: false, code: "legacy_origin_invalid", message: "旧版 Canvas 来源无效" });
            return;
        }
        if (req.method !== "GET" && !isStrictJson(req)) {
            res.status(415).json({ ok: false, code: "content_type_invalid", message: "请求必须使用 JSON" });
            return;
        }
        url.searchParams.delete("token");
        const cleanTarget = `${url.pathname}${url.search}`;
        req.url = cleanTarget;
        req.originalUrl = cleanTarget;
        delete req.headers["x-canvas-agent-token"];
        try {
            canonicalRequestTarget(req, options.queryKeys);
        } catch (error) {
            next(error);
            return;
        }
        if (origin) setCorsHeaders(res, origin);
        next();
    };
}

export function strictJsonObject(req: Request) {
    if (!isStrictJson(req) || !Buffer.isBuffer(req.body)) {
        throw new LocalRuntimeSessionError("content_type_invalid", "请求必须使用 JSON", 415);
    }
    try {
        const value = JSON.parse(req.body.toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
    } catch {
        throw new LocalRuntimeSessionError("json_invalid", "JSON 请求无效", 400);
    }
}

export function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
    const allowed = new Set(keys);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
        throw new LocalRuntimeSessionError("request_invalid", "请求字段无效", 400);
    }
}

export function runtimeErrorHandler(
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
) {
    if (res.headersSent) return next(error);
    if (error instanceof LocalRuntimeSessionError) {
        res.status(error.statusCode).json({ ok: false, code: error.code, message: error.message });
        return;
    }
    const publicFailure = publicAgentRuntimeFailure(error);
    if (publicFailure) {
        res.status(publicFailure.statusCode).json({ ok: false, code: publicFailure.code, message: publicFailure.message });
        return;
    }
    res.status(500).json({ ok: false, code: "runtime_internal_error", message: "本机运行时请求失败" });
}

export function publicAgentRuntimeFailure(error: unknown) {
    if (error instanceof ShotImageReadError) return new LocalRuntimeSessionError(error.code, error.message, error.statusCode);
    if (error instanceof CanvasToolApiError) return new LocalRuntimeSessionError(error.code, error.message, error.statusCode);
    if (error instanceof CanvasPromptConflictError) return new LocalRuntimeSessionError(error.code, error.message, 409);
    if (!(error instanceof Error)) return undefined;
    const code = error.message.split(":", 1)[0];
    if (code === "CANVAS_GENERATION_CONFIG_REQUIRED") return new LocalRuntimeSessionError("canvas_generation_config_required", "当前节点的生成配置未就绪，本次生成未提交。请读取节点模型和引擎目录；即梦可在模型菜单刷新，不要改走 API 或恢复会话授权来代替配置检查。批次内此前保存仍须回读。", 409);
    if (code === "CODEX_MODEL_SELECTION_INVALID") return new LocalRuntimeSessionError("agent_model_selection_invalid", "模型配置无效或不属于 Codex 订阅通道，本次任务未启动", 400);
    if (code === "CODEX_MODEL_SELECTION_UNAVAILABLE") return new LocalRuntimeSessionError("agent_model_selection_unavailable", "当前原生 Codex 不支持所选模型与思考强度组合。请刷新模型目录后重新选择；本次任务未启动，不自动换模型", 409);
    if (code === "CODEX_MODEL_CATALOG_UNAVAILABLE") return new LocalRuntimeSessionError("agent_model_catalog_unavailable", "原生 Codex 模型目录暂不可用，无法核验所选配置；不会伪造选项或自动改走 API", 503);
    if (["CODEX_SKILL_CATALOG_UNAVAILABLE", "CODEX_SKILL_NOT_LOADED", "CODEX_SKILL_WORKSPACE_UNAVAILABLE", "CODEX_SKILL_FILE_UNAVAILABLE", "CODEX_SKILL_NAME_INVALID"].includes(code)) return new LocalRuntimeSessionError("agent_skill_unavailable", "所选技能未被原生Codex完整加载，本次模型任务未启动。请检查技能正文及本机Codex版本；不会用技能简介或模型API代替", 409);
    if (["AGENT_SKILL_INVALID", "AGENT_SKILL_INVALID_OR_TOO_LARGE", "AGENT_SKILL_COUNT_EXCEEDED", "AGENT_SKILL_TOO_LARGE"].includes(code)) return new LocalRuntimeSessionError("agent_skill_invalid", "技能正文无效或超限：最多8个技能、每个128KiB。任务未启动，请检查所选技能，草稿保留", 400);
    if (code === "CODEX_SKILL_SESSION_BUSY") return new LocalRuntimeSessionError("agent_skill_session_busy", "当前原生进程仍有技能任务执行中，请待其完成后继续；本次任务未启动", 409);
    if (code === "CODEX_SKILL_CLEANUP_UNCONFIRMED") return new LocalRuntimeSessionError("agent_skill_cleanup_unconfirmed", "技能临时状态清理未确认，已关闭本轮原生进程；已保存内容可能存在，请恢复原会话并回读结果，不要重复建章", 409);
    if (code === "AGENT_TOOL_POSTCONDITION_FAILED" || code === "AGENT_TOOL_POSTCONDITION_REQUIRED") return new LocalRuntimeSessionError("agent_tool_result_unverified", "工具已执行，但结果核验未通过；可能已有保存，不代表零写入。请回读业务版本和原请求回执，暂停依赖步骤，不要盲目重发或重建对象", 409);
    if (code === "CANVAS_CONTEXT_UNAVAILABLE") return new LocalRuntimeSessionError("canvas_context_unavailable", "浏览器画布上下文暂不可用；等待工作台重连后调用 workbench_get_context，再回读实际保存版本；不要自动重发写入", 503);
    if (code === "AGENT_GRANT_NOT_FOUND" || code === "AGENT_GRANT_EXPIRED") return new LocalRuntimeSessionError("agent_grant_refresh_required", "会话授权已失效；恢复当前会话后回读实际结果，不要反复提交旧请求", 409);
    if (code === "AGENT_CONTEXT_RECEIPT_EXPIRED" || code === "AGENT_CONTEXT_RECEIPT_NOT_FOUND") return new LocalRuntimeSessionError("agent_context_refresh_required", "上下文凭据已失效；先调用 workbench_get_context，再回读业务版本后继续；不要重复盲写", 409);
    if (code === "AGENT_CONTEXT_CANVAS_STALE" || code === "AGENT_CONTEXT_FILM_STALE") return new LocalRuntimeSessionError("agent_context_stale", "上下文已变化；先调用 workbench_get_context，核对目标和业务版本后重新安排操作", 409);
    if (code === "AGENT_CONTEXT_SCOPE_MISMATCH" || code === "AGENT_CONTEXT_DOMAIN_PROJECT_MISMATCH") return new LocalRuntimeSessionError("agent_context_scope_mismatch", "当前工作台不属于本会话的授权范围，已停止操作", 409);
    if (["AGENT_CONTEXT_PROJECT_REQUIRED", "AGENT_CONTEXT_CANVAS_REQUIRED", "AGENT_CONTEXT_KIND_INVALID", "AGENT_PROJECT_CONTEXT_HAS_CANVAS_DATA", "AGENT_CONTEXT_WORKSPACE_REQUIRED", "AGENT_CONTEXT_WORKSPACE_PROJECT_MIXED", "AGENT_WORKSPACE_CONTEXT_HAS_PROJECT_DATA"].includes(code)) return new LocalRuntimeSessionError("agent_context_invalid", "当前页面身份或上下文无效，未切换会话。请重新读取真实项目和页面，不能使用旧画布补齐", 400);
    if (code === "AGENT_TOOL_REQUIRES_PROJECT_CONTEXT") return new LocalRuntimeSessionError("agent_project_context_required", "当前是全局工作台页面，没有选中作品；该操作需要进入明确的项目或画布后执行，不会借用上次作品", 409);
    if (code === "AGENT_WORKSPACE_PROFILE_DENIED" || code === "AGENT_GRANT_WORKSPACE_TOOL_DENIED") return new LocalRuntimeSessionError("agent_workspace_scope_denied", "当前全局工作台仅开放 Codex 上下文读取，不启用模型 API、工程执行或作品写入", 403);
    if (code === "AGENT_TOOL_REQUIRES_CANVAS_CONTEXT") return new LocalRuntimeSessionError("agent_canvas_context_required", "当前是项目页面，未绑定活动画布；该操作需要进入真实画布后执行，不会自动创建或使用上一张画布", 409);
    if (code === "AGENT_PROJECT_PAGE_WRITE_BLOCKED") return new LocalRuntimeSessionError("agent_project_write_blocked", "当前项目页面有未保存草稿、内容未就绪或已归档，仅可读取；请先处理页面提示，未执行写入", 409);
    if (code === "AGENT_TURN_CANCELLED") return new LocalRuntimeSessionError("agent_turn_cancelled", "本轮已停止；已保存内容保留，继续前请回读核对", 409);
    if (code === "AGENT_TURN_ALREADY_SUBMITTED") return new LocalRuntimeSessionError("agent_turn_already_submitted", "原轮次已经提交，本次未重复执行；请回读原会话与实际保存结果，不要重发旧请求", 409);
    if (code === "AGENT_SESSION_RECOVERY_REQUIRED") return new LocalRuntimeSessionError("agent_session_recovery_required", "原生会话缺少可恢复的对话身份，本次任务未启动；请检查原会话，不会另建对话或改走 API", 409);
    if (["AGENT_CONFIRMATION_EXPIRED", "AGENT_CONFIRMATION_ALREADY_DECIDED", "AGENT_CONFIRMATION_NOT_APPROVED", "AGENT_CONFIRMATION_NOT_FOUND"].includes(code)) return new LocalRuntimeSessionError("agent_confirmation_unavailable", "该确认已失效或已处理；请回读本轮状态与实际版本，不要重复批准或自动重发保存", 409);
    if (["AGENT_CONFIRMATION_SESSION_MISMATCH", "AGENT_CONFIRMATION_WAITER_SCOPE_MISMATCH", "AGENT_CONFIRMATION_CONTEXT_MISMATCH"].includes(code)) return new LocalRuntimeSessionError("agent_confirmation_scope_mismatch", "该确认不属于当前会话或上下文，未执行操作；请核对原会话", 403);
    if (code === "AGENT_ACTIVE_TURN_MISMATCH") return new LocalRuntimeSessionError("agent_active_turn_mismatch", "请求不属于当前执行轮次，请刷新本轮状态", 409);
    if (code === "AGENT_SESSION_TURN_ALREADY_RUNNING") return new LocalRuntimeSessionError("agent_turn_already_running", "当前会话仍在执行，请等待完成或停止本轮", 409);
    if (code === "BRAIN_CONNECTION_QUOTA_LIMITED") {
        return new LocalRuntimeSessionError("agent_subscription_quota_limited", "所选 AI 大脑的订阅额度已用尽，本次任务尚未发送；额度恢复后可重试，草稿已保留，不会自动切换模型 API", 429);
    }
    if (code === "CODEX_WORKBENCH_CONFIG_UNAVAILABLE" || code === "CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED") {
        return new LocalRuntimeSessionError("agent_tool_scope_unverified", "当前创作会话的工具隔离尚未通过核验，任务未启动；请检查本机运行时配置，不要改用其它项目或连接继续写入", 409);
    }
    if (code === "BRAIN_CONNECTION_UNAVAILABLE" || code === "BRAIN_CONNECTION_NEEDS_AUTH" || code === "BRAIN_CONNECTION_ERROR") {
        return new LocalRuntimeSessionError("agent_profile_not_ready", "所选 AI 大脑尚未连接，请检查对应连接与授权", 409);
    }
    if (code === "CHATGPT_HOST_INVALID_LIVE_CONTEXT" || code === "CHATGPT_HOST_PAYLOAD_INVALID") {
        return new LocalRuntimeSessionError("chatgpt_host_context_invalid", "ChatGPT Host 已连接，但当前工作台上下文未通过安全合同校验", 409);
    }
    if (/^(?:CHATGPT_HOST|CHATGPT_DESKTOP|CHATGPT_CONNECTION)_/.test(code)) {
        return new LocalRuntimeSessionError("chatgpt_host_not_ready", "ChatGPT Host 尚未就绪，请重新连接 Secure Tunnel 并授权当前项目", 409);
    }
    return undefined;
}

export function protectedCorsHeaders(method: "GET" | "POST", lastEventId = false) {
    return [
        ...(method === "POST" ? ["content-type"] : []),
        ...PROOF_HEADERS,
        ...(lastEventId ? ["last-event-id"] : []),
    ];
}

function setCorsHeaders(res: Response, origin: string) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
}

function findCorsPolicy(policies: ReadonlyMap<string, RuntimeCorsPolicy>, path: string) {
    const exact = policies.get(path);
    if (exact) return exact;
    for (const [pattern, policy] of policies) {
        if (!pattern.includes(":")) continue;
        const expected = pattern.split("/");
        const actual = path.split("/");
        if (expected.length !== actual.length) continue;
        if (expected.every((segment, index) => (
            segment.startsWith(":") ? /^[A-Za-z0-9._-]{1,160}$/.test(actual[index]) : segment === actual[index]
        ))) return policy;
    }
    return undefined;
}

function parseRequestedHeaders(value: string | undefined) {
    if (!value) return [];
    return value.split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
}

function isStrictJson(req: Request) {
    const value = singleHeader(req, "content-type")?.toLowerCase() ?? "";
    return /^application\/json(?:;\s*charset=utf-8)?$/.test(value);
}

function canonicalRequestTarget(req: Request, allowedQueryKeys: readonly string[] = []) {
    const target = req.originalUrl || req.url;
    const separator = target.indexOf("?");
    const pathname = separator < 0 ? target : target.slice(0, separator);
    if (!target.startsWith("/")
        || target.includes("#")
        || target.includes("\\")
        || /%(?:2f|5c)/i.test(target)
        || /\/(?:\.|%2e)(?:\/|$)/i.test(target)
        || /\/(?:\.\.|%2e%2e)(?:\/|$)/i.test(target)) {
        throw new LocalRuntimeSessionError("request_target_invalid", "请求路径无效", 400);
    }
    try {
        if (decodeURI(pathname) !== pathname) {
            throw new LocalRuntimeSessionError("request_target_invalid", "请求路径必须规范编码", 400);
        }
    } catch (error) {
        if (error instanceof LocalRuntimeSessionError) throw error;
        throw new LocalRuntimeSessionError("request_target_invalid", "请求路径无效", 400);
    }
    const url = new URL(target, "http://runtime.invalid");
    const allowed = new Set(allowedQueryKeys);
    const entries: Array<[string, string]> = [];
    for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        if (!allowed.has(key) || values.length !== 1 || !values[0] || values[0].length > 512) {
            throw new LocalRuntimeSessionError("request_target_invalid", "请求查询参数无效", 400);
        }
        entries.push([key, values[0]]);
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    const canonicalQuery = entries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
    const canonical = `${pathname}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    if (canonical !== target) {
        throw new LocalRuntimeSessionError("request_target_invalid", "请求路径必须规范编码", 400);
    }
    return canonical;
}

function requiredOrigin(req: Request) {
    const origin = safeOrigin(singleHeader(req, "origin"));
    if (!origin) throw new LocalRuntimeSessionError("origin_invalid", "来源无效", 403);
    return origin;
}

function safeOrigin(value: string | undefined) {
    if (!value || value === "null" || value.includes(",")) return undefined;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)
            || url.username
            || url.password
            || url.pathname !== "/"
            || url.search
            || url.hash
            || url.origin !== value) return undefined;
        return url.origin;
    } catch {
        return undefined;
    }
}

function requiredHeader(req: Request, name: string) {
    const value = singleHeader(req, name);
    if (!value) throw new LocalRuntimeSessionError("request_proof_missing", "请求签名缺失", 401);
    return value;
}

function singleHeader(req: Request, name: string) {
    const value = req.headers[name];
    return typeof value === "string" ? value : undefined;
}

function constantTimeTextEqual(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

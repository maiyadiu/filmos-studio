import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
    archiveCodexThread,
    listCodexThreads,
    logoutCodexAccount,
    readCodexAccountStatus,
    readCodexThread,
    resumeCodexThread,
    runClaudeTurn,
    runCodexTurn,
    startCodexThread,
    startCodexChatGPTLogin,
    summarizeCodexThread,
    verifyCodexThreadWorkspace,
    withAgentPrompt,
} from "../agents.js";
import { CanvasSession } from "../canvas-session.js";
import {
    ensureCanvasWorkspace,
    updateCanvasWorkspace,
    type LocalRuntimeConfig,
} from "../config.js";
import type { LocalRuntimeModule, LocalRuntimeProtectedRoute } from "../local-runtime.js";
import type { AgentAttachment } from "../types.js";
import type { AgentPermissionGrant } from "../brains/contracts.js";
import { AgentPermissionGrantStore } from "../brains/permission-grants.js";
import { CodexApprovalCoordinator } from "../brains/codex-approval-coordinator.js";
import { toolNames } from "../schemas.js";
import { filmToolNames } from "../film/contracts.js";

export type CanvasAgentSession = Pick<
    CanvasSession,
    "health" | "workbenchContext" | "openEvents" | "updateState" | "resolveResult" | "emitAll" | "callTool" | "closeRuntimeSession" | "dispose"
>;

export function createCanvasAgentHttpModule(
    config: LocalRuntimeConfig,
    session: CanvasAgentSession = new CanvasSession(),
): LocalRuntimeModule {
    const emit = (type: string, payload: unknown) => session.emitAll(type, payload);
    const permissionGrants = new AgentPermissionGrantStore();
    const approvals = new CodexApprovalCoordinator(undefined, emit);
    const grantsByCanvas = new Map<string, AgentPermissionGrant>();
    const grantForCanvas = (canvasId: string) => {
        const current = grantsByCanvas.get(canvasId);
        if (current && Date.parse(current.expiresAt) > Date.now()) return current;
        if (current) permissionGrants.revoke(current.id);
        const grant = permissionGrants.issue({
            sessionId: `codex-${canvasId}`,
            connectionId: "codex.subscription",
            actorId: config.ownerId || "local-owner",
            projectId: canvasId,
            toolSurface: "workbench_operator",
            allowedTools: [...toolNames, ...filmToolNames],
        });
        grantsByCanvas.set(canvasId, grant);
        return grant;
    };
    const routes: LocalRuntimeProtectedRoute[] = [
        canvasRoute("GET", "/events", (req, res) => {
            session.openEvents(
                new URL(req.originalUrl || req.url, config.url),
                res,
                runtimeSessionId(res),
            );
        }, { queryKeys: ["clientId"], lastEventId: true }),
        canvasRoute("POST", "/canvas/state", (req, res) => {
            const result = session.updateState(jsonBody(req), queryValue(req, "clientId") || undefined);
            if (!result) {
                res.json({ ok: true });
                return;
            }
            if (result && !result.accepted) {
                res.status(409).json({ ok: false, ...result });
                return;
            }
            res.json({ ok: true, ...result });
        }, { queryKeys: ["clientId"] }),
        canvasRoute("POST", "/canvas/result", (req, res) => {
            session.resolveResult(jsonBody(req) as { requestId?: string; error?: string; result?: unknown });
            res.json({ ok: true });
        }, { queryKeys: ["clientId"] }),
        canvasRoute("POST", "/api/tools", async (req, res) => {
            const body = jsonRecord(req);
            validateAgentGrantHeaders(req, permissionGrants, String(body.name || ""));
            res.json({ ok: true, result: await session.callTool(body.name, body.input || {}) });
        }),
        canvasRoute("GET", "/agent/context", (_req, res) => {
            res.json({ ok: true, context: session.workbenchContext() });
        }),
        canvasRoute("GET", "/agent/codex/workspace", (req, res) => {
            const workspace = ensureCanvasWorkspace(config, queryValue(req, "canvasId"));
            res.json({ ok: true, workspace });
        }, { queryKeys: ["canvasId"] }),
        canvasRoute("GET", "/agent/codex/account", async (_req, res) => {
            res.json({ ok: true, ...(await readCodexAccountStatus()) });
        }),
        canvasRoute("POST", "/agent/codex/account/login", async (_req, res) => {
            res.json({ ok: true, login: await startCodexChatGPTLogin() });
        }),
        canvasRoute("POST", "/agent/codex/account/logout", async (_req, res) => {
            await logoutCodexAccount();
            res.json({ ok: true });
        }),
        canvasRoute("GET", "/agent/codex/threads", async (req, res) => {
            const workspace = ensureCanvasWorkspace(config, queryValue(req, "canvasId"));
            const result = await listCodexThreads(emit, {
                cwd: workspace.workspacePath,
                searchTerm: queryValue(req, "searchTerm"),
            });
            res.json({ ok: true, workspace, ...result });
        }, { queryKeys: ["canvasId", "searchTerm"] }),
        canvasRoute("POST", "/agent/codex/threads/new", async (req, res) => {
            const body = jsonRecord(req);
            const workspace = ensureCanvasWorkspace(config, String(body.canvasId || ""));
            const grant = grantForCanvas(workspace.canvasId);
            const thread = await startCodexThread(emit, workspace.workspacePath, codexOptions(grant, approvals, session));
            const activeThreadId = String((thread as Record<string, unknown>).id || "");
            updateCanvasWorkspace(config, workspace.canvasId, { activeThreadId });
            res.json({
                ok: true,
                workspace: { ...workspace, activeThreadId },
                thread: summarizeCodexThread(thread),
                messages: [],
            });
        }),
        canvasRoute("GET", "/agent/codex/threads/:threadId", async (req, res) => {
            const workspace = ensureCanvasWorkspace(config, queryValue(req, "canvasId"));
            const threadId = routeParam(req.params.threadId);
            res.json({
                ok: true,
                workspace,
                ...(await readCodexThread(emit, threadId, workspace.workspacePath)),
            });
        }, { queryKeys: ["canvasId"] }),
        canvasRoute("POST", "/agent/codex/threads/:threadId/resume", async (req, res) => {
            const body = jsonRecord(req);
            const workspace = ensureCanvasWorkspace(config, String(body.canvasId || ""));
            const threadId = routeParam(req.params.threadId);
            const grant = grantForCanvas(workspace.canvasId);
            const result = await resumeCodexThread(emit, threadId, workspace.workspacePath, codexOptions(grant, approvals, session));
            updateCanvasWorkspace(config, workspace.canvasId, { activeThreadId: threadId });
            res.json({
                ok: true,
                workspace: { ...workspace, activeThreadId: threadId },
                ...result,
            });
        }),
        canvasRoute("POST", "/agent/codex/threads/:threadId/delete", async (req, res) => {
            const body = jsonRecord(req);
            const workspace = ensureCanvasWorkspace(config, String(body.canvasId || ""));
            const threadId = routeParam(req.params.threadId);
            await archiveCodexThread(emit, threadId, workspace.workspacePath);
            if (workspace.activeThreadId === threadId) {
                updateCanvasWorkspace(config, workspace.canvasId, { activeThreadId: undefined });
            }
            res.json({ ok: true });
        }),
        canvasRoute("POST", "/agent/codex/turn", (req, res) => {
            const body = jsonRecord(req);
            const attachments = Array.isArray(body.attachments)
                ? body.attachments as AgentAttachment[]
                : [];
            const skills = parseAgentSkills(body.skills);
            const workspace = ensureCanvasWorkspace(config, String(body.canvasId || ""));
            const grant = grantForCanvas(workspace.canvasId);
            let threadId = String(body.threadId || workspace.activeThreadId || "");
            void (async () => {
                if (!threadId) {
                    const thread = await startCodexThread(emit, workspace.workspacePath, codexOptions(grant, approvals, session));
                    threadId = String((thread as Record<string, unknown>).id || "");
                    updateCanvasWorkspace(config, workspace.canvasId, { activeThreadId: threadId });
                } else if (threadId !== workspace.activeThreadId) {
                    await verifyCodexThreadWorkspace(emit, threadId, workspace.workspacePath);
                    updateCanvasWorkspace(config, workspace.canvasId, { activeThreadId: threadId });
                }
                void runCodexTurn(
                    withAgentPrompt(String(body.prompt || "")),
                    emit,
                    attachments,
                    {
                        skills,
                        sessionId: grant.sessionId,
                        grant,
                        handleServerRequest: (request) => approvals.request({ sessionId: grant.sessionId, request, contextReceiptId: liveContextReceipt(session) }),
                        threadId,
                        cwd: workspace.workspacePath,
                        onThreadId: (nextThreadId) => updateCanvasWorkspace(
                            config,
                            workspace.canvasId,
                            { activeThreadId: nextThreadId },
                        ),
                    },
                );
                if (!res.headersSent) res.json({ ok: true, threadId });
            })().catch((error) => {
                if (!res.headersSent) res.status(500).json({ ok: false, error: publicCanvasError(error) });
            });
        }),
        canvasRoute("POST", "/agent/claude/turn", (req, res) => {
            const body = jsonRecord(req);
            runClaudeTurn(withAgentPrompt(String(body.prompt || "")), emit);
            res.json({ ok: true });
        }),
        canvasRoute("POST", "/agent/confirmations/:confirmationId/decision", (req, res) => {
            const body = jsonRecord(req);
            const confirmation = approvals.decide({
                confirmationId: routeParam(req.params.confirmationId),
                sessionId: String(body.sessionId || ""),
                actorId: String(body.actorId || config.ownerId || "local-owner"),
                approved: body.approved === true,
                ...(body.content && typeof body.content === "object" && !Array.isArray(body.content) ? { content: body.content as Record<string, unknown> } : {}),
            });
            res.json({ ok: true, confirmation });
        }),
    ];

    return {
        descriptor: {
            id: "canvas-agent",
            displayName: "Canvas Agent",
            apiVersion: 1,
            scopes: ["canvas:connect"],
        },
        routes,
        onRuntimeSessionRevoked: (sessionId) => session.closeRuntimeSession(sessionId),
        publicHealth: () => {
            const { ok: _ok, ...health } = session.health();
            return health;
        },
        dispose: () => {
            for (const grant of grantsByCanvas.values()) permissionGrants.revoke(grant.id);
            grantsByCanvas.clear();
            approvals.dispose();
            return session.dispose();
        },
    };
}

function codexOptions(grant: AgentPermissionGrant, approvals: CodexApprovalCoordinator, session: CanvasAgentSession) {
    return {
        sessionId: grant.sessionId,
        grant,
        handleServerRequest: (request: Parameters<CodexApprovalCoordinator["request"]>[0]["request"]) => approvals.request({
            sessionId: grant.sessionId,
            request,
            contextReceiptId: liveContextReceipt(session),
        }),
    };
}

function liveContextReceipt(session: CanvasAgentSession) {
    const context = session.workbenchContext() as Record<string, unknown>;
    return `workbench:${String(context.canvasStateHash || context.stateHash || "unavailable")}:${String(context.canvasRevision || context.revision || 0)}`;
}

function validateAgentGrantHeaders(req: Request, grants: AgentPermissionGrantStore, toolName: string) {
    const grantId = header(req, "x-filmos-agent-grant-id");
    if (!grantId) return;
    grants.validate(grantId, {
        sessionId: requiredHeader(req, "x-filmos-agent-session-id"),
        connectionId: requiredHeader(req, "x-filmos-agent-connection-id"),
        projectId: requiredHeader(req, "x-filmos-agent-project-id"),
        nonce: requiredHeader(req, "x-filmos-agent-grant-nonce"),
        toolName,
    });
}

function header(req: Request, name: string) {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function requiredHeader(req: Request, name: string) {
    const value = header(req, name);
    if (!value) throw new Error(`AGENT_GRANT_HEADER_REQUIRED:${name}`);
    return value;
}

function runtimeSessionId(res: Response) {
    const value = (res.locals.runtimeSession as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof value === "string" && value ? value : undefined;
}

function canvasRoute(
    method: "GET" | "POST",
    path: string,
    handler: (req: Request, res: Response) => void | Promise<void>,
    options: { queryKeys?: readonly string[]; lastEventId?: boolean } = {},
): LocalRuntimeProtectedRoute {
    return {
        method,
        path,
        scope: "canvas:connect",
        handler: route(handler),
        legacy: true,
        ...options,
    };
}

function route(handler: (req: Request, res: Response) => void | Promise<void>): RequestHandler {
    return (req, res, next) => void Promise.resolve(handler(req, res)).catch(next);
}

function jsonBody(req: Request) {
    if (!Buffer.isBuffer(req.body)) throw new Error("Canvas request body is invalid");
    return JSON.parse(req.body.toString("utf8")) as unknown;
}

function jsonRecord(req: Request) {
    const value = jsonBody(req);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Canvas request body is invalid");
    }
    return value as Record<string, unknown>;
}

export function parseAgentSkills(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const input = item as Record<string, unknown>;
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
        const instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 24_000) : "";
        if (!name || !instruction) return [];
        return [{
            ...(typeof input.skillId === "string" ? { skillId: input.skillId.trim().slice(0, 120) } : {}),
            name,
            ...(typeof input.description === "string" ? { description: input.description.trim().slice(0, 500) } : {}),
            instruction,
        }];
    });
}

function queryValue(req: Request, key: string) {
    const value = req.query[key];
    return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] || "" : value;
}

function publicCanvasError(_error: unknown) {
    return "Canvas Agent request failed";
}

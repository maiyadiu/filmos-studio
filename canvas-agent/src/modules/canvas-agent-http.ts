import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { parseCodexModelSelection, type CodexModelOption } from "@filmos/agent-contracts";

import {
    archiveCodexThread,
    codexProcessManager,
    listCodexThreads,
    logoutCodexAccount,
    readCodexAccountStatus,
    readCodexThread,
    resumeCodexThread,
    runClaudeTurn,
    runCodexTurn,
    writeAttachmentFiles,
    removeAttachmentFiles,
    writeSkillFiles,
    removeSkillDirectories,
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
import type { AgentPermissionGrant, CreateBrainSessionInput } from "../brains/contracts.js";
import { AgentPermissionGrantStore } from "../brains/permission-grants.js";
import { CodexApprovalCoordinator } from "../brains/codex-approval-coordinator.js";
import { CanonicalAgentToolManifest } from "../brains/tool-manifest.js";
import { GenericAgentRuntime } from "../brains/generic-agent-runtime.js";
import type { WorkbenchContextSnapshot } from "../brains/context-broker.js";
import { agentRuntimeProfileStatus, assertGenericAgentRuntimeDependencies, resolveAgentFeatureFlags } from "../brains/feature-flags.js";
import type { BrainSessionStore } from "../brains/session-store.js";
import type { BrowserRuntimeTransport } from "../brains/browser-runtime-port.js";
import { RuntimeAccountBindings, type RuntimeAccountBinding } from "../runtime-account.js";
import { LocalRuntimeSessionError } from "../local-runtime-session.js";
import { SourceMaintenanceWorkspace } from "../brains/source-maintenance.js";
import { SourceMaintenanceTasks } from "../brains/source-maintenance-tasks.js";

export type CanvasAgentSession = Pick<
    CanvasSession,
    "health" | "workbenchContext" | "agentContextSnapshot" | "openEvents" | "updateState" | "resolveResult" | "emitAll" | "callTool" | "closeRuntimeSession" | "dispose"
> & Partial<Pick<CanvasSession, "enableAccountIsolation" | "withAccountScope">>;

export type CanvasAgentHttpModuleOptions = { brainSessionStore?: BrainSessionStore; browserRuntimeTransport?: BrowserRuntimeTransport; accountVerifierFetch?: typeof globalThis.fetch; accountNow?: () => number; codexApprovals?: CodexApprovalCoordinator; persistentAudit?: false; listCodexModels?: () => Promise<CodexModelOption[]>; sourceWorkspace?: () => SourceMaintenanceWorkspace | undefined; codexAdapter?: import("../brains/contracts.js").AgentRuntimeAdapter };

export function createCanvasAgentHttpModule(
    config: LocalRuntimeConfig,
    session: CanvasAgentSession = new CanvasSession(),
    options: CanvasAgentHttpModuleOptions = {},
): LocalRuntimeModule {
    const accounts = new RuntimeAccountBindings({ ownerId: config.ownerId, trustedOrigins: config.trustedWebOrigins, fetch: options.accountVerifierFetch, now: options.accountNow });
    const sourceWorkspace = options.sourceWorkspace ?? (() => SourceMaintenanceWorkspace.fromEnvironment());
    const sourceTasks = new SourceMaintenanceTasks(sourceWorkspace, () => generic!.store);
    const requireSourceDeveloper = (res: Response) => {
        if (accounts.require(res.locals.runtimeSession).authMode !== "desktop_local") {
            throw new LocalRuntimeSessionError("agent_source_developer_required", "源码维护仅对已验证的本机开发者开放；普通创作权限不变", 403);
        }
    };
    const emit = (type: string, payload: unknown) => session.emitAll(type, payload);
    const permissionGrants = new AgentPermissionGrantStore();
    const canonicalTools = new CanonicalAgentToolManifest();
    const approvals = options.codexApprovals ?? new CodexApprovalCoordinator(undefined, emit);
    const agentFeatureFlags = resolveAgentFeatureFlags(config.agentFeatureFlags);
    assertGenericAgentRuntimeDependencies(agentFeatureFlags);
    if (agentFeatureFlags["film.agent_generic_runtime"]) {
        if (!session.enableAccountIsolation || !session.withAccountScope) throw new Error("ACCOUNT_CANVAS_SCOPE_REQUIRED");
        session.enableAccountIsolation();
    }
    const generic: GenericAgentRuntime | undefined = agentFeatureFlags["film.agent_generic_runtime"] ? new GenericAgentRuntime(
            config,
            emit,
            () => session.agentContextSnapshot() as WorkbenchContextSnapshot,
            async ({ sessionId, turnId, request }) => {
                const owned = await generic!.store.getSession(sessionId);
                if (!owned?.accountScopeId) throw accountSessionError();
                return withRuntimeAccount(session, owned.accountScopeId, () => approvals.request({ sessionId, turnId, request, contextReceiptId: liveContextReceipt(session) }));
            },
            {
                featureFlags: agentFeatureFlags,
                grants: permissionGrants,
                tools: canonicalTools,
                browserRuntime: options.browserRuntimeTransport ?? requireBrowserRuntimeTransport(session),
                canvasToolExecutor: session,
                nativeConfirmations: approvals,
                sourceMaintenance: sourceTasks,
                codexAdapter: options.codexAdapter,
                ...(options.persistentAudit === false ? { persistentAudit: false } : {}),
                ...(options.brainSessionStore ? { store: options.brainSessionStore } : {}),
            },
        ) : undefined;
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
            allowedTools: canonicalTools.names("workbench_operator"),
        });
        grantsByCanvas.set(canvasId, grant);
        return grant;
    };
    const routes: LocalRuntimeProtectedRoute[] = [
        ...(generic ? [
        agentRoute("POST", "/agent/account/challenge", "agent:sessions:manage", (req, res) => {
            if (Object.keys(accountBody(req)).length) throw new LocalRuntimeSessionError("agent_account_body_invalid", "账号挑战请求必须为空对象", 400);
            res.json({ ok: true, ...accounts.challenge(res.locals.runtimeSession) });
        }),
        agentRoute("POST", "/agent/account/bind", "agent:sessions:manage", async (req, res) => {
            const body = accountBody(req);
            if (Object.keys(body).length !== 1 || !("proof" in body)) throw new LocalRuntimeSessionError("agent_account_body_invalid", "账号绑定请求只能包含证明", 400);
            res.json({ ok: true, binding: await accounts.bind(res.locals.runtimeSession, body.proof) });
        }),
        agentRoute("GET", "/agent/account", "agent:sessions:read", (_req, res) => {
            res.json({ ok: true, binding: accounts.require(res.locals.runtimeSession) });
        }),
        ] : []),
        canvasRoute("GET", "/events", (req, res) => {
            session.openEvents(
                new URL(req.originalUrl || req.url, config.url),
                res,
                runtimeSessionId(res),
                generic ? () => accounts.require(res.locals.runtimeSession).accountScopeId === accountBinding(res).accountScopeId : undefined,
            );
        }, { queryKeys: ["clientId"], lastEventId: true }),
        canvasRoute("POST", "/canvas/state", (req, res) => {
            const result = session.updateState(jsonBody(req), queryValue(req, "clientId") || undefined, config.ownerId, runtimeSessionId(res));
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
            session.resolveResult(jsonBody(req) as Parameters<CanvasSession["resolveResult"]>[0], queryValue(req, "clientId") || undefined, runtimeSessionId(res));
            res.json({ ok: true });
        }, { queryKeys: ["clientId"] }),
        canvasRoute("POST", "/api/tools", async (req, res) => {
            const body = jsonRecord(req);
            const toolName = requiredBodyString(body, "name");
            const grant = validateAgentGrantHeaders(req, permissionGrants, toolName, generic !== undefined && process.env.FILMOS_AGENT_GATEWAY_ENABLED === "true");
            if (generic && process.env.FILMOS_AGENT_GATEWAY_ENABLED === "true") {
                if (!grant) throw new Error("AGENT_GRANT_REQUIRED");
                const owned = await generic.store.getSession(grant.sessionId);
                if (!owned?.accountScopeId) throw accountSessionError();
                if (runtimeSessionId(res) && accounts.require(res.locals.runtimeSession).accountScopeId !== owned.accountScopeId) throw accountSessionError();
                const outcome = await withRuntimeAccount(session, owned.accountScopeId, () => generic.requestTool({
                    sessionId: grant.sessionId, toolName,
                    toolInput: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {},
                }));
                if (outcome.status !== "completed") throw new Error("AGENT_TOOL_OUTCOME_INCOMPLETE");
                res.json({ ok: true, result: outcome.result.output, broker: { requestId: outcome.request.requestId, outcome: outcome.result.outcome } });
                return;
            }
            generic?.instrumentation.legacyDirectExecute();
            const result = toolName === "workbench_get_context"
                ? { ...session.workbenchContext(), contextReceiptId: liveContextReceipt(session) }
                : await session.callTool(toolName, body.input || {});
            res.json({ ok: true, result });
        }),
        canvasRoute("GET", "/agent/context", (_req, res) => {
            res.json({ ok: true, context: session.workbenchContext() });
        }),
        ...(generic ? ([
            ["GET", "/agent/source", "inspect"],
            ["POST", "/agent/source/files", "list"],
            ["POST", "/agent/source/read", "read"],
        ] as const).map(([method, path, operation]) => agentRoute(method, path, "agent:profiles:read", async (req, res) => {
            requireSourceDeveloper(res);
            const workspace = sourceWorkspace();
            if (!workspace) throw new LocalRuntimeSessionError("agent_source_unavailable", "当前不是源码开发运行环境，未开放源码维护", 409);
            const result = operation === "inspect" ? await workspace.inspect()
                : operation === "list" ? await workspace.list(sourceRequestBody(req)) : await workspace.read(sourceRequestBody(req));
            // Git/file inspection yields: revocation or expiry must still prevent
            // source disclosure even if the request began with a valid account.
            requireSourceDeveloper(res);
            res.json({ ok: true, result });
        })) : []),
        ...(generic ? [
            agentRoute("GET", "/agent/sessions/:sessionId/source-task", "agent:sessions:read", async (req, res) => {
                requireSourceDeveloper(res);
                const owned = await generic.store.getSession(routeParam(req.params.sessionId));
                if (!owned) throw accountSessionError();
                requireSourceDeveloper(res);
                res.json({ ok: true, source: sourceTasks.view(owned) });
            }),
            ...(["open", "close", "reconcile"] as const).map(operation => agentRoute("POST", `/agent/sessions/:sessionId/source-task/${operation}`, "agent:sessions:manage", async (req, res) => {
                requireSourceDeveloper(res);
                const principal = res.locals.runtimeSession;
                const owner = accounts.require(principal).accountScopeId;
                const authorize = () => {
                    const current = accounts.require(principal);
                    if (current.authMode !== "desktop_local" || current.accountScopeId !== owner) throw accountSessionError();
                };
                const body = sourceRequestBody(req);
                if (operation !== "open" && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) throw new LocalRuntimeSessionError("agent_source_task_invalid", "结束或核对维护请求必须为空对象", 400);
                const result = await generic.changeSourceTask(routeParam(req.params.sessionId), operation, body, authorize);
                res.json({ ok: true, ...result });
            })),
        ] : []),
        ...(generic ? createGenericAgentRoutes(generic, config, session, emit, options.listCodexModels ?? (async () => (await codexProcessManager.client()).listModels())) : []),
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
            if (generic) throw new Error("LEGACY_AGENT_DIRECT_TURN_DISABLED");
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
        agentOrLegacyRoute(Boolean(generic), "POST", "/agent/confirmations/:confirmationId/decision", "agent:confirmations:decide", async (req, res) => {
            const body = jsonRecord(req);
            const sessionId = requiredBodyString(body, "sessionId");
            // Native app-server and canonical business approvals can share a BrainSession,
            // but only the store that created the confirmation may consume it.
            if (!approvals.owns(routeParam(req.params.confirmationId)) && generic && await generic.store.getSession(sessionId)) {
                const outcome = await generic.decideConfirmation({
                    confirmationId: routeParam(req.params.confirmationId),
                    sessionId,
                    actorId: generic ? config.ownerId! : String(body.actorId || config.ownerId || "local-owner"),
                    approved: body.approved === true,
                });
                res.json({ ok: true, outcome });
                return;
            }
            const confirmation = approvals.decide({
                confirmationId: routeParam(req.params.confirmationId),
                sessionId,
                actorId: generic ? config.ownerId! : String(body.actorId || config.ownerId || "local-owner"),
                approved: body.approved === true,
                ...(body.content && typeof body.content === "object" && !Array.isArray(body.content) ? { content: body.content as Record<string, unknown> } : {}),
            });
            res.json({ ok: true, confirmation });
        }),
        canvasRoute("POST", "/agent/confirmations/:confirmationId/resolve", (req, res) => {
            const body = jsonRecord(req);
            const confirmation = approvals.decide({
                confirmationId: routeParam(req.params.confirmationId),
                sessionId: requiredBodyString(body, "sessionId"),
                actorId: config.ownerId || "local-owner",
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
            scopes: ["canvas:connect", "agent:profiles:read", "agent:sessions:read", "agent:sessions:manage", "agent:turns:run", "agent:confirmations:decide", "agent:tools:execute", "agent:handoff:manage"],
        },
        routes: generic ? routes.map(item => protectAccountRoute(item, accounts, generic, session)) : routes,
        onRuntimeSessionRevoked: (sessionId) => { accounts.revoke(sessionId); session.closeRuntimeSession(sessionId); },
        publicHealth: () => {
            const { ok: _ok, ...health } = session.health();
            const activation = agentRuntimeProfileStatus(agentFeatureFlags);
            return {
                ...health,
                agent_runtime_profile: activation.profileId,
                agent_feature_flag_count: activation.featureFlagCount,
                agent_feature_flags_hash: activation.featureFlagsHash,
                agent_activation_consistent: activation.consistent,
                agent_generic_runtime_enabled: agentFeatureFlags["film.agent_generic_runtime"],
            };
        },
        dispose: () => {
            accounts.dispose();
            for (const grant of grantsByCanvas.values()) permissionGrants.revoke(grant.id);
            grantsByCanvas.clear();
            approvals.dispose();
            return Promise.all([Promise.resolve(session.dispose()), generic?.dispose()]).then(() => undefined);
        },
    };
}

function requireBrowserRuntimeTransport(session: CanvasAgentSession): BrowserRuntimeTransport {
    const candidate = session as CanvasAgentSession & Partial<BrowserRuntimeTransport>;
    if (typeof candidate.hasConnectedBrowser !== "function" || typeof candidate.request !== "function") {
        throw new Error("BROWSER_RUNTIME_TRANSPORT_REQUIRED");
    }
    return {
        hasConnectedBrowser: () => candidate.hasConnectedBrowser!(),
        request: <T>(input: Parameters<BrowserRuntimeTransport["request"]>[0]) => candidate.request!<T>(input),
    };
}

function createGenericAgentRoutes(generic: GenericAgentRuntime, config: LocalRuntimeConfig, session: CanvasAgentSession, emit: (type: string, payload: unknown) => void, listCodexModels: () => Promise<CodexModelOption[]>) {
    return [
        agentRoute("GET", "/agent/models", "agent:profiles:read", async (_req, res) => {
            res.json({ ok: true, models: await listCodexModels() });
        }),
        agentRoute("GET", "/agent/workspace", "agent:profiles:read", async (_req, res) => {
            if (!config.ownerId) throw new Error("AGENT_CONTEXT_WORKSPACE_REQUIRED");
            res.json({ ok: true, workspaceId: config.ownerId });
        }),
        agentRoute("GET", "/agent/connections", "agent:profiles:read", async (_req, res) => {
            res.json({ ok: true, connections: await generic.listConnections(), toolManifest: generic.tools.list() });
        }),
        agentRoute("GET", "/agent/sessions", "agent:sessions:read", async (req, res) => {
            if (queryValue(req, "workspaceId") && (queryValue(req, "workspaceId") !== config.ownerId || queryValue(req, "projectId"))) throw new Error("AGENT_CONTEXT_WORKSPACE_PROJECT_MIXED");
            res.json({ ok: true, sessions: (await generic.store.listSessions({
                accountScopeId: accountBinding(res).accountScopeId,
                ...(queryValue(req, "projectId") ? { projectId: queryValue(req, "projectId") } : {}),
                ...(queryValue(req, "workspaceId") ? { workspaceId: queryValue(req, "workspaceId"), projectId: null } : {}),
                ...(queryValue(req, "brainProfileId") ? { brainProfileId: queryValue(req, "brainProfileId") } : {}),
            })).map(item => generic.sessionView(item)) });
        }, { queryKeys: ["projectId", "workspaceId", "brainProfileId"] }),
        agentRoute("POST", "/agent/sessions", "agent:sessions:manage", async (req, res) => {
            const body = jsonRecord(req);
            const current = session.agentContextSnapshot();
            const binding = accountBinding(res);
            const result = await generic.createSession({ ...trustedCreateSessionInput(body, current, config.ownerId!), accountScopeId: binding.accountScopeId });
            res.json({ ok: true, ...result });
        }),
        agentRoute("GET", "/agent/sessions/:sessionId", "agent:sessions:read", async (req, res) => {
            const item = await generic.store.getSession(routeParam(req.params.sessionId));
            if (!item) {
                res.status(404).json({ ok: false, code: "BRAIN_SESSION_NOT_FOUND" });
                return;
            }
            res.json({ ok: true, session: generic.sessionView(item) });
        }),
        agentRoute("GET", "/agent/sessions/:sessionId/history", "agent:sessions:read", async (req, res) => {
            res.json({ ok: true, ...await generic.readSessionHistory(routeParam(req.params.sessionId)) });
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/resume", "agent:sessions:manage", async (req, res) => {
            assertEmptyBody(req);
            res.json({ ok: true, ...(await generic.resumeSession(routeParam(req.params.sessionId), config.ownerId!)) });
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/context", "agent:sessions:read", async (req, res) => {
            assertEmptyBody(req);
            res.json({ ok: true, ...(await generic.captureContext(routeParam(req.params.sessionId))) });
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/turns", "agent:turns:run", async (req, res) => {
            const body = jsonRecord(req);
            const codexModel = parseCodexModelSelection(body.codexModel);
            const turnId = typeof body.turnId === "string" && body.turnId.trim() ? body.turnId.trim() : randomUUID();
            const attachments = Array.isArray(body.attachments) ? body.attachments as AgentAttachment[] : [];
            const localImagePaths = await writeAttachmentFiles(attachments);
            let preparedSkills: Awaited<ReturnType<typeof writeSkillFiles>> = { directories: [], inputs: [] };
            try {
                preparedSkills = await writeSkillFiles(parseAgentSkills(body.skills));
                const scope = accountBinding(res).accountScopeId;
                const result = await generic.sendTurn(routeParam(req.params.sessionId), { turnId, prompt: requiredBodyString(body, "prompt"), localImagePaths, localSkills: preparedSkills.inputs, ...(codexModel ? { codexModel } : {}), ...(body.scriptCreation !== undefined ? { scriptCreation: body.scriptCreation } : {}) }, (type, payload) => withRuntimeAccount(session, scope, () => emit(type, payload)));
                res.json({ ok: true, ...result });
            } finally {
                await Promise.all([removeAttachmentFiles(localImagePaths), removeSkillDirectories(preparedSkills.directories)]);
            }
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/tools", "agent:tools:execute", async (req, res) => {
            const body = jsonRecord(req);
            const outcome = await generic.requestTool({
                sessionId: routeParam(req.params.sessionId),
                turnId: requiredBodyString(body, "turnId"),
                toolName: requiredBodyString(body, "toolName"),
                toolInput: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {},
                ...(typeof body.ordinaryConfirmationEnabled === "boolean" ? { ordinaryConfirmationEnabled: body.ordinaryConfirmationEnabled } : {}),
            });
            if (outcome.status !== "completed") throw new Error("AGENT_TOOL_OUTCOME_INCOMPLETE");
            res.json({ ok: true, outcome });
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/tool-proposals", "agent:tools:execute", async (req, res) => {
            const body = jsonRecord(req);
            const outcome = await generic.proposeTool({
                sessionId: routeParam(req.params.sessionId),
                turnId: requiredBodyString(body, "turnId"),
                toolName: requiredBodyString(body, "toolName"),
                toolInput: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {},
                ...(typeof body.ordinaryConfirmationEnabled === "boolean" ? { ordinaryConfirmationEnabled: body.ordinaryConfirmationEnabled } : {}),
            });
            res.json({ ok: true, outcome });
        }),
        agentRoute("GET", "/agent/diagnostics", "agent:profiles:read", async (_req, res) => {
            res.json({ ok: true, ...generic.diagnostics() });
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/turns/:turnId/cancel", "agent:turns:run", async (req, res) => {
            assertEmptyBody(req);
            const sessionId = routeParam(req.params.sessionId);
            const item = await generic.store.getSession(sessionId);
            if (!item) {
                res.status(404).json({ ok: false, code: "BRAIN_SESSION_NOT_FOUND" });
                return;
            }
            res.json({ ok: true, ...await generic.cancelTurn(sessionId, routeParam(req.params.turnId)) });
        }),
        agentRoute("POST", "/agent/sessions/:sessionId/close", "agent:sessions:manage", async (req, res) => {
            assertEmptyBody(req);
            res.json({ ok: true, session: await generic.manager.closeSession(routeParam(req.params.sessionId)) });
        }),
    ];
}

function withRuntimeAccount<T>(session: CanvasAgentSession, accountScopeId: string, action: () => T): T {
    if (!session.withAccountScope) throw accountSessionError();
    return session.withAccountScope(accountScopeId, action);
}

function accountBinding(res: Response): RuntimeAccountBinding {
    const binding = res.locals?.runtimeAccount as RuntimeAccountBinding | undefined;
    if (!binding) throw accountSessionError();
    return binding;
}

function accountSessionError() {
    return new LocalRuntimeSessionError("agent_account_session_unavailable", "当前账号没有此会话；原历史保留，未执行请求", 404);
}

function protectAccountRoute(item: LocalRuntimeProtectedRoute, accounts: RuntimeAccountBindings, generic: GenericAgentRuntime, session: CanvasAgentSession): LocalRuntimeProtectedRoute {
    if (item.path === "/api/tools" || item.path === "/agent/account" || item.path.startsWith("/agent/account/")) return item;
    const handler: RequestHandler = (req, res, next) => {
        void (async () => {
            const binding = accounts.require(res.locals.runtimeSession);
            // Generic sessions must not fall through to unscoped legacy history
            // or provider execution, even when the caller has a signed session.
            if (item.path.startsWith("/agent/codex/") && !item.path.startsWith("/agent/codex/account") || item.path === "/agent/claude/turn") {
                throw new LocalRuntimeSessionError("agent_legacy_route_disabled", "当前使用统一 Agent 会话入口；未执行旧入口请求", 409);
            }
            const sessionId = req.params?.sessionId || (item.path.startsWith("/agent/confirmations/") ? requiredBodyString(jsonRecord(req), "sessionId") : undefined);
            if (sessionId) {
                const owned = await generic.store.getSession(routeParam(sessionId));
                if (!owned || owned.accountScopeId !== binding.accountScopeId) throw accountSessionError();
            }
            // Reads above may yield. Expiry/revocation must still block dispatch.
            if (accounts.require(res.locals.runtimeSession).accountScopeId !== binding.accountScopeId) throw accountSessionError();
            res.locals.runtimeAccount = binding;
            withRuntimeAccount(session, binding.accountScopeId, () => item.handler(req, res, next));
        })().catch(next);
    };
    return { ...item, legacy: false, handler };
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

export function validateAgentGrantHeaders(req: Request, grants: AgentPermissionGrantStore, toolName: string, required = false) {
    const grantId = header(req, "x-filmos-agent-grant-id");
    if (!grantId) {
        if (required) throw new Error("AGENT_GRANT_REQUIRED");
        return undefined;
    }
    return grants.validate(grantId, {
        sessionId: requiredHeader(req, "x-filmos-agent-session-id"),
        connectionId: requiredHeader(req, "x-filmos-agent-connection-id"),
        projectId: header(req, "x-filmos-agent-workspace-id") && !header(req, "x-filmos-agent-project-id") ? null : requiredHeader(req, "x-filmos-agent-project-id"),
        ...(header(req, "x-filmos-agent-workspace-id") ? { workspaceId: header(req, "x-filmos-agent-workspace-id") } : {}),
        nonce: requiredHeader(req, "x-filmos-agent-grant-nonce"),
        signature: requiredHeader(req, "x-filmos-agent-grant-signature"),
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
    const value = (res.locals?.runtimeSession as { sessionId?: unknown } | undefined)?.sessionId;
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

function agentRoute(
    method: "GET" | "POST",
    path: string,
    scope: Extract<LocalRuntimeProtectedRoute["scope"], `agent:${string}`>,
    handler: (req: Request, res: Response) => void | Promise<void>,
    options: { queryKeys?: readonly string[]; lastEventId?: boolean } = {},
): LocalRuntimeProtectedRoute {
    return { method, path, scope, handler: route(handler), ...options };
}

function agentOrLegacyRoute(
    generic: boolean,
    method: "GET" | "POST",
    path: string,
    scope: Extract<LocalRuntimeProtectedRoute["scope"], `agent:${string}`>,
    handler: (req: Request, res: Response) => void | Promise<void>,
) {
    return generic ? agentRoute(method, path, scope, handler) : canvasRoute(method, path, handler);
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

function accountBody(req: Request) {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.byteLength > 8192) throw new Error("invalid");
        return jsonRecord(req);
    } catch {
        throw new LocalRuntimeSessionError("agent_account_body_invalid", "账号绑定请求格式无效", 400);
    }
}

function sourceRequestBody(req: Request) {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.byteLength > 4096) throw new Error("invalid");
        return jsonBody(req);
    } catch {
        throw new LocalRuntimeSessionError("agent_source_request_invalid", "源码读取参数无效或超限", 400);
    }
}

function requiredBodyString(body: Record<string, unknown>, key: string) {
    const value = body[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`AGENT_REQUEST_FIELD_REQUIRED:${key}`);
    return value.trim();
}

export function trustedCreateSessionInput(
    body: Record<string, unknown>,
    current: WorkbenchContextSnapshot,
    actorId: string,
): CreateBrainSessionInput {
    return {
        conversationId: requiredBodyString(body, "conversationId"),
        brainProfileId: requiredBodyString(body, "brainProfileId"),
        projectId: current.projectId,
        ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
        ...(current.domainProjectId ? { domainProjectId: current.domainProjectId } : {}),
        canvasId: current.canvasId,
        ...(current.contentUnitId ? { contentUnitId: current.contentUnitId } : {}),
        ...(current.sceneId ? { sceneId: current.sceneId } : {}),
        ...(current.directorUnitId ? { directorUnitId: current.directorUnitId } : {}),
        ...(current.shotId ? { shotId: current.shotId } : {}),
        actorId,
    };
}

function assertEmptyBody(req: Request) {
    const body = jsonRecord(req);
    if (Object.keys(body).length) throw new Error("AGENT_REQUEST_BODY_MUST_BE_EMPTY");
}

export function parseAgentSkills(value: unknown) {
    if (!Array.isArray(value)) return [];
    if (value.length > 8) throw new Error("AGENT_SKILL_COUNT_EXCEEDED");
    return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("AGENT_SKILL_INVALID");
        const input = item as Record<string, unknown>;
        const name = typeof input.name === "string" ? input.name.trim() : "";
        const instruction = typeof input.instruction === "string" ? input.instruction : "";
        if (!name || name.length > 120 || !instruction.trim() || Buffer.byteLength(instruction, "utf8") > 128 * 1024 || (typeof input.skillId === "string" && input.skillId.length > 120)) throw new Error("AGENT_SKILL_INVALID_OR_TOO_LARGE");
        return {
            ...(typeof input.skillId === "string" ? { skillId: input.skillId.trim().slice(0, 120) } : {}),
            name,
            ...(typeof input.description === "string" ? { description: input.description.trim().slice(0, 500) } : {}),
            instruction,
        };
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

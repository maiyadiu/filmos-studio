import { backendModelRuntimeRequired, runBackendToolGenerationTask } from "@/services/api/generation-task";
import { requestToolResponse, type ResponseInputMessage, type ResponseToolCall } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

import { AgentSessionClient } from "./agent-client";
import type { BrowserRuntimeRequest } from "./browser-runtime-bridge";
import { requestDesktopChatGPTHost } from "./desktop-chatgpt-host-bridge";
import { GENERIC_MODEL_API_AGENT_TOOLS } from "./model-api-tool-manifest";
import type { FilmOSDesktopChatGPTHostStatus } from "./workbench-context";

type HandlerDependencies = {
    selectedProfileId: string;
    config: AiConfig;
    isConfigReady(config: AiConfig, model: string): boolean;
    ordinaryConfirmationEnabled: boolean;
    client?: AgentSessionClient;
};

export function createBrowserRuntimeRequestHandler(deps: HandlerDependencies) {
    const client = deps.client ?? new AgentSessionClient();
    return async (request: BrowserRuntimeRequest) => {
        if (request.profileId !== deps.selectedProfileId) throw new Error("BROWSER_RUNTIME_PROFILE_SCOPE_MISMATCH");
        if (request.channel === "chatgpt_host") return await handleChatGPTHost(request);
        if (request.channel !== "model") throw new Error("BROWSER_RUNTIME_CHANNEL_UNSUPPORTED");
        if (request.operation === "probe") {
            const model = deps.config.textModel || deps.config.model;
            return deps.isConfigReady({ ...deps.config, model }, model)
                ? { status: "ready", version: `browser:${request.profileId}` }
                : { status: "unavailable", statusReason: `Profile ${request.profileId} 尚未配置` };
        }
        if (request.operation === "create_session" || request.operation === "resume_session") {
            if (!request.sessionId) throw new Error("BROWSER_RUNTIME_SESSION_REQUIRED");
            return { providerThreadId: `browser:${request.profileId}:${request.sessionId}` };
        }
        if (request.operation === "cancel_turn" || request.operation === "close_session") return { ok: true };
        if (request.operation !== "send_turn" || !request.sessionId || !request.turnId) throw new Error("BROWSER_RUNTIME_TURN_SCOPE_REQUIRED");
        return await runModelTurn(request, deps, client);
    };
}

async function runModelTurn(request: BrowserRuntimeRequest, deps: HandlerDependencies, client: AgentSessionClient) {
    const sessionId = requiredString(request.sessionId, "sessionId");
    const turnId = requiredString(request.turnId, "turnId");
    const prompt = requiredString(request.payload.prompt, "prompt");
    const context = sanitizeModelContext(record(request.payload.context));
    let messages: ResponseInputMessage[] = [
        { role: "system", content: "You are the selected FilmOS Brain Profile. Use only the supplied canonical tools. Read live context before writes; never claim a tool succeeded without its broker result." },
        { role: "user", content: `${prompt}\n\nFilmOS context receipt:\n${JSON.stringify(context)}` },
    ];
    const events: unknown[] = [{ type: "turn.started", sessionId, turnId, at: new Date().toISOString() }];
    let text = "";
    for (let step = 0; step < 4; step += 1) {
        const result = await requestModel(deps.config, messages, prompt);
        text = result.content || text;
        if (!result.toolCalls.length) break;
        const outputs = [];
        for (const call of result.toolCalls) {
            const outcome = await client.requestTool(sessionId, {
                turnId,
                toolName: call.function.name,
                input: parseArguments(call.function.arguments),
                ordinaryConfirmationEnabled: deps.ordinaryConfirmationEnabled,
            });
            outputs.push({ call, output: outcome.outcome.result.output });
        }
        messages = [
            ...messages,
            ...result.toolCalls.map(toolCallMessage),
            ...outputs.map(({ call, output }) => ({ role: "tool" as const, tool_call_id: call.id, content: JSON.stringify(output ?? null) })),
        ];
    }
    events.push({ type: "turn.completed", sessionId, turnId, at: new Date().toISOString() });
    return {
        result: { sessionId, turnId, providerThreadId: `browser:${request.profileId}:${sessionId}`, status: "completed", text: text || "FilmOS 工具流程已完成。" },
        events,
    };
}

async function requestModel(config: AiConfig, messages: ResponseInputMessage[], prompt: string) {
    const requestConfig = { ...config, model: config.textModel || config.model };
    if (backendModelRuntimeRequired(requestConfig)) {
        return await runBackendToolGenerationTask({ prompt, config: requestConfig, messages, tools: [...GENERIC_MODEL_API_AGENT_TOOLS], toolChoice: "auto" });
    }
    return await requestToolResponse(requestConfig, messages, [...GENERIC_MODEL_API_AGENT_TOOLS], "auto");
}

async function handleChatGPTHost(request: BrowserRuntimeRequest) {
    const status = window.filmOSChatGPTHostStatus;
    if (request.operation === "probe") return hostProbe(status);
    if (request.operation === "cancel_turn" || request.operation === "close_session") return { ok: true };
    const input = record(request.payload.input);
    if (request.operation === "create_session" || request.operation === "resume_session") {
        const projectId = requiredString(input.domainProjectId || input.projectId, "projectId");
        assertAuthorizedHost(status, projectId);
        if (!request.sessionId || !status?.authorizedGrantId) throw new Error("CHATGPT_HOST_PROJECT_GRANT_REQUIRED");
        return {
            hostSessionId: `chatgpt-host:${request.sessionId}`,
            projectGrantId: status.authorizedGrantId,
            projectId,
            status: status.externalAccountConnected ? "observed" : "blocked_external_account",
            proposalHandoffEnabled: status.proposalHandoffEnabled,
            directApplyAvailable: false,
        };
    }
    if (request.operation !== "prepare_handoff") throw new Error("CHATGPT_HOST_OPERATION_UNSUPPORTED");
    const context = record(input.context);
    const project = record(context.project);
    const canvas = record(context.canvas);
    const route = record(context.route);
    const receipts = record(context.receipts);
    const projectId = requiredString(project.domainProjectId || project.id, "projectId");
    assertAuthorizedHost(status, projectId);
    const visibleIds = stringArray(canvas.visibleNodeIds);
    const selectedSummaries = Array.isArray(canvas.selectedSummaries) ? canvas.selectedSummaries.filter(isRecord) : [];
    const summaryById = new Map(selectedSummaries.map((item) => [String(item.id || ""), item]));
    const liveContext = {
        project_id: projectId,
        ...optionalSnakeId(route, "contentUnitId", "content_unit_id"),
        ...optionalSnakeId(route, "sceneId", "scene_id"),
        ...optionalSnakeId(route, "directorUnitId", "director_unit_id"),
        ...optionalSnakeId(route, "shotId", "shot_id"),
        canvas_id: requiredString(canvas.id, "canvasId"),
        selected_node_ids: stringArray(canvas.selectedNodeIds),
        visible_node_summaries: visibleIds.map((id) => sanitizeSummary(summaryById.get(id) || { id, type: "canvas_node" })),
        asset_version_ids: Array.isArray(context.assets) ? context.assets.filter(isRecord).map((item) => String(item.id || "")).filter(Boolean) : [],
        canvas_revision: numberValue(canvas.revision),
        canvas_state_hash: requiredString(canvas.stateHash, "canvasStateHash"),
        ...(typeof receipts.filmVersion === "number" ? { film_expected_version: receipts.filmVersion } : {}),
        ...(typeof receipts.contentHash === "string" ? { film_content_hash: receipts.contentHash } : {}),
        context_receipt_id: requiredString(input.contextReceiptId || context.contextReceiptId, "contextReceiptId"),
    };
    const contextReceipt = record(await requestDesktopChatGPTHost("publish_context", liveContext));
    const handoffReceipt = record(await requestDesktopChatGPTHost("publish_handoff", {
        session_id: requiredString(input.brainSessionId, "brainSessionId"),
        turn_id: requiredString(input.turnId, "turnId"),
        task: requiredString(input.prompt, "prompt"),
        context_receipt_id: requiredString(contextReceipt.context_receipt_id || liveContext.context_receipt_id, "contextReceiptId"),
    }));
    return {
        handoffId: requiredString(handoffReceipt.handoff_id, "handoffId"),
        hostSessionId: requiredString(input.hostSessionId, "hostSessionId"),
        projectId,
        contextReceiptId: liveContext.context_receipt_id,
        status: "waiting_for_host",
        directApplyAvailable: false,
    };
}

function hostProbe(status: FilmOSDesktopChatGPTHostStatus | undefined) {
    const safe = Boolean(status?.tunnelConnected && status.authorizedProjectId && status.authorizedGrantId && status.mcpWriteToolCount === 0 && status.mcpPaidToolCount === 0 && status.mcpDestructiveToolCount === 0);
    return { ready: safe, ...(safe ? {} : { reason: "Desktop Tunnel / Project Grant 尚未就绪" }), profileId: "chatgpt.subscription.host", billingMode: "subscription_host_no_extra_model_api", modelApiAdapterAvailable: false, fallbackEnabled: false };
}

function assertAuthorizedHost(status: FilmOSDesktopChatGPTHostStatus | undefined, projectId: string) {
    const probe = hostProbe(status);
    if (!probe.ready || status?.authorizedProjectId !== projectId) throw new Error("CHATGPT_HOST_PROJECT_GRANT_SCOPE_MISMATCH");
}

function toolCallMessage(call: ResponseToolCall): ResponseInputMessage {
    return { type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) };
}

function parseArguments(value: string) {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!isRecord(parsed)) throw new Error("MODEL_TOOL_ARGUMENTS_INVALID");
    return parsed;
}

function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function requiredString(value: unknown, field: string) { if (typeof value !== "string" || !value.trim()) throw new Error(`BROWSER_RUNTIME_FIELD_REQUIRED:${field}`); return value.trim(); }
function numberValue(value: unknown) { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("CHATGPT_HOST_CANVAS_REVISION_INVALID"); return value; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : []; }
function optionalSnakeId(input: Record<string, unknown>, source: string, target: string) { const value = input[source]; return typeof value === "string" && value.trim() ? { [target]: value.trim() } : {}; }
function sanitizeSummary(input: Record<string, unknown>) { return { id: String(input.id || ""), type: String(input.type || "canvas_node"), ...(typeof input.title === "string" ? { title: input.title.slice(0, 240) } : {}), ...(typeof input.status === "string" ? { status: input.status.slice(0, 80) } : {}) }; }

/** Keep semantic workbench identity while never sending a local filesystem path to a metered provider. */
export function sanitizeModelContext(input: Record<string, unknown>) {
    const route = record(input.route);
    const { workspace: _workspace, ...safeRoute } = route;
    return { ...input, route: safeRoute };
}

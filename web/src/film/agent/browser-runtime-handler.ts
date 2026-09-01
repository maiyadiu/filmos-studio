import { backendModelRuntimeRequired, runBackendToolGenerationTask } from "@/services/api/generation-task";
import { requestToolResponse, type ResponseInputMessage, type ResponseToolCall } from "@/services/api/image";
import { assertBrainProviderCompatibility, type BrainProfileBinding } from "@filmos/generation-contracts";
import { encodeChannelModel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

import { AgentSessionClient } from "./agent-client";
import type { BrowserRuntimeRequest } from "./browser-runtime-bridge";
import { requestDesktopChatGPTHost } from "./desktop-chatgpt-host-bridge";
import { chatGPTHostReadiness } from "./chatgpt-host-readiness";
import { GENERIC_MODEL_API_AGENT_TOOLS } from "./model-api-tool-manifest";
import type { FilmOSDesktopChatGPTHostStatus } from "./workbench-context";

type HandlerDependencies = {
    selectedProfileId: string;
    config: AiConfig;
    isConfigReady(config: AiConfig, model: string): boolean;
    resolveBinding(profileId: string): BrainProfileBinding | undefined;
    ordinaryConfirmationEnabled: boolean;
    client?: AgentSessionClient;
    sessionProfiles?: BrowserRuntimeSessionProfiles;
};

const MODEL_PROFILE_IDS = new Set(["openai.api", "anthropic.api", "deepseek.api", "local.model"]);

export class BrowserRuntimeSessionProfiles {
    private readonly profiles = new Map<string, string>();

    bind(sessionId: string, profileId: string) {
        const current = this.profiles.get(sessionId);
        if (current && current !== profileId) throw new Error("BROWSER_RUNTIME_SESSION_PROFILE_SCOPE_MISMATCH");
        this.profiles.set(sessionId, profileId);
    }

    assert(sessionId: string, profileId: string) {
        if (this.profiles.get(sessionId) !== profileId) throw new Error("BROWSER_RUNTIME_SESSION_PROFILE_SCOPE_MISMATCH");
    }

    release(sessionId: string, profileId: string) {
        this.assert(sessionId, profileId);
        this.profiles.delete(sessionId);
    }
}

export function createBrowserRuntimeRequestHandler(deps: HandlerDependencies) {
    const client = deps.client ?? new AgentSessionClient();
    const sessionProfiles = deps.sessionProfiles ?? new BrowserRuntimeSessionProfiles();
    return async (request: BrowserRuntimeRequest) => {
        if (request.operation === "probe") {
            if (request.channel === "chatgpt_host") return hostProbe(window.filmOSChatGPTHostStatus, activeHostProjectId());
            if (request.channel !== "model" || !MODEL_PROFILE_IDS.has(request.profileId)) throw new Error("BROWSER_RUNTIME_PROFILE_UNREGISTERED");
            return probeModelProfile(request.profileId, deps);
        }
        if (request.profileId !== deps.selectedProfileId) throw new Error("BROWSER_RUNTIME_PROFILE_SCOPE_MISMATCH");
        if (request.channel === "chatgpt_host") return await handleChatGPTHost(request);
        if (request.channel !== "model") throw new Error("BROWSER_RUNTIME_CHANNEL_UNSUPPORTED");
        if (!deps.resolveBinding(request.profileId)) throw new Error("BROWSER_RUNTIME_EXACT_BINDING_REQUIRED");
        if (request.operation === "create_session" || request.operation === "resume_session") {
            if (!request.sessionId) throw new Error("BROWSER_RUNTIME_SESSION_REQUIRED");
            sessionProfiles.bind(request.sessionId, request.profileId);
            return { providerThreadId: `browser:${request.profileId}:${request.sessionId}` };
        }
        if (request.operation === "cancel_turn" || request.operation === "close_session") {
            const sessionId = requiredString(request.sessionId, "sessionId");
            sessionProfiles.assert(sessionId, request.profileId);
            if (request.operation === "close_session") sessionProfiles.release(sessionId, request.profileId);
            return { ok: true };
        }
        if (request.operation !== "send_turn" || !request.sessionId || !request.turnId) throw new Error("BROWSER_RUNTIME_TURN_SCOPE_REQUIRED");
        sessionProfiles.assert(request.sessionId, request.profileId);
        return await runModelTurn(request, deps, client);
    };
}

function probeModelProfile(profileId: string, deps: HandlerDependencies) {
    const binding = deps.resolveBinding(profileId);
    if (!binding?.channelId || !binding.modelId) return { status: "unavailable" as const, statusReason: `Profile ${profileId} 尚未配置精确 Binding` };
    const channel = deps.config.channels.find((item) => item.id === binding.channelId && item.enabled !== false);
    if (!channel || (!channel.models.includes(binding.modelId) && !channel.localModels?.some((item) => item.id === binding.modelId))) {
        return { status: "unavailable" as const, statusReason: `Profile ${profileId} 的精确 Channel / Model 不可用` };
    }
    assertBrainProviderCompatibility(binding);
    if (binding.profileId === "local.model" && channel.transport !== "local-llm-runtime") return { status: "unavailable" as const, statusReason: "Local Brain 需要独立本地文本 LLM Runtime；Dreamina 不能作为 AI 大脑" };
    const modelValue = encodeChannelModel(channel.id, binding.modelId);
    const exactConfig = exactBoundModelConfig(deps.config, binding);
    if (profileId !== "local.model" && !Boolean(channel.apiKey.trim() || channel.hasApiKey)) {
        return { status: "needs_auth" as const, statusReason: `Profile ${profileId} 需要独立 API 凭据` };
    }
    return deps.isConfigReady(exactConfig, modelValue)
        ? { status: "ready" as const, version: `browser:${profileId}:${binding.entityVersion}` }
        : { status: profileId === "local.model" ? "unavailable" as const : "needs_auth" as const, statusReason: `Profile ${profileId} 的精确 Binding 尚未就绪` };
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
        const binding = deps.resolveBinding(request.profileId);
        if (!binding) throw new Error("BROWSER_RUNTIME_EXACT_BINDING_REQUIRED");
        const result = await requestModel(exactBoundModelConfig(deps.config, binding), messages, prompt);
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
    if (backendModelRuntimeRequired(config)) {
        return await runBackendToolGenerationTask({ prompt, config, messages, tools: [...GENERIC_MODEL_API_AGENT_TOOLS], toolChoice: "auto" });
    }
    return await requestToolResponse(config, messages, [...GENERIC_MODEL_API_AGENT_TOOLS], "auto");
}

export function exactBoundModelConfig(config: AiConfig, binding: BrainProfileBinding): AiConfig {
    if (!binding.enabled || !binding.channelId || !binding.modelId) throw new Error("BROWSER_RUNTIME_EXACT_BINDING_REQUIRED");
    const channel = config.channels.find((item) => item.id === binding.channelId && item.enabled !== false);
    if (!channel) throw new Error("BROWSER_RUNTIME_BOUND_CHANNEL_UNAVAILABLE");
    if (!channel.models.includes(binding.modelId) && !channel.localModels?.some((item) => item.id === binding.modelId)) throw new Error("BROWSER_RUNTIME_BOUND_MODEL_UNAVAILABLE");
    assertBrainProviderCompatibility(binding);
    if (binding.profileId === "local.model" && channel.transport !== "local-llm-runtime") throw new Error("LOCAL_LLM_TEXT_RUNTIME_REQUIRED");
    const modelValue = encodeChannelModel(channel.id, binding.modelId);
    const projected = resolveModelRequestConfig({ ...config, channels: [channel] }, modelValue);
    return { ...projected, channels: [channel], models: [modelValue], textModels: [modelValue], model: binding.modelId, textModel: binding.modelId };
}

async function handleChatGPTHost(request: BrowserRuntimeRequest) {
    const status = window.filmOSChatGPTHostStatus;
    if (request.operation === "probe") return hostProbe(status, activeHostProjectId());
    if (request.operation === "cancel_turn" || request.operation === "close_session") return { ok: true };
    const input = record(request.payload.input);
    if (request.operation === "create_session" || request.operation === "resume_session") {
        const projectId = requiredString(input.domainProjectId || input.projectId, "projectId");
        assertAuthorizedHost(status, projectId);
        if (!request.sessionId || !status?.authorizedGrantId) throw new Error("CHATGPT_HOST_PROJECT_GRANT_REQUIRED");
        const currentHandoff = record(input.hostHandoff);
        const expectedHandoffId = typeof currentHandoff.handoffId === "string" ? currentHandoff.handoffId : undefined;
        const observedExpectedHandoff = Boolean(expectedHandoffId && status.observedHandoffId === expectedHandoffId && status.lastReadAt);
        const proposalReceived = observedExpectedHandoff && status.lastExternalToolName === "filmos_prepare_proposal_export";
        return {
            hostSessionId: `chatgpt-host:${request.sessionId}`,
            projectGrantId: status.authorizedGrantId,
            projectId,
            status: proposalReceived ? "proposal_received" : observedExpectedHandoff ? "observed" : expectedHandoffId ? "waiting_for_host" : status.externalAccountConnected ? "observed" : "blocked_external_account",
            proposalHandoffEnabled: status.proposalHandoffEnabled,
            directApplyAvailable: false,
            ...(observedExpectedHandoff && status.lastReadAt ? { observedAt: status.lastReadAt, observedHandoffId: status.observedHandoffId } : {}),
            ...(proposalReceived && status.lastReadAt ? { proposalReceivedAt: status.lastReadAt } : {}),
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
    const publishedContextReceiptId = requiredString(contextReceipt.context_receipt_id || liveContext.context_receipt_id, "contextReceiptId");
    const handoffReceipt = record(await requestDesktopChatGPTHost("publish_handoff", {
        session_id: requiredString(input.brainSessionId, "brainSessionId"),
        turn_id: requiredString(input.turnId, "turnId"),
        task: requiredString(input.prompt, "prompt"),
        context_receipt_id: publishedContextReceiptId,
    }));
    return {
        handoffId: requiredString(handoffReceipt.handoff_id, "handoffId"),
        hostSessionId: requiredString(input.hostSessionId, "hostSessionId"),
        projectId,
        contextReceiptId: publishedContextReceiptId,
        status: "waiting_for_host",
        directApplyAvailable: false,
        createdAt: new Date().toISOString(),
        expiresAt: requiredString(handoffReceipt.expires_at, "expiresAt"),
    };
}

function hostProbe(status: FilmOSDesktopChatGPTHostStatus | undefined, projectId: string) {
    const readiness = chatGPTHostReadiness(status, projectId);
    return { ready: readiness.handoffReady, ...(readiness.handoffReady ? {} : { reason: readiness.message }), profileId: "chatgpt.subscription.host", billingMode: "subscription_host_no_extra_model_api", modelApiAdapterAvailable: false, fallbackEnabled: false };
}

function assertAuthorizedHost(status: FilmOSDesktopChatGPTHostStatus | undefined, projectId: string) {
    const probe = hostProbe(status, projectId);
    if (!probe.ready || status?.authorizedProjectId !== projectId) throw new Error("CHATGPT_HOST_PROJECT_GRANT_SCOPE_MISMATCH");
}

function activeHostProjectId() {
    return window.filmOSGetWorkbenchContext?.()?.domainProjectId || "";
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

import { GENERATION_ENGINES, hashProjection, type GenerationDefaultRoute, type GenerationEngineConnection, type ProjectGenerationPolicy } from "@filmos/generation-contracts";

import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { AiConfig } from "@/stores/use-config-store";
import type { BrainGenerationRoutingConfig } from "./user-config";
import { isAcceptanceProductionProject } from "./acceptance-production-runtime";

export type CanonicalBrokerExecutionAuthorization = {
    confirmationId: string;
    brokerGrantId: string;
    brokerGrantContentHash: string;
    brokerDecisionReceiptId: string;
    brokerDecisionReceiptContentHash: string;
    toolRequestId: string;
    actorRef: string;
    confirmedAt: string;
};

export const CANONICAL_GENERATION_TOOL_NAMES = [
    "generation_list_engines", "generation_get_engine_status", "generation_refresh_catalog", "generation_list_models",
    "generation_list_workflows", "generation_list_skills", "generation_select_effective_route", "generation_resolve_route_binding",
    "generation_compile_prompt", "generation_preview_submission", "generation_create_external_project", "generation_submit",
    "generation_get_status", "generation_reconcile", "generation_cancel", "generation_download_outputs",
    "generation_import_candidate", "generation_get_lineage",
] as const;

export type CanonicalGenerationToolName = (typeof CANONICAL_GENERATION_TOOL_NAMES)[number];

type RuntimeContext = {
    projectId: string;
    config: AiConfig;
    routingConfig: BrainGenerationRoutingConfig | null;
    snapshot: CanvasAgentSnapshot;
    nodeRoute?: GenerationDefaultRoute;
    projectPolicy?: ProjectGenerationPolicy;
    productionPort?: { executeAuthorized(input: CanonicalBrokerExecutionAuthorization & { proposalId: string }): Promise<unknown> };
    brokerAuthorization?: CanonicalBrokerExecutionAuthorization;
};

type Result = { ok: true; message: string; data: unknown } | { ok: false; message: string; data?: unknown };

const toolNames = new Set<string>(CANONICAL_GENERATION_TOOL_NAMES);

export function isCanonicalGenerationTool(name: string): name is CanonicalGenerationToolName {
    return toolNames.has(name);
}

export async function executeCanonicalGenerationTool(name: CanonicalGenerationToolName, input: Record<string, unknown>, context: RuntimeContext): Promise<Result> {
    const catalog = runtimeCatalog(context);
    if (name === "generation_list_engines") {
        const acceptanceProject = isAcceptanceProductionProject({
            projectId: context.projectId,
            domainProjectId: context.snapshot.domainProjectId,
            projectName: context.snapshot.title || "",
        });
        const engines = GENERATION_ENGINES.filter((engine) => acceptanceProject || engine.engineId !== "filmos_mock_generation");
        return success("已读取生成引擎注册表。", { engines, externalWritePerformed: false });
    }
    if (name === "generation_get_engine_status") {
        const engineId = required(input.engineId, "engineId");
        const connectionId = optional(input.connectionId);
        const connections = (context.routingConfig?.engineConnections || []).filter((item) => item.engineId === engineId && (!connectionId || item.connectionId === connectionId));
        return success("已读取精确 Engine / Connection 状态。", { engineId, connectionId, connections, externalWritePerformed: false });
    }
    if (name === "generation_refresh_catalog") return failure("CATALOG_REFRESH_REQUIRES_EXACT_ENGINE_ADAPTER", "目录刷新必须由精确 Engine Connection Adapter 执行；未进行网络请求。");
    if (name === "generation_list_models") return success("已读取当前连接的模型目录。", filteredCatalog(catalog.models, input));
    if (name === "generation_list_workflows") return success("已读取当前连接的工作流目录。", filteredCatalog(catalog.workflows, input));
    if (name === "generation_list_skills") return success("已读取当前连接的 Skill 目录。", filteredCatalog(catalog.skills, input));
    if (name === "generation_select_effective_route") {
        const taskKind = required(input.taskKind, "taskKind");
        const explicit = record(input.explicitRoute);
        const projectDefault = context.projectPolicy?.defaultRoutes[taskKind as keyof ProjectGenerationPolicy["defaultRoutes"]];
        const globalDefault = context.routingConfig?.generationDefaults[taskKind as keyof BrainGenerationRoutingConfig["generationDefaults"]];
        const selected = Object.keys(explicit).length ? explicit : context.nodeRoute || projectDefault || globalDefault;
        if (!selected) return failure("GENERATION_ROUTE_NEEDS_CONFIGURATION", "未找到显式、Project 或 Global 默认路线。");
        const selectionSource = Object.keys(explicit).length ? "explicit_task" : context.nodeRoute ? "node_override" : projectDefault ? "project_default" : "global_default";
        return success("已按显式任务、节点、项目、全局默认的优先级选择路线。", { ...selected, taskKind, selectionSource, externalWritePerformed: false });
    }
    if (name === "generation_resolve_route_binding") {
        const engineId = required(input.engineId, "engineId");
        const connectionId = required(input.connectionId, "connectionId");
        const descriptorId = required(input.descriptorId, "descriptorId");
        const descriptors = [...catalog.models, ...catalog.workflows, ...catalog.skills].filter((item) => item.engineId === engineId && item.connectionId === connectionId && item.descriptorId === descriptorId);
        if (descriptors.length !== 1) return failure(descriptors.length ? "DESCRIPTOR_ID_AMBIGUOUS" : "DESCRIPTOR_NOT_FOUND", "Descriptor 必须按 ID 精确命中一次，禁止名称猜测或静默替换。");
        const descriptor = descriptors[0];
        return success("已精确解析 Route 与 Descriptor。", { descriptor, descriptorSemanticHash: descriptor.descriptorHash, externalWritePerformed: false });
    }
    if (name === "generation_compile_prompt") {
        const taskKind = required(input.taskKind, "taskKind");
        const body = record(input.input);
        const prompt = required(body.prompt ?? body.text, "input.prompt");
        const engineId = required(body.engineId, "input.engineId");
        const compiledPromptSemanticHash = await hashProjection("compiled-prompt", "semantic", { taskKind, engineId, modelId: optional(body.modelId), prompt, negativePrompt: optional(body.negativePrompt), compilerVersion: "filmos-v2.4", templateVersion: "v1" });
        return success("已生成版本化 Prompt Compilation Receipt。", { compiledPromptReceiptId: `prompt-${compiledPromptSemanticHash.slice(0, 24)}`, compiledPromptSemanticHash, compilerVersion: "filmos-v2.4", templateVersion: "v1", text: prompt, externalWritePerformed: false });
    }
    if (name === "generation_preview_submission") {
        const routeSnapshotId = required(input.routeSnapshotId, "routeSnapshotId");
        const proposalHash = await hashProjection("generation-submission-preview", "semantic", { routeSnapshotId, projectId: context.projectId });
        return success("已创建零费用提交预览；未执行 Provider 请求。", { routeSnapshotId, proposalHash, catalogValidation: "required_at_submit", brokerConfirmation: "required", budgetAuthorization: "required", externalCostMicrounits: "0", externalWritePerformed: false });
    }
    if (name === "generation_get_status" || name === "generation_reconcile" || name === "generation_get_lineage") {
        const attemptId = optional(input.generationAttemptId) || optional(input.taskId);
        const records = context.snapshot.nodes.flatMap((node) => {
            const metadata = node.metadata || {};
            const currentAttempt = optional(metadata.taskId);
            if (attemptId && currentAttempt !== attemptId) return [];
            if (!currentAttempt) return [];
            return [{ nodeId: node.id, generationAttemptId: currentAttempt, status: metadata.status || "unknown", routeSnapshotId: metadata.generationRouteSnapshotId, candidateImported: metadata.generationSubmissionState === "candidate" }];
        });
        if (name === "generation_reconcile" && !records.length) return failure("GENERATION_RECONCILE_SOURCE_NOT_FOUND", "没有可恢复的本地 Provider Task Receipt；禁止自动重提。");
        return success(name === "generation_get_lineage" ? "已读取生成 lineage。" : "已读取生成任务状态；未执行重提。", { records, retryPerformed: false, externalWritePerformed: false });
    }
    if (name === "generation_create_external_project") return gated("EXTERNAL_PROJECT_CREATION_AUTHORIZATION_REQUIRED", "外部项目创建需要独立 Broker Decision Receipt。");
    if (name === "generation_submit") {
        const proposalId = required(input.proposalId, "proposalId");
        if (!context.productionPort) return gated("READY_FOR_USER_AUTHORIZATION", "当前 Runtime 尚未绑定用户批准的 Production Composition；未执行 Provider 请求。");
        if (!context.brokerAuthorization) return gated("CANONICAL_BROKER_AUTHORIZATION_REQUIRED", "generation_submit 必须消费 Canonical Broker 的真实确认、Grant 与 Decision Receipt。");
        const receipt = await context.productionPort.executeAuthorized({ proposalId, ...context.brokerAuthorization });
        return success("已通过 Production Tool Broker 执行精确 Authorized Submission。", receipt);
    }
    if (name === "generation_cancel") return gated("GENERATION_CANCEL_AUTHORIZATION_REQUIRED", "取消外部任务需要精确 Task Receipt 与 Broker 确认。");
    if (name === "generation_download_outputs") return gated("GENERATION_OUTPUT_RECEIPT_REQUIRED", "下载需要已有 Provider Output Receipt 与内容 Hash。");
    return gated("GENERATION_CANDIDATE_IMPORT_RECEIPT_REQUIRED", "Candidate 导入需要已校验输出 Receipt；不得直接标记 Approved。");
}

function runtimeCatalog(context: RuntimeContext) {
    const dreamina = context.config.channels.filter((channel) => channel.transport === "local-runtime").flatMap((channel) => (channel.localModels || []).map((model) => ({
        descriptorId: model.id,
        descriptorHash: stableDescriptorHash("dreamina_cli", "dreamina-local", model.id),
        descriptorKind: "model",
        engineId: "dreamina_cli",
        connectionId: "dreamina-local",
        displayName: model.displayName,
        capability: model.modality,
        availability: model.currentlyObservedAvailable === "no" ? "unavailable" : model.currentlyObservedAvailable === "yes" ? "available" : "unknown",
        catalogEvidence: "verified_static_version_bound",
    })));
    const runningHub = context.config.runningHub.workflows.map((workflow) => ({ descriptorId: workflow.workflowId, descriptorHash: stableDescriptorHash("runninghub", "runninghub-default", workflow.workflowId), descriptorKind: "workflow", engineId: "runninghub", connectionId: "runninghub-default", displayName: workflow.title || workflow.workflowId, capability: workflow.capability || context.config.runningHub.capability, catalogEvidence: "remote_catalog" }));
    const comfy = context.config.comfyBridge.workflows.map((workflow) => ({ descriptorId: workflow.workflowId, descriptorHash: stableDescriptorHash("comfyui", "comfyui-default", workflow.workflowId), descriptorKind: "workflow", engineId: "comfyui", connectionId: "comfyui-default", displayName: workflow.title || workflow.workflowId, capability: workflow.capability || context.config.comfyBridge.capability, catalogEvidence: "runtime_discovery" }));
    return { models: dreamina, workflows: [...runningHub, ...comfy], skills: [] as Array<Record<string, unknown>> };
}

function stableDescriptorHash(engineId: string, connectionId: string, descriptorId: string) {
    // UI discovery results are evidence labels only. Submit revalidates the full
    // content-addressed descriptor through the shared contract before use.
    return `${engineId}:${connectionId}:${descriptorId}`;
}

function filteredCatalog(items: Array<Record<string, unknown>>, input: Record<string, unknown>) {
    const engineId = optional(input.engineId);
    const connectionId = optional(input.connectionId);
    return { descriptors: items.filter((item) => (!engineId || item.engineId === engineId) && (!connectionId || item.connectionId === connectionId)), externalWritePerformed: false };
}

function success(message: string, data: unknown): Result { return { ok: true, message, data }; }
function failure(code: string, message: string): Result { return { ok: false, message: `${code}: ${message}`, data: { code, externalWritePerformed: false } }; }
function gated(code: string, message: string): Result { return failure(code, message); }
function optional(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : ""; }
function required(value: unknown, field: string) { const result = optional(value); if (!result) throw new Error(`GENERATION_TOOL_FIELD_REQUIRED:${field}`); return result; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

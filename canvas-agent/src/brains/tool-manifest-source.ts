import type { AgentToolManifest, AgentToolRisk } from "./contracts.js";
import { filmToolDescriptions, filmToolNames } from "../film/contracts.js";
import { toolDescriptions, toolNames } from "../schemas.js";

export type CanonicalAgentToolMetadata = Omit<AgentToolManifest, "inputSchema">;

const readCanvasTools = new Set([
    "canvas_get_state", "canvas_get_context", "canvas_find_nodes", "canvas_get_node", "canvas_get_connection",
    "canvas_get_generation_tasks", "canvas_get_resources", "canvas_get_selection", "canvas_export_snapshot",
    "project_get_context", "project_list_units",
]);
const draftCanvasTools = new Set(["canvas_validate_ops"]);
const paidCanvasTools = new Set([
    "canvas_create_image_prompt_flow", "canvas_create_generation_flow", "canvas_generate_text", "canvas_generate_image",
    "canvas_generate_video", "canvas_generate_audio", "canvas_run_generation",
]);
const destructiveCanvasTools = new Set(["canvas_delete_nodes"]);
const generationReadTools = new Set([
    "generation_list_engines", "generation_get_engine_status", "generation_refresh_catalog", "generation_list_models",
    "generation_list_workflows", "generation_list_skills", "generation_select_effective_route", "generation_resolve_route_binding",
    "generation_get_status", "generation_reconcile", "generation_get_lineage",
]);
const generationDraftTools = new Set(["generation_compile_prompt", "generation_preview_submission"]);
const canonicalGenerationToolNames = [
    ...generationReadTools,
    ...generationDraftTools,
    "generation_create_external_project", "generation_submit", "generation_cancel", "generation_download_outputs", "generation_import_candidate",
] as const;

export const CANONICAL_AGENT_TOOL_METADATA: readonly CanonicalAgentToolMetadata[] = [
    metadata({
        name: "workbench_get_context",
        title: "读取当前 FilmOS 工作上下文",
        description: "读取受信工作台路由、项目、Film、画布、选区、资产与版本收据；不接受模型提供的身份或项目覆盖。",
        risk: "read",
        surfaces: ["workbench_operator", "chatgpt_hosted"],
        provider: "runtime",
        requiresFreshContext: false,
    }),
    ...toolNames.map((name) => metadata({
        name,
        title: toolTitle(name),
        description: toolDescriptions[name],
        risk: canvasRisk(name),
        surfaces: ["canvas_legacy", "workbench_operator", "runtime_admin"],
        provider: name.startsWith("project_") ? "host_project" : paidCanvasTools.has(name) ? "generation" : "canvas",
        requiresFreshContext: true,
    })),
    ...filmToolNames.map((name) => metadata({
        name,
        title: toolTitle(name),
        description: filmToolDescriptions[name],
        risk: name === "film_command_preview" ? "draft" : name === "film_command_apply" ? "approval" : "read",
        surfaces: ["workbench_operator", "runtime_admin"],
        provider: "film_core",
        requiresFreshContext: true,
    })),
    ...canonicalGenerationToolNames.map((name) => metadata({
        name,
        title: toolTitle(name),
        description: generationToolDescription(name),
        risk: name === "generation_submit" ? "paid" : generationReadTools.has(name) ? "read" : generationDraftTools.has(name) ? "draft" : "write",
        surfaces: generationReadTools.has(name) || generationDraftTools.has(name)
            ? ["workbench_operator", "chatgpt_hosted", "runtime_admin"]
            : ["workbench_operator", "runtime_admin"],
        provider: "generation",
        requiresFreshContext: true,
    })),
    metadata({
        name: "chatgpt_prepare_handoff",
        title: "准备 ChatGPT Host Handoff",
        description: "为当前项目和 Context Receipt 准备 Host Handoff；不会调用模型 API，也不会直接写入 FilmOS。",
        risk: "draft",
        surfaces: ["chatgpt_hosted"],
        provider: "chatgpt_handoff",
        requiresFreshContext: true,
    }),
    metadata({
        name: "dreamina_cli",
        title: "Dreamina CLI 维护入口",
        description: "仅 Runtime Admin 可使用的兼容 Provider 工具；会消耗真实 credits，普通 Workbench Agent 不可见。",
        risk: "paid",
        surfaces: ["runtime_admin"],
        provider: "generation",
        requiresFreshContext: false,
    }),
] as const;

function metadata(input: Omit<CanonicalAgentToolMetadata, "mayCreateCharges">): CanonicalAgentToolMetadata {
    return { ...input, mayCreateCharges: input.risk === "paid" };
}

function canvasRisk(name: string): AgentToolRisk {
    if (readCanvasTools.has(name)) return "read";
    if (draftCanvasTools.has(name)) return "draft";
    if (paidCanvasTools.has(name)) return "paid";
    if (destructiveCanvasTools.has(name)) return "destructive";
    return "write";
}

function toolTitle(name: string) {
    return name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function generationToolDescription(name: string) {
    const descriptions: Record<string, string> = {
        generation_list_engines: "读取已注册生成引擎；不执行外部操作。",
        generation_get_engine_status: "读取精确 Engine/Connection 状态与账号匿名绑定。",
        generation_refresh_catalog: "刷新账号隔离的只读目录；不生成、不上传。",
        generation_list_models: "读取当前连接的模型目录与证据。",
        generation_list_workflows: "读取当前连接的工作流目录与证据。",
        generation_list_skills: "读取当前连接的 Skill 目录与证据。",
        generation_select_effective_route: "按 Task/Node/Project/Global 优先级选择技术路线，不执行提交。",
        generation_resolve_route_binding: "精确解析 Route 与 Descriptor Receipt，不允许名称猜测或静默替换。",
        generation_compile_prompt: "编译版本化 Provider Prompt Receipt；仅写草稿证据。",
        generation_preview_submission: "创建零费用提交预览、Catalog Validation 和费用说明。",
        generation_create_external_project: "创建外部 Provider 项目；必须由 Broker 确认。",
        generation_submit: "按 Authorized Submission 执行一次可能付费的生成提交；必须由 Broker 确认。",
        generation_get_status: "读取已有 Provider Task 状态。",
        generation_reconcile: "对 Unknown/中断任务只做恢复核对，禁止自动重提。",
        generation_cancel: "请求取消已有 Provider Task；必须由 Broker 确认。",
        generation_download_outputs: "下载已有输出并校验 Hash；不自动批准。",
        generation_import_candidate: "将校验后的输出导入 Candidate；不得直接 Approved。",
        generation_get_lineage: "读取 Route、Prompt、Receipt、Candidate 与 QC lineage。",
    };
    return descriptions[name] || name;
}

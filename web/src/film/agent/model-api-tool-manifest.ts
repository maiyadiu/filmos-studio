import type { ResponseFunctionTool } from "@/services/api/image";

export type ModelApiToolRisk = "read" | "draft" | "write" | "destructive" | "paid";
export type ModelApiToolManifestEntry = { tool: ResponseFunctionTool; risk: ModelApiToolRisk };

const JSON_RECORD_SCHEMA = { type: "object", additionalProperties: true };
const POSITION_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false };
const VIEWPORT_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, required: ["x", "y", "k"], additionalProperties: false };
const NODE_TYPE_SCHEMA = { type: "string", enum: ["image", "text", "skill", "video", "audio"] };
const WORKFLOW_NODE_KIND_SCHEMA = { type: "string", enum: ["text", "script", "image", "video", "audio", "character_cards", "character_three_view", "storyboard_video"] };
const GENERATION_MODE_SCHEMA = { type: "string", enum: ["text", "image", "video", "audio"] };
const GENERATION_OPTION_PROPERTIES = {
    model: { type: "string" }, size: { type: "string" }, quality: { type: "string" }, transparentBackground: { type: "string", enum: ["true", "false"] },
    count: { type: "number" }, seconds: { type: "string" }, vquality: { type: "string" }, generateAudio: { type: "string" }, watermark: { type: "string" },
    audioVoice: { type: "string" }, audioFormat: { type: "string" }, audioSpeed: { type: "string" }, audioInstructions: { type: "string" },
};
const CANVAS_OP_SCHEMA = {
    type: "object",
    properties: {
        type: { type: "string", enum: ["add_node", "update_node", "delete_node", "delete_connections", "connect_nodes", "set_viewport", "select_nodes", "run_generation"] },
        id: { type: "string" }, ids: { type: "array", items: { type: "string" } }, nodeType: NODE_TYPE_SCHEMA, title: { type: "string" },
        x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, position: POSITION_SCHEMA,
        metadata: JSON_RECORD_SCHEMA, patch: JSON_RECORD_SCHEMA, all: { type: "boolean" }, fromNodeId: { type: "string" }, toNodeId: { type: "string" },
        viewport: VIEWPORT_SCHEMA, nodeId: { type: "string" }, mode: GENERATION_MODE_SCHEMA, prompt: { type: "string" }, retry: { type: "boolean" },
    },
    required: ["type"],
    additionalProperties: false,
};

function tool(name: string, description: string, properties: Record<string, unknown>, risk: ModelApiToolRisk, required: string[] = [], strict = false): ModelApiToolManifestEntry {
    return { risk, tool: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false }, strict } } };
}

function generationTool(name: string, description: string, mode?: "text" | "image" | "video" | "audio") {
    return tool(name, description, {
        prompt: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" },
        referenceNodeIds: { type: "array", items: { type: "string" } }, ...(mode ? {} : { mode: GENERATION_MODE_SCHEMA }),
        autoRun: { type: "boolean" }, ...GENERATION_OPTION_PROPERTIES,
    }, "paid", ["prompt"]);
}

/**
 * Compatibility view for the existing metered browser Model API adapter. The
 * React panel consumes this manifest and no longer owns a parallel tool list.
 * Native Codex/Local/Hosted sessions use the server-side canonical manifest.
 */
export const MODEL_API_AGENT_TOOL_MANIFEST: readonly ModelApiToolManifestEntry[] = [
    tool("canvas_list_skills", "列出当前用户已加入、可按需加载的画布技能；只返回元数据，不返回完整指令。", {}, "read"),
    tool("canvas_get_skill", "按 skillId 或技能名称按需加载一个画布技能的完整契约。技能正文通过工具结果提供，不会自动注入每条用户消息。", { skillId: { type: "string" }, name: { type: "string" } }, "read"),
    tool("canvas_get_state", "读取当前网页画布的节点、连线、选区和视口。", {}, "read"),
    tool("canvas_get_context", "读取语义化画布上下文、真实节点 id、连接关系、资源就绪状态和状态哈希。", {}, "read"),
    tool("canvas_find_nodes", "按标题、内容、提示词、类型、状态或资产检索真实节点。", { query: { type: "string" }, ids: { type: "array", items: { type: "string" } }, types: { type: "array", items: { type: "string" } }, statuses: { type: "array", items: { type: "string" } }, resourceOnly: { type: "boolean" }, limit: { type: "number" } }, "read"),
    tool("canvas_get_node", "按真实节点 id 精确读取单个节点、资源状态和关联连线。", { id: { type: "string" } }, "read", ["id"]),
    tool("canvas_get_connection", "按真实连线 id 精确读取端点节点和 handle 信息。", { id: { type: "string" } }, "read", ["id"]),
    tool("canvas_get_generation_tasks", "读取当前画布绑定的生成任务观察状态，不主动轮询上游。", { status: { type: "string" }, nodeIds: { type: "array", items: { type: "string" } }, limit: { type: "number" } }, "read"),
    tool("canvas_get_resources", "读取画布媒体资源引用、类型、尺寸、大小、时长和就绪状态，不返回媒体 URL。", { nodeIds: { type: "array", items: { type: "string" } }, status: { type: "string" }, limit: { type: "number" } }, "read"),
    tool("canvas_validate_ops", "在写入前校验节点 id、连接关系和批量操作参数。", { ops: { type: "array", items: CANVAS_OP_SCHEMA } }, "draft", ["ops"]),
    tool("canvas_get_selection", "读取当前网页画布选中的节点。", {}, "read"),
    tool("canvas_export_snapshot", "导出当前画布快照，用于理解布局。", {}, "read"),
    tool("canvas_apply_ops", "批量操作当前网页画布。复杂写操作应先 canvas_validate_ops；可传 canvas_get_context 返回的 expectedStateHash 防止基于过期状态写入。", { ops: { type: "array", items: CANVAS_OP_SCHEMA }, expectedRevision: { type: "number" }, expectedStateHash: { type: "string" } }, "write", ["ops"]),
    tool("canvas_create_workflow", "创建语义化工作流/流水线；使用真实节点类型、内容、提示词、边和布局，已有素材必须引用真实 node id。", {
        title: { type: "string" }, description: { type: "string" },
        nodes: { type: "array", minItems: 1, items: { type: "object", properties: { ref: { type: "string" }, kind: WORKFLOW_NODE_KIND_SCHEMA, title: { type: "string" }, content: { type: "string" }, prompt: { type: "string" }, description: { type: "string" }, referenceRefs: { type: "array", items: { type: "string" } }, referenceNodeIds: { type: "array", items: { type: "string" } }, runGeneration: { type: "boolean" }, width: { type: "number" }, height: { type: "number" } }, required: ["ref", "kind", "title"], additionalProperties: false } },
        edges: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false } },
        direction: { type: "string", enum: ["horizontal", "vertical"] }, start: POSITION_SCHEMA, gap: { type: "number" }, autoRun: { type: "boolean" },
    }, "write", ["nodes"]),
    tool("canvas_create_node", "创建任意类型节点。", { nodeType: NODE_TYPE_SCHEMA, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, metadata: JSON_RECORD_SCHEMA }, "write", ["nodeType"]),
    tool("canvas_create_text_node", "在当前画布创建单个文本节点。", { text: { type: "string" }, x: { type: "number" }, y: { type: "number" }, title: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, "write"),
    tool("canvas_create_text_nodes", "批量创建文本节点。", { items: { type: "array", minItems: 1, items: { type: "object", properties: { text: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["text"], additionalProperties: false } }, x: { type: "number" }, y: { type: "number" }, gap: { type: "number" }, direction: { type: "string", enum: ["row", "column"] } }, "write", ["items"]),
    tool("canvas_create_cinematic_session", "把自然语言创作指令提交给后端影视 Agent 会话并返回可写回画布的候选操作。", { prompt: { type: "string" } }, "write", ["prompt"]),
    tool("canvas_create_image_prompt_flow", "创建提示词文本节点和图片目标节点并自动连线，可选择立即触发生图。", { prompt: { type: "string" }, x: { type: "number" }, y: { type: "number" }, autoRun: { type: "boolean" }, ...GENERATION_OPTION_PROPERTIES }, "paid", ["prompt"]),
    generationTool("canvas_create_generation_flow", "创建通用生成流程。"),
    generationTool("canvas_generate_text", "创建通用文本生成流程并立即触发生成。", "text"),
    generationTool("canvas_generate_image", "创建通用图片生成流程并立即触发生成。", "image"),
    generationTool("canvas_generate_video", "创建通用视频生成流程并立即触发生成。", "video"),
    generationTool("canvas_generate_audio", "创建通用音频生成流程并立即触发生成。", "audio"),
    tool("canvas_update_node", "更新节点基础字段或 metadata。", { id: { type: "string" }, patch: JSON_RECORD_SCHEMA, metadata: JSON_RECORD_SCHEMA }, "write", ["id"]),
    tool("canvas_update_node_text", "更新文本节点内容和标题。", { id: { type: "string" }, text: { type: "string" }, title: { type: "string" } }, "write", ["id", "text"]),
    tool("canvas_move_nodes", "移动一个或多个节点。", { items: { type: "array", minItems: 1, items: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["id"], additionalProperties: false } } }, "write", ["items"]),
    tool("canvas_resize_node", "调整节点尺寸。", { id: { type: "string" }, width: { type: "number" }, height: { type: "number" }, freeResize: { type: "boolean" } }, "write", ["id", "width", "height"]),
    tool("canvas_delete_nodes", "删除指定节点及相关连线。", { ids: { type: "array", items: { type: "string" }, minItems: 1 } }, "destructive", ["ids"]),
    tool("canvas_connect_nodes", "批量连接节点。", { connections: { type: "array", minItems: 1, items: { type: "object", properties: { fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, required: ["fromNodeId", "toNodeId"], additionalProperties: false } } }, "write", ["connections"]),
    tool("canvas_select_nodes", "设置当前选中节点。", { ids: { type: "array", items: { type: "string" } } }, "write", ["ids"]),
    tool("canvas_set_viewport", "调整画布视口。", { viewport: VIEWPORT_SCHEMA }, "write", ["viewport"]),
    tool("canvas_run_generation", "触发指定节点生成；对已有生成任务明确重试时传 retry=true。", { nodeId: { type: "string" }, mode: GENERATION_MODE_SCHEMA, prompt: { type: "string" }, retry: { type: "boolean" } }, "paid", ["nodeId"]),
] as const;

export const MODEL_API_AGENT_TOOLS = MODEL_API_AGENT_TOOL_MANIFEST.map((entry) => entry.tool);
export const MODEL_API_READ_TOOL_NAMES = new Set(MODEL_API_AGENT_TOOL_MANIFEST.filter((entry) => entry.risk === "read" || entry.risk === "draft").map((entry) => entry.tool.function.name));

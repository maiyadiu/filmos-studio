import {
    canonicalModelApiReadToolNames,
    canonicalModelApiToolManifest,
    canonicalModelApiTools,
} from "@filmos/agent-tool-contracts/model-api-tools";

import type { ResponseFunctionTool } from "@/services/api/image";

export type ModelApiToolRisk = "read" | "draft" | "write" | "approval" | "destructive" | "paid";
export type ModelApiToolManifestEntry = { tool: ResponseFunctionTool; risk: ModelApiToolRisk };

/**
 * Exact generated view used by GenericAgentRuntime browser adapters. Every
 * tool is registered by the server-side canonical manifest and must return
 * through CanonicalAgentToolBroker.
 */
export const GENERIC_MODEL_API_AGENT_TOOL_MANIFEST: readonly ModelApiToolManifestEntry[] = canonicalModelApiToolManifest.map((entry) => ({
    risk: entry.risk,
    tool: structuredClone(entry.tool) as ResponseFunctionTool,
}));
export const GENERIC_MODEL_API_AGENT_TOOLS: readonly ResponseFunctionTool[] = canonicalModelApiTools.map((tool) => structuredClone(tool) as ResponseFunctionTool);
export const GENERIC_MODEL_API_READ_TOOL_NAMES = new Set<string>(canonicalModelApiReadToolNames);

/**
 * These three browser-owned helpers predate GenericAgentRuntime. They remain
 * available only while the complete native feature group is disabled; they do
 * not duplicate a canonical Canvas, Project, Film or MCP tool contract.
 */
const LEGACY_BROWSER_ONLY_TOOL_MANIFEST: readonly ModelApiToolManifestEntry[] = [
    localTool("canvas_list_skills", "列出当前用户已加入、可按需加载的画布技能；只返回元数据，不返回完整指令。", {}, "read"),
    localTool("canvas_get_skill", "按 skillId 或技能名称按需加载一个画布技能的完整契约。", {
        skillId: { type: "string" },
        name: { type: "string" },
    }, "read"),
    localTool("canvas_create_cinematic_session", "把自然语言创作指令提交给后端影视 Agent 会话并返回可写回画布的候选操作。", {
        prompt: { type: "string" },
    }, "write", ["prompt"]),
];

/** @deprecated Candidate/native sessions use GENERIC_MODEL_API_AGENT_TOOLS. */
export const MODEL_API_AGENT_TOOL_MANIFEST: readonly ModelApiToolManifestEntry[] = [
    ...LEGACY_BROWSER_ONLY_TOOL_MANIFEST,
    ...GENERIC_MODEL_API_AGENT_TOOL_MANIFEST,
];
/** @deprecated Candidate/native sessions use GENERIC_MODEL_API_AGENT_TOOLS. */
export const MODEL_API_AGENT_TOOLS = MODEL_API_AGENT_TOOL_MANIFEST.map((entry) => entry.tool);
/** @deprecated Candidate/native sessions use GENERIC_MODEL_API_READ_TOOL_NAMES. */
export const MODEL_API_READ_TOOL_NAMES = new Set(MODEL_API_AGENT_TOOL_MANIFEST.filter((entry) => entry.risk === "read" || entry.risk === "draft").map((entry) => entry.tool.function.name));

function localTool(name: string, description: string, properties: Record<string, unknown>, risk: ModelApiToolRisk, required: string[] = []): ModelApiToolManifestEntry {
    return {
        risk,
        tool: {
            type: "function",
            function: {
                name,
                description,
                parameters: { type: "object", properties, required, additionalProperties: false },
                strict: false,
            },
        },
    };
}

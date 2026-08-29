import type { AgentToolManifest, AgentToolRisk, AgentToolSurfaceId } from "./contracts.js";
import { filmToolDescriptions, filmToolNames } from "../film/contracts.js";
import { toolDescriptions, toolNames } from "../schemas.js";

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

export const CANONICAL_AGENT_TOOL_MANIFEST: readonly AgentToolManifest[] = [
    manifest({
        name: "workbench_get_context",
        title: "读取当前 FilmOS 工作上下文",
        description: "读取受信工作台路由、项目、Film、画布、选区、资产与版本收据；不接受模型提供的身份或项目覆盖。",
        risk: "read",
        surfaces: ["workbench_operator", "chatgpt_hosted"],
        provider: "runtime",
        requiresFreshContext: false,
    }),
    ...toolNames.map((name) => manifest({
        name,
        title: toolTitle(name),
        description: toolDescriptions[name],
        risk: canvasRisk(name),
        surfaces: ["canvas_legacy", "workbench_operator", "runtime_admin"],
        provider: name.startsWith("project_") ? "host_project" : paidCanvasTools.has(name) ? "generation" : "canvas",
        requiresFreshContext: true,
    })),
    ...filmToolNames.map((name) => manifest({
        name,
        title: toolTitle(name),
        description: filmToolDescriptions[name],
        risk: name === "film_command_preview" ? "draft" : name === "film_command_apply" ? "approval" : "read",
        surfaces: ["workbench_operator", "runtime_admin"],
        provider: "film_core",
        requiresFreshContext: true,
    })),
    manifest({
        name: "chatgpt_prepare_handoff",
        title: "准备 ChatGPT Host Handoff",
        description: "为当前项目和 Context Receipt 准备 Host Handoff；不会调用模型 API，也不会直接写入 FilmOS。",
        risk: "draft",
        surfaces: ["chatgpt_hosted"],
        provider: "chatgpt_handoff",
        requiresFreshContext: true,
    }),
    manifest({
        name: "dreamina_cli",
        title: "Dreamina CLI 维护入口",
        description: "仅 Runtime Admin 可使用的兼容 Provider 工具；会消耗真实 credits，普通 Workbench Agent 不可见。",
        risk: "paid",
        surfaces: ["runtime_admin"],
        provider: "generation",
        requiresFreshContext: false,
    }),
] as const;

export class CanonicalAgentToolManifest {
    private readonly tools = new Map(CANONICAL_AGENT_TOOL_MANIFEST.map((tool) => [tool.name, tool]));

    get(name: string) {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`AGENT_TOOL_NOT_IN_CANONICAL_MANIFEST:${name}`);
        return structuredClone(tool);
    }

    list(surface?: AgentToolSurfaceId) {
        return [...this.tools.values()]
            .filter((tool) => !surface || tool.surfaces.includes(surface))
            .map((tool) => structuredClone(tool));
    }

    names(surface: AgentToolSurfaceId) {
        return this.list(surface).map((tool) => tool.name);
    }
}

function manifest(input: Omit<AgentToolManifest, "inputSchema" | "mayCreateCharges">): AgentToolManifest {
    return {
        ...input,
        inputSchema: {
            type: "object",
            additionalProperties: false,
            "x-filmos-validator": input.name,
        },
        mayCreateCharges: input.risk === "paid",
    };
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

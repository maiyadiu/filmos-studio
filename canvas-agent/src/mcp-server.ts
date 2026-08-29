import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { canonicalMcpTools } from "@filmos/agent-tool-contracts/mcp-tools";

import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "./config.js";
import type { AgentToolRisk, AgentToolSurfaceId } from "./brains/contracts.js";
import { CanonicalAgentToolManifest } from "./brains/tool-manifest.js";
import { filmToolNames } from "./film/contracts.js";
import { registerFilmAgentMcp, type FilmAgentMcpOptions } from "./film/mcp.js";
import { registerDreaminaMcp } from "./modules/dreamina-mcp.js";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "./schemas.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };
const canonicalMcpToolsByName: ReadonlyMap<string, (typeof canonicalMcpTools)[number]> = new Map(canonicalMcpTools.map((tool) => [tool.name, tool]));

export async function startMcpServer(options: { canvasOnly?: boolean; surface?: AgentToolSurfaceId } = {}) {
    const config = loadConfig(true);
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    const surfaceArgIndex = process.argv.indexOf("--surface");
    const argvSurface = surfaceArgIndex >= 0 ? process.argv[surfaceArgIndex + 1] as AgentToolSurfaceId | undefined : undefined;
    registerMcpTools(server, config, {
        canvasOnly: options.canvasOnly ?? process.argv.slice(3).includes("--canvas-only"),
        surface: options.surface ?? argvSurface,
    });
    await server.connect(new StdioServerTransport());
}

export type RegisterMcpToolsOptions = {
    canvasOnly?: boolean;
    surface?: AgentToolSurfaceId;
    film?: FilmAgentMcpOptions;
};

export function registerMcpTools(server: McpServer, config: CanvasAgentConfig, options: RegisterMcpToolsOptions = {}) {
    const surface = resolveToolSurface(options);
    const allowed = new Set(new CanonicalAgentToolManifest().names(surface));
    toolNames.filter((name) => allowed.has(name)).forEach((name) => registerCanvasTool(server, config, name));
    if (allowed.has("workbench_get_context")) registerWorkbenchContextTool(server, config);
    if (surface === "runtime_admin") {
        if (allowed.has("dreamina_cli")) registerDreaminaMcp(server, config);
        if (filmToolNames.some((name) => allowed.has(name))) registerFilmAgentMcp(server, config, options.film);
    }
    if (surface === "workbench_operator" && filmToolNames.some((name) => allowed.has(name))) registerFilmAgentMcp(server, config, { ...options.film, enabled: true });
}

function registerWorkbenchContextTool(server: McpServer, config: CanvasAgentConfig) {
    const contract = requiredMcpContract("workbench_get_context");
    server.registerTool("workbench_get_context", {
        description: contract.description,
        inputSchema: {},
        annotations: contract.annotations,
    }, async () => {
        const result = await postCanvasAgentTool(config, "workbench_get_context", {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
}

function resolveToolSurface(options: RegisterMcpToolsOptions): AgentToolSurfaceId {
    if (options.surface) return options.surface;
    if (options.canvasOnly) return "canvas_legacy";
    return "runtime_admin";
}

function registerCanvasTool(server: McpServer, config: CanvasAgentConfig, name: ToolName) {
    const schema = toolInputSchemas[name];
    const contract = requiredMcpContract(name);
    server.registerTool(name, {
        description: contract.description,
        inputSchema: schema.shape,
        annotations: contract.annotations,
    }, async (input: unknown) => {
        const result = await postCanvasAgentTool(config, name, schema.parse(input));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
}

function requiredMcpContract(name: string) {
    const contract = canonicalMcpToolsByName.get(name);
    if (!contract) throw new Error(`AGENT_MCP_GENERATED_CONTRACT_MISSING:${name}`);
    return contract;
}

function mcpAnnotationsForRisk(risk: AgentToolRisk) {
    const readOnly = risk === "read" || risk === "draft";
    return {
        readOnlyHint: readOnly,
        destructiveHint: risk === "destructive",
        idempotentHint: readOnly,
        openWorldHint: risk === "paid",
    };
}

async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName | "workbench_get_context", input: unknown) {
    const grantHeaders: Record<string, string> = process.env.FILMOS_AGENT_GATEWAY_ENABLED === "true" ? {
        "x-filmos-agent-grant-id": String(process.env.FILMOS_AGENT_GRANT_ID || ""),
        "x-filmos-agent-session-id": String(process.env.FILMOS_AGENT_SESSION_ID || ""),
        "x-filmos-agent-connection-id": String(process.env.FILMOS_AGENT_CONNECTION_ID || ""),
        "x-filmos-agent-project-id": String(process.env.FILMOS_AGENT_PROJECT_ID || ""),
        "x-filmos-agent-grant-nonce": String(process.env.FILMOS_AGENT_GRANT_NONCE || ""),
        "x-filmos-agent-grant-signature": String(process.env.FILMOS_AGENT_GRANT_SIGNATURE || ""),
    } : {};
    const res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token, ...grantHeaders }, body: JSON.stringify({ name, input }) });
    const body = (await res.json()) as CanvasAgentToolResponse;
    if (!body.ok) throw new Error(body.error || "tool call failed");
    return body.result;
}

export { postDreaminaCliTool } from "./modules/dreamina-mcp.js";

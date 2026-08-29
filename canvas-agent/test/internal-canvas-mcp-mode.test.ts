import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import * as agentsModule from "../src/agents.js";
import { AGENT_PROMPT, type CanvasAgentConfig } from "../src/config.js";
import * as mcpServerModule from "../src/mcp-server.js";
import { CanonicalAgentToolManifest } from "../src/brains/tool-manifest.js";

const config: CanvasAgentConfig = {
    url: "http://127.0.0.1:17371",
    token: "fixture-token",
    ownerId: "owner-internal-mcp-fixture-0001",
    trustedWebOrigins: [],
    browserRegistrations: [],
};

type CommandFactory = () => { command: string; args: string[] };
type CodexConfigFactory = (configDir?: string) => {
    mcp_servers: {
        "yingce": {
            command: string;
            args: string[];
            env?: Record<string, string>;
            tool_timeout_sec: number;
        };
    };
};
type RegisterMcpTools = (
    server: { registerTool(name: string, definition: unknown, callback: (...args: never[]) => unknown): void },
    config: CanvasAgentConfig,
    options?: { canvasOnly?: boolean; surface?: "canvas_legacy" | "workbench_operator" | "runtime_admin" },
) => void;

test("internal Canvas Agent MCP command starts the explicit workbench_operator surface", () => {
    const commandFactory = (agentsModule as unknown as { canvasAgentMcpCommand?: CommandFactory }).canvasAgentMcpCommand;
    assert.equal(typeof commandFactory, "function");
    if (!commandFactory) return;
    const command = commandFactory();
    assert.deepEqual(command.args.slice(-3), ["mcp", "--surface", "workbench_operator"]);
    assert.equal(command.args.includes("--canvas-only"), false);
});

test("internal Codex MCP config binds the Runtime directory without an auto-approval override", () => {
    const configFactory = (agentsModule as unknown as { codexConfig?: CodexConfigFactory }).codexConfig;
    assert.equal(typeof configFactory, "function");
    if (!configFactory) return;
    const configDir = path.resolve("fixture-runtime-config-18871");
    const server = configFactory(configDir).mcp_servers["yingce"];
    assert.deepEqual(server.env, {
        FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR: configDir,
        FILMOS_AGENT_GATEWAY_ENABLED: "true",
        FILMOS_AGENT_PROFILE: "codex.subscription",
    });
    assert.equal(server.args.includes("workbench_operator"), true);
    assert.equal("default_tools_approval_mode" in server, false);
    assert.equal(server.args.some((value) => /token|secret/i.test(value)), false);
    assert.equal(Object.keys(server.env ?? {}).some((key) => /token|secret/i.test(key)), false);
});

test("workbench_operator exposes Canvas and Film tools without direct provider bypass", () => {
    const register = (mcpServerModule as unknown as { registerMcpTools?: RegisterMcpTools }).registerMcpTools;
    assert.equal(typeof register, "function");
    if (!register) return;
    const names: string[] = [];
    register({ registerTool(name: string) { names.push(name); } } as never, config, { surface: "workbench_operator", film: { env: {} } } as never);
    assert.equal(names.includes("workbench_get_context"), true);
    assert.equal(names.includes("canvas_get_context"), true);
    assert.equal(names.includes("canvas_generate_image"), true);
    assert.equal(names.includes("film_project_get_context"), true);
    assert.equal(names.includes("film_command_preview"), true);
    assert.equal(names.includes("film_command_apply"), true);
    assert.equal(names.includes("dreamina_cli"), false);
});

test("real MCP listTools exactly matches the canonical workbench manifest", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "workbench-manifest-test", version: "1" });
    mcpServerModule.registerMcpTools(server, config, {
        surface: "workbench_operator",
        film: { gateway: { callTool: async () => ({ ok: true }) } as never },
    });
    const client = new Client({ name: "workbench-manifest-client", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        const actual = (await client.listTools()).tools.map((tool) => tool.name).sort();
        const expected = new CanonicalAgentToolManifest().names("workbench_operator").sort();
        assert.deepEqual(actual, expected);
        assert.equal(actual.includes("workbench_get_context"), true);
        assert.equal(actual.includes("dreamina_cli"), false);
    } finally {
        await client.close();
        await server.close();
    }
});

test("internal MCP tool timeout covers the Canvas generation continuation window", () => {
    const configFactory = (agentsModule as unknown as { codexConfig?: CodexConfigFactory }).codexConfig;
    assert.equal(typeof configFactory, "function");
    if (!configFactory) return;
    const timeoutMs = configFactory().mcp_servers["yingce"].tool_timeout_sec * 1_000;
    assert.ok(timeoutMs >= 35 * 60 * 1_000, `internal MCP timeout ${timeoutMs}ms must cover the 35-minute generation continuation window`);
    assert.ok(timeoutMs > 35 * 60 * 1_000, "internal MCP timeout must leave shutdown/response margin after the Canvas continuation window");
});

test("canvas-only MCP posts Canvas tools to the URL supplied by its loaded Runtime config", async () => {
    const register = (mcpServerModule as unknown as { registerMcpTools?: RegisterMcpTools }).registerMcpTools;
    assert.equal(typeof register, "function");
    if (!register) return;
    let handler: ((input: unknown) => Promise<unknown>) | undefined;
    const server = {
        registerTool(name: string, _definition: unknown, callback: (input: unknown) => Promise<unknown>) {
            if (name === "canvas_get_state") handler = callback;
        },
    };
    const routedConfig = { ...config, url: "http://127.0.0.1:18871" };
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ ok: true, result: { connected: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    try {
        register(server as never, routedConfig, { canvasOnly: true });
        assert.ok(handler);
        await handler!({});
        assert.equal(requestedUrl, "http://127.0.0.1:18871/api/tools");
        assert.equal(requestedUrl.includes(routedConfig.token), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("canvas-only MCP registration exposes Canvas generation tools but not dreamina_cli", () => {
    const register = (mcpServerModule as unknown as { registerMcpTools?: RegisterMcpTools }).registerMcpTools;
    assert.equal(typeof register, "function");
    if (!register) return;
    const names: string[] = [];
    const server = {
        registerTool(name: string) { names.push(name); },
    };
    register(server as never, config, { canvasOnly: true });
    assert.equal(names.includes("dreamina_cli"), false);
    assert.equal(names.includes("canvas_generate_image"), true);
    assert.equal(names.includes("canvas_generate_video"), true);
});

test("ordinary external MCP registration keeps the direct dreamina_cli compatibility tool", () => {
    const register = (mcpServerModule as unknown as { registerMcpTools?: RegisterMcpTools }).registerMcpTools;
    assert.equal(typeof register, "function");
    if (!register) return;
    const names: string[] = [];
    const server = {
        registerTool(name: string) { names.push(name); },
    };
    register(server as never, config);
    assert.equal(names.includes("dreamina_cli"), true);
    assert.equal(names.includes("canvas_generate_image"), true);
    assert.equal(names.includes("canvas_generate_video"), true);
});

test("internal Agent prompt routes named Dreamina requests through shared Canvas generation tools", () => {
    assert.match(AGENT_PROMPT, /即使用户.*Dreamina/i);
    assert.match(AGENT_PROMPT, /canvas_generate_image/);
    assert.match(AGENT_PROMPT, /canvas_generate_video/);
    assert.match(AGENT_PROMPT, /model=local:dreamina-cli:5\.0/i);
    assert.match(AGENT_PROMPT, /quality=auto/i);
    assert.match(AGENT_PROMPT, /禁止.*dreamina_cli/i);
});

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasAgentConfig } from "../src/config.js";
import { filmToolNames } from "../src/film/contracts.js";
import type { FilmAgentGateway } from "../src/film/gateway.js";
import { registerMcpTools } from "../src/mcp-server.js";
import { toolNames as canvasToolNames } from "../src/schemas.js";

const config: CanvasAgentConfig = {
  url: "http://127.0.0.1:17371",
  token: "fixture-token",
  ownerId: "owner-film-mcp-fixture-01",
  trustedWebOrigins: [],
  browserRegistrations: [],
};

type RegisteredTool = {
  definition: Record<string, unknown>;
  callback: (input: unknown, extra: { signal?: AbortSignal }) => Promise<unknown>;
};

function captureRegistration() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      definition: Record<string, unknown>,
      callback: RegisteredTool["callback"],
    ) {
      assert.equal(tools.has(name), false, `duplicate MCP tool: ${name}`);
      tools.set(name, { definition, callback });
    },
  };
  return { server, tools };
}

const generationToolNames = [
  "generation_list_engines",
  "generation_get_engine_status",
  "generation_refresh_catalog",
  "generation_list_models",
  "generation_list_workflows",
  "generation_list_skills",
  "generation_select_effective_route",
  "generation_resolve_route_binding",
  "generation_get_status",
  "generation_reconcile",
  "generation_get_lineage",
  "generation_compile_prompt",
  "generation_preview_submission",
  "generation_create_external_project",
  "generation_submit",
  "generation_cancel",
  "generation_download_outputs",
  "generation_import_candidate",
] as const;

test("shared MCP entry exposes canonical generation tools while canvasOnly stays isolated", () => {
  const ordinary = captureRegistration();
  registerMcpTools(ordinary.server as never, config, { film: { env: {} } });
  assert.deepEqual([...ordinary.tools.keys()], [
    ...canvasToolNames,
    ...generationToolNames,
    "dreamina_cli",
  ]);
  assert.equal(
    [...ordinary.tools.keys()].some((name) => name.startsWith("film_")),
    false,
  );

  const canvasOnly = captureRegistration();
  registerMcpTools(canvasOnly.server as never, config, {
    canvasOnly: true,
    film: { enabled: true },
  });
  assert.deepEqual([...canvasOnly.tools.keys()], [...canvasToolNames]);
});

test("enabling the shared MCP entry adds exactly the five mapped Film tools", async () => {
  const calls: Array<{ name: unknown; input: unknown }> = [];
  const gateway = {
    async callTool(name: unknown, input: unknown) {
      calls.push({ name, input });
      return { source: "film-gateway", name };
    },
  } as FilmAgentGateway;
  const baseline = captureRegistration();
  registerMcpTools(baseline.server as never, config, { film: { env: {} } });
  const enabled = captureRegistration();
  registerMcpTools(enabled.server as never, config, {
    film: { enabled: true, gateway },
  });
  const added = [...enabled.tools.keys()].filter(
    (name) => !baseline.tools.has(name),
  );
  assert.deepEqual(added, [...filmToolNames]);
  assert.equal(added.length, 5);
  assert.equal(
    added.some((name) => /provider|generation|dreamina|flova|comfy/i.test(name)),
    false,
  );
  for (const name of filmToolNames) {
    const definition = enabled.tools.get(name)?.definition;
    assert.ok(definition);
    assert.equal(typeof definition.description, "string");
    assert.equal(typeof definition.annotations, "object");
  }

  const handler = enabled.tools.get("film_entity_get")?.callback;
  assert.ok(handler);
  const result = (await handler!(
    { film_entity_id: "11111111-1111-4111-8111-111111111111" },
    {},
  )) as { content: Array<{ type: string; text: string }> };
  assert.deepEqual(calls, [
    {
      name: "film_entity_get",
      input: { film_entity_id: "11111111-1111-4111-8111-111111111111" },
    },
  ]);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), {
    source: "film-gateway",
    name: "film_entity_get",
  });
});

test("real MCP SDK listTools and callTool expose the enabled Film registration", async () => {
  const gateway = {
    async callTool(name: unknown, input: unknown) {
      return { transport: "mcp-in-memory", name, input };
    },
  } as FilmAgentGateway;
  const server = new McpServer({ name: "film-registration-test", version: "1" });
  registerMcpTools(server, config, {
    film: { enabled: true, gateway },
  });
  const client = new Client({ name: "film-registration-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual(names.slice(-5), [...filmToolNames]);
    assert.deepEqual(
      names.filter((name) => name.startsWith("film_")),
      [...filmToolNames],
    );
    const called = await client.callTool({
      name: "film_entity_get",
      arguments: {
        film_entity_id: "11111111-1111-4111-8111-111111111111",
      },
    });
    assert.equal(called.content[0]?.type, "text");
    if (called.content[0]?.type !== "text") return;
    assert.deepEqual(JSON.parse(called.content[0].text), {
      transport: "mcp-in-memory",
      name: "film_entity_get",
      input: { film_entity_id: "11111111-1111-4111-8111-111111111111" },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import { CANONICAL_AGENT_TOOL_METADATA } from "../../../canvas-agent/src/brains/tool-manifest-source.js";
import { filmToolInputSchemas } from "../../../canvas-agent/src/film/contracts.js";
import { toolInputSchemas } from "../../../canvas-agent/src/schemas.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = resolve(root, "generated");
const check = process.argv.includes("--check");
await mkdir(generatedDir, { recursive: true });

const auxiliarySchemas: Record<string, Record<string, unknown>> = {
  workbench_get_context: { type: "object", properties: {}, additionalProperties: false },
  chatgpt_prepare_handoff: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, maxLength: 20_000 },
      note: { type: "string", maxLength: 4_000 },
    },
    required: ["task"],
    additionalProperties: false,
  },
  dreamina_cli: {
    type: "object",
    properties: {
      operation: { type: "string", minLength: 1 },
      input: { type: "object", additionalProperties: true },
    },
    required: ["operation", "input"],
    additionalProperties: false,
  },
  ...Object.fromEntries([
    "generation_list_engines", "generation_get_engine_status", "generation_refresh_catalog", "generation_list_models",
    "generation_list_workflows", "generation_list_skills", "generation_select_effective_route", "generation_resolve_route_binding",
    "generation_compile_prompt", "generation_preview_submission", "generation_create_external_project", "generation_submit",
    "generation_get_status", "generation_reconcile", "generation_cancel", "generation_download_outputs",
    "generation_import_candidate", "generation_get_lineage",
  ].map((name) => [name, generationSchema(name)])),
};

const tools = CANONICAL_AGENT_TOOL_METADATA.map((metadata) => {
  const zodSchema = toolInputSchemas[metadata.name as keyof typeof toolInputSchemas]
    ?? filmToolInputSchemas[metadata.name as keyof typeof filmToolInputSchemas];
  const inputSchema = zodSchema
    ? withoutSchemaMarker(zodToJsonSchema(zodSchema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>)
    : auxiliarySchemas[metadata.name];
  if (!inputSchema) throw new Error(`AGENT_TOOL_SCHEMA_MISSING:${metadata.name}`);
  const normalizedSchema = sortValue(inputSchema);
  return {
    name: metadata.name,
    title: metadata.title,
    description: metadata.description,
    risk: metadata.risk,
    surfaces: [...metadata.surfaces].sort(),
    provider: metadata.provider,
    requires_fresh_context: metadata.requiresFreshContext,
    may_create_charges: metadata.mayCreateCharges,
    input_schema: normalizedSchema,
    input_schema_hash: sha256(canonical(normalizedSchema)),
  };
}).sort((left, right) => left.name.localeCompare(right.name));

const contractBody = {
  schema_version: "1.0.0",
  contract_id: "filmos-agent-canonical-tools",
  source_contracts: {
    canvas_project: "canvas-agent/src/schemas.ts",
    film_core: "canvas-agent/src/film/contracts.ts",
    risk_surface: "canvas-agent/src/brains/tool-manifest.ts",
  },
  tools,
};
const contract = { ...contractBody, contract_hash: sha256(canonical(contractBody)) };
const modelApiTools = tools
  .filter((tool) => tool.surfaces.includes("workbench_operator"))
  .map((tool) => ({
    risk: tool.risk,
    tool: {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        strict: tool.input_schema.additionalProperties === false,
      },
    },
  }));
const mcpTools = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.input_schema,
  annotations: {
    readOnlyHint: tool.risk === "read" || tool.risk === "draft",
    destructiveHint: tool.risk === "destructive",
    idempotentHint: tool.risk === "read" || tool.risk === "draft",
    openWorldHint: tool.risk === "paid",
  },
}));

const outputs = new Map<string, string>([
  ["canonical-tools.json", `${JSON.stringify(contract, null, 2)}\n`],
  ["canonical-tools.ts", typescript("canonicalAgentToolContract", contract, [
    "export type CanonicalAgentToolContract = typeof canonicalAgentToolContract.tools[number];",
    "export const canonicalAgentTools = canonicalAgentToolContract.tools;",
    "export const canonicalAgentToolsByName = new Map(canonicalAgentTools.map((tool) => [tool.name, tool]));",
  ])],
  ["model-api-tools.ts", typescript("canonicalModelApiToolManifest", modelApiTools, [
    "export const canonicalModelApiTools = canonicalModelApiToolManifest.map((entry) => entry.tool);",
    "export const canonicalModelApiReadToolNames = new Set(canonicalModelApiToolManifest.filter((entry) => entry.risk === 'read' || entry.risk === 'draft').map((entry) => entry.tool.function.name));",
  ])],
  ["mcp-tools.ts", typescript("canonicalMcpTools", mcpTools)],
]);

for (const [name, expected] of outputs) {
  const target = resolve(generatedDir, name);
  if (check) {
    const actual = await readFile(target, "utf8");
    if (actual !== expected) throw new Error(`AGENT_TOOL_CONTRACT_GENERATED_OUTPUT_STALE:${name}`);
  } else {
    await writeFile(target, expected);
  }
}

function typescript(name: string, value: unknown, suffix: string[] = []) {
  return `// Generated by scripts/generate.ts. Do not edit.\nexport const ${name} = ${JSON.stringify(value, null, 2)} as const;\n${suffix.join("\n")}\n`;
}

function withoutSchemaMarker(value: Record<string, unknown>) {
  const { $schema: _schema, ...schema } = value;
  return schema;
}

function generationSchema(name: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    projectId: { type: "string", minLength: 1, maxLength: 256 },
    engineId: { type: "string", minLength: 1, maxLength: 64 },
    connectionId: { type: "string", minLength: 1, maxLength: 128 },
    taskKind: { type: "string", minLength: 1, maxLength: 64 },
    modelId: { type: "string", minLength: 1, maxLength: 256 },
    workflowId: { type: "string", minLength: 1, maxLength: 256 },
    skillId: { type: "string", minLength: 1, maxLength: 256 },
    routeSnapshotId: { type: "string", minLength: 1, maxLength: 256 },
    generationAttemptId: { type: "string", minLength: 1, maxLength: 256 },
    providerTaskId: { type: "string", minLength: 1, maxLength: 256 },
    authorizedSubmissionId: { type: "string", minLength: 1, maxLength: 256 },
    input: { type: "object", additionalProperties: true },
  };
  const requirements: Record<string, string[]> = {
    generation_get_engine_status: ["engineId", "connectionId"], generation_refresh_catalog: ["engineId", "connectionId"],
    generation_list_models: ["engineId", "connectionId"], generation_list_workflows: ["engineId", "connectionId"], generation_list_skills: ["engineId", "connectionId"],
    generation_select_effective_route: ["projectId", "taskKind"], generation_resolve_route_binding: ["projectId", "taskKind", "input"],
    generation_compile_prompt: ["projectId", "taskKind", "input"], generation_preview_submission: ["routeSnapshotId"],
    generation_create_external_project: ["engineId", "connectionId", "input"], generation_submit: ["authorizedSubmissionId"],
    generation_get_status: ["engineId", "connectionId", "providerTaskId"], generation_reconcile: ["engineId", "connectionId", "providerTaskId"],
    generation_cancel: ["engineId", "connectionId", "providerTaskId"], generation_download_outputs: ["engineId", "connectionId", "providerTaskId"],
    generation_import_candidate: ["generationAttemptId", "input"], generation_get_lineage: ["generationAttemptId"],
  };
  return { type: "object", properties, required: requirements[name] || [], additionalProperties: false };
}

function canonical(value: unknown) {
  return JSON.stringify(sortValue(value));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
}

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalAgentToolContract, canonicalAgentTools } from "../dist/canonical-tools.js";
import { canonicalMcpTools } from "../dist/mcp-tools.js";
import { canonicalModelApiToolManifest } from "../dist/model-api-tools.js";

test("canonical MCP and Model API views preserve the source schema hash and risk", () => {
  assert.equal(canonicalAgentToolContract.contract_hash.length, 64);
  assert.equal(new Set(canonicalAgentTools.map((tool) => tool.name)).size, canonicalAgentTools.length);
  for (const tool of canonicalAgentTools) {
    assert.equal(tool.input_schema_hash.length, 64, tool.name);
    assert.deepEqual(canonicalMcpTools.find((candidate) => candidate.name === tool.name)?.inputSchema, tool.input_schema, tool.name);
    const model = canonicalModelApiToolManifest.find((candidate) => candidate.tool.function.name === tool.name);
    if (tool.surfaces.includes("workbench_operator")) {
      assert.deepEqual(model?.tool.function.parameters, tool.input_schema, tool.name);
      assert.equal(model?.risk, tool.risk, tool.name);
    } else {
      assert.equal(model, undefined, tool.name);
    }
  }
});

test("generated schemas are real JSON Schema rather than validator placeholders", () => {
  for (const tool of canonicalAgentTools) {
    assert.equal("x-filmos-validator" in tool.input_schema, false, tool.name);
    assert.equal(tool.input_schema.type, "object", tool.name);
  }
});

test("canonical generation tools share one broker contract and ChatGPT excludes external writes and paid submit", () => {
  const required = ["generation_list_engines", "generation_get_engine_status", "generation_refresh_catalog", "generation_list_models", "generation_list_workflows", "generation_list_skills", "generation_select_effective_route", "generation_resolve_route_binding", "generation_compile_prompt", "generation_preview_submission", "generation_create_external_project", "generation_submit", "generation_get_status", "generation_reconcile", "generation_cancel", "generation_download_outputs", "generation_import_candidate", "generation_get_lineage"];
  const byName = new Map(canonicalAgentTools.map((tool) => [tool.name, tool]));
  assert.deepEqual(required.filter((name) => !byName.has(name)), []);
  for (const name of ["generation_create_external_project", "generation_submit", "generation_cancel", "generation_download_outputs", "generation_import_candidate"]) {
    assert.equal(byName.get(name).surfaces.includes("chatgpt_hosted"), false, name);
  }
  assert.equal(byName.get("generation_submit").risk, "paid");
  assert.equal(byName.get("generation_preview_submission").risk, "draft");
});

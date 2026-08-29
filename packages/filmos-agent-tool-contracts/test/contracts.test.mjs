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

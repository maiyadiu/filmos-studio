import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contract = JSON.parse(await readFile(new URL("../contract.v1.json", import.meta.url), "utf8"));

test("v1 exposes the exact standard search/fetch shapes", () => {
  const search = contract.tools.find((tool) => tool.name === "search");
  const fetch = contract.tools.find((tool) => tool.name === "fetch");
  assert.deepEqual(search.required, ["query"]);
  assert.deepEqual(Object.keys(search.input), ["query"]);
  assert.deepEqual(fetch.required, ["id"]);
  assert.deepEqual(Object.keys(fetch.input), ["id"]);
});

test("all public tools are read-only and reserved writes are not public", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../generated/mcp-tools.v1.json", import.meta.url), "utf8"));
  const publicNames = new Set(snapshot.tools.map((tool) => tool.name));
  assert.equal(snapshot.tools.length, 20);
  for (const tool of snapshot.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  for (const name of snapshot.reserved_write_tools) assert.equal(publicNames.has(name), false);
});

test("contract includes seven versioned widget resources", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../generated/mcp-tools.v1.json", import.meta.url), "utf8"));
  const widgets = snapshot.tools.flatMap((tool) => tool.widget ? [tool.widget] : []);
  assert.equal(new Set(widgets).size, 7);
  assert.ok(widgets.every((uri) => uri.endsWith("-v1.html")));
  assert.ok(snapshot.tools.filter((tool) => tool.name.startsWith("filmos_get_")).every((tool) => !tool.widget));
  assert.ok(snapshot.tools.filter((tool) => tool.widget).every((tool) => tool.name.startsWith("filmos_render_")));
  assert.equal(snapshot.tools.find((tool) => tool.name === "filmos_prepare_proposal_export").annotations.idempotentHint, false);
});

test("OpenAPI, TypeScript source snapshot, and MCP snapshot keep identical tool fields", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../generated/mcp-tools.v1.json", import.meta.url), "utf8"));
  const openapi = JSON.parse(await readFile(new URL("../generated/openapi.v1.json", import.meta.url), "utf8"));
  for (const tool of snapshot.tools) {
    const operation = openapi.paths[`/tools/${tool.name}`].post;
    assert.equal(operation.operationId, tool.name);
    assert.deepEqual(operation.requestBody.content["application/json"].schema, tool.input_schema);
    assert.deepEqual(operation["x-filmos-annotations"], tool.annotations);
    assert.equal(operation["x-filmos-widget"], tool.widget ?? null);
  }
});

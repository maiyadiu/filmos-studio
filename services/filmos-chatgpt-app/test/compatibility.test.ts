import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { filmosToolContract } from "@filmos/tool-contracts";

import { classifyToolCompatibility, type FrozenToolSnapshot } from "../src/compatibility.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frozen = JSON.parse(await readFile(resolve(root, "compat/tool-contract-v1.snapshot.json"), "utf8")) as FrozenToolSnapshot;

test("current Tool Contract remains compatible with the frozen v1 ChatGPT installation snapshot", () => {
  assert.equal(classifyToolCompatibility(filmosToolContract, frozen), "CURRENT");
});

test("additive tools are backward compatible but removed or narrowed v1 tools require migration", () => {
  const additive = structuredClone(filmosToolContract) as any;
  additive.tools.push({ name: "future_read_tool", input_schema: { type: "object", properties: {}, required: [] } });
  assert.equal(classifyToolCompatibility(additive, frozen), "BACKWARD_COMPATIBLE");

  const removed = structuredClone(filmosToolContract) as any;
  removed.tools = removed.tools.filter((tool: any) => tool.name !== "fetch");
  assert.equal(classifyToolCompatibility(removed, frozen), "MIGRATION_REQUIRED");

  const narrowed = structuredClone(filmosToolContract) as any;
  narrowed.tools.find((tool: any) => tool.name === "filmos_get_review_queue").input_schema.required = ["limit"];
  assert.equal(classifyToolCompatibility(narrowed, frozen), "MIGRATION_REQUIRED");
});

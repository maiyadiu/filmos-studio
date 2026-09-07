import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CONTRACT_SCHEMA_VERSION, BUILTIN_BRAIN_PROFILE_IDS, assertAgentWorkbenchScope, toolsForWorkbenchScope } from "../dist/index.js";

test("shared contract exposes stable schema and built-in profile ids", () => {
  assert.equal(AGENT_CONTRACT_SCHEMA_VERSION, "1");
  assert.equal(BUILTIN_BRAIN_PROFILE_IDS.codexSubscription, "codex.subscription");
  assert.equal(BUILTIN_BRAIN_PROFILE_IDS.chatgptHosted, "chatgpt.subscription.host");
});

test("project pages have explicit null canvas and fail closed for unknown or canvas tools", () => {
  const scope = { projectId: "project-1", domainProjectId: "project-1", canvasId: null };
  const names = ["workbench_get_context", "project_get_script", "project_revise_script", "project_sync_storyboard", "canvas_get_state", "film_command_apply", "future_tool"];
  assert.deepEqual(toolsForWorkbenchScope(names, scope), names.slice(0, 3));
  assert.deepEqual(toolsForWorkbenchScope(names, { projectId: "canvas-1", canvasId: "canvas-1" }), names);
  assert.doesNotThrow(() => assertAgentWorkbenchScope(scope));
  for (const patch of [{ projectId: "" }, { domainProjectId: undefined }, { domainProjectId: "other" }, { canvasId: "" }, { canvasId: undefined }]) {
    assert.throws(() => assertAgentWorkbenchScope({ ...scope, ...patch }), /AGENT_CONTEXT_/);
  }
});

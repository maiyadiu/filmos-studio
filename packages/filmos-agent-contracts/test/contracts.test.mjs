import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CONTRACT_SCHEMA_VERSION, BUILTIN_BRAIN_PROFILE_IDS } from "../dist/index.js";

test("shared contract exposes stable schema and built-in profile ids", () => {
  assert.equal(AGENT_CONTRACT_SCHEMA_VERSION, "1");
  assert.equal(BUILTIN_BRAIN_PROFILE_IDS.codexSubscription, "codex.subscription");
  assert.equal(BUILTIN_BRAIN_PROFILE_IDS.chatgptHosted, "chatgpt.subscription.host");
});

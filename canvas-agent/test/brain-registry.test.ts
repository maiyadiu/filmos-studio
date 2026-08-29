import assert from "node:assert/strict";
import test from "node:test";

import { BrainProfileRegistry } from "../src/brains/registry.js";
import { adapter, profile } from "./brain-test-fixtures.js";

test("registry keeps profile and adapter identity aligned", async () => {
    const registry = new BrainProfileRegistry();
    registry.registerProfile(profile("codex.mock"));
    registry.registerAdapter(adapter("codex.mock"));

    assert.equal(registry.getProfile("codex.mock").provider, "openai.codex");
    assert.equal((await registry.probe("codex.mock")).status, "ready");
    assert.throws(() => registry.registerAdapter(adapter("api.mock")), /not registered/);
});

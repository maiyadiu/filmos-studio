import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_FEATURE_FLAG_IDS, assertGenericAgentRuntimeDependencies, resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { normalizeLocalRuntimeConfig } from "../src/config.js";

test("all native Agent feature flags are default-off on integration", () => {
    const flags = resolveAgentFeatureFlags({}, {});
    assert.equal(AGENT_FEATURE_FLAG_IDS.length, 10);
    assert.equal(Object.values(flags).every((enabled) => enabled === false), true);
});

test("generic runtime refuses a partial safety dependency set", () => {
    const incomplete = resolveAgentFeatureFlags({ "film.agent_generic_runtime": true }, {});
    assert.throws(() => assertGenericAgentRuntimeDependencies(incomplete), /AGENT_FEATURE_DEPENDENCIES_DISABLED/);
    const complete = resolveAgentFeatureFlags(Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map((id) => [id, true])), {});
    assert.doesNotThrow(() => assertGenericAgentRuntimeDependencies(complete));
});

test("runtime config preserves only declared boolean flags and environment can explicitly override", () => {
    const config = normalizeLocalRuntimeConfig({
        url: "http://127.0.0.1:17371",
        token: "test-token",
        trustedWebOrigins: ["http://127.0.0.1:3000"],
        browserRegistrations: [],
        agentFeatureFlags: { "film.agent_generic_runtime": true, "unknown.flag": true, "film.agent_context_broker": "true" },
    });
    assert.deepEqual(config.agentFeatureFlags, { "film.agent_generic_runtime": true });
    assert.equal(resolveAgentFeatureFlags(config.agentFeatureFlags, { FILMOS_AGENT_GENERIC_RUNTIME: "false" })["film.agent_generic_runtime"], false);
});

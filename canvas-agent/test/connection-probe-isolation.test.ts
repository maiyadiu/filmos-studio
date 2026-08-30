import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeAdapter } from "../src/brains/contracts.js";
import { probeConnectionList } from "../src/brains/generic-agent-runtime.js";
import { BUILTIN_BRAIN_PROFILES, registerBuiltinBrainProfiles } from "../src/brains/profiles.js";
import { BrainProfileRegistry } from "../src/brains/registry.js";

test("all seven profile probes stay isolated and one failure does not reject the matrix", async () => {
    const registry = new BrainProfileRegistry();
    const profileIds = BUILTIN_BRAIN_PROFILES.map((profile) => profile.id);
    const operations: string[] = [];
    registerBuiltinBrainProfiles(registry, new Set(profileIds));
    for (const profileId of profileIds) registry.registerAdapter(probeOnlyAdapter(profileId, operations, profileId === "anthropic.api"));

    const connections = await probeConnectionList(registry);
    assert.equal(connections.length, 7);
    assert.deepEqual(connections.map((item) => item.profile.id), profileIds);
    assert.equal(connections.find((item) => item.profile.id === "anthropic.api")?.status.status, "error");
    assert.equal(connections.filter((item) => item.status.status === "ready").length, 6);
    assert.deepEqual(operations, profileIds.map((profileId) => `probe:${profileId}`));
    assert.equal(operations.some((entry) => /send|create|resume|api_request|generation/u.test(entry)), false);

    console.log("FILMOS_AGENT_CONNECTION_PROBE_RECEIPT", JSON.stringify({
        gate_id: "AGENT-CONNECTION-PROBE-ISOLATION-001",
        status: "PASSED",
        profile_count: connections.length,
        profile_ids: profileIds,
        isolated_error_profile: "anthropic.api",
        provider_request_count: 0,
        paid_generation_count: 0,
    }));
});

function probeOnlyAdapter(profileId: string, operations: string[], fail: boolean): AgentRuntimeAdapter {
    return {
        connectionId: profileId,
        profileId,
        probe: async () => {
            operations.push(`probe:${profileId}`);
            if (fail) throw new Error(`PROBE_FAILURE:${profileId}`);
            return { profileId, status: "ready", checkedAt: "2099-01-01T00:00:00.000Z" };
        },
        createSession: async () => { throw new Error("PROBE_MUST_NOT_CREATE_SESSION"); },
        resumeSession: async () => { throw new Error("PROBE_MUST_NOT_RESUME_SESSION"); },
        sendTurn: async () => { throw new Error("PROBE_MUST_NOT_SEND_TURN"); },
        cancelTurn: async () => { throw new Error("PROBE_MUST_NOT_CANCEL_TURN"); },
        closeSession: async () => { throw new Error("PROBE_MUST_NOT_CLOSE_SESSION"); },
    };
}

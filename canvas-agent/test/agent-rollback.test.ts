import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { rollbackNativeMultibrain } from "../scripts/rollback-native-multibrain.mjs";

test("rollback disables only native flags and preserves legacy Thread, API, Tunnel and unrelated data", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-agent-rollback-"));
    const configPath = path.join(directory, "canvas-agent.json");
    const original = {
        url: "http://127.0.0.1:17371",
        token: "local-master-token",
        canvases: { "canvas-a": { workspacePath: "/tmp/workspace", activeThreadId: "legacy-thread" } },
        apiSettings: { channelId: "preserve-api-channel" },
        tunnelID: "preserve-tunnel-id",
        agentFeatureFlags: { "film.agent_generic_runtime": true },
    };
    try {
        fs.writeFileSync(configPath, JSON.stringify(original), { mode: 0o600 });
        const dryRun = rollbackNativeMultibrain(configPath, false);
        assert.equal(dryRun.applied, false);
        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), original);

        const applied = rollbackNativeMultibrain(configPath, true);
        const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
        assert.equal(applied.applied, true);
        assert.equal(next.canvases["canvas-a"].activeThreadId, "legacy-thread");
        assert.deepEqual(next.apiSettings, original.apiSettings);
        assert.equal(next.tunnelID, original.tunnelID);
        assert.equal(Object.values(next.agentFeatureFlags).every((value) => value === false), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(`${configPath}.pre-native-multibrain-rollback.json`, "utf8")), original);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

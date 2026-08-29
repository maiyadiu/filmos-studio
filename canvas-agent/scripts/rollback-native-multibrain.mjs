#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const flagIds = [
    "film.agent_native_brain_selector",
    "film.agent_generic_runtime",
    "film.agent_context_broker",
    "film.agent_canonical_tool_manifest",
    "film.agent_canonical_tool_broker",
    "film.agent_codex_subscription",
    "film.agent_chatgpt_host",
    "film.agent_model_api_profiles",
    "film.agent_no_silent_api_fallback",
    "film.agent_request_scoped_identity",
];

export function rollbackNativeMultibrain(configPath, apply = false) {
    if (!path.isAbsolute(configPath)) throw new Error("--config must be an absolute path");
    const source = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(source);
    const next = { ...config, agentFeatureFlags: { ...(config.agentFeatureFlags || {}) } };
    for (const id of flagIds) next.agentFeatureFlags[id] = false;
    const result = {
        applied: apply,
        configPath,
        flagsDisabled: flagIds,
        preserved: ["canvases.activeThreadId", "brain-sessions.v1.json", "API/channel settings", "Tunnel ID", "Keychain Runtime Key"],
    };
    if (!apply) return result;
    const backupPath = `${configPath}.pre-native-multibrain-rollback.json`;
    if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, source, { mode: 0o600, flag: "wx" });
    const temporary = `${configPath}.${process.pid}.rollback.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, configPath);
    fs.chmodSync(configPath, 0o600);
    return { ...result, backupPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const configIndex = process.argv.indexOf("--config");
    if (configIndex < 0 || !process.argv[configIndex + 1]) {
        process.stderr.write("Usage: rollback-native-multibrain.mjs --config /absolute/path/canvas-agent.json [--apply]\n");
        process.exitCode = 2;
    } else {
        process.stdout.write(`${JSON.stringify(rollbackNativeMultibrain(process.argv[configIndex + 1], process.argv.includes("--apply")), null, 2)}\n`);
    }
}

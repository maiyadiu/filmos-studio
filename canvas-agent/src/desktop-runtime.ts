#!/usr/bin/env node
import { loadConfig, saveConfig } from "./config.js";
import { createDefaultLocalRuntimeModules } from "./local-runtime-host.js";
import { startLocalRuntimeServer } from "./local-runtime-server.js";

const config = loadConfig(true);
const runtime = startLocalRuntimeServer({
    config,
    modules: createDefaultLocalRuntimeModules(config),
    persistConfig: saveConfig,
});

await runtime.ready;
let closing = false;
const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void close().finally(() => process.exit(0)));
}

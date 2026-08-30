#!/usr/bin/env node
import path from "node:path";

import { CONFIG_DIR, ensureRuntimeOwnerId, loadConfig, saveConfig } from "./config.js";
import { startLocalRuntimeServer } from "./local-runtime-server.js";
import { createCanvasAgentHttpModule } from "./modules/canvas-agent-http.js";
import { createDreaminaHttpModule } from "./modules/dreamina-http.js";

const config = loadConfig(true);
const runtime = startLocalRuntimeServer({
    config,
    modules: [
        createCanvasAgentHttpModule(config),
        createDreaminaHttpModule({
            ownerId: ensureRuntimeOwnerId(config),
            configDir: CONFIG_DIR,
            referenceRoots: () => [
                path.join(CONFIG_DIR, "codex-workspaces"),
                ...Object.values(config.canvases ?? {}).map((canvas) => canvas.workspacePath),
            ],
        }),
    ],
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

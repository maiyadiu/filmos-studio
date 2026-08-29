import path from "node:path";

import {
    CONFIG_DIR,
    ensureRuntimeOwnerId,
    loadConfig,
    saveConfig,
    type LocalRuntimeConfig,
} from "./config.js";
import type { LocalRuntimeModule } from "./local-runtime.js";
import { startLocalRuntimeServer } from "./local-runtime-server.js";
import { createCanvasAgentHttpModule } from "./modules/canvas-agent-http.js";
import { createDreaminaHttpModule } from "./modules/dreamina-http.js";
import { createPortraitClearanceHttpModule } from "./modules/portrait-clearance-http.js";

export type StartLocalRuntimeOptions = {
    config?: LocalRuntimeConfig;
    modules?: readonly LocalRuntimeModule[];
    port?: number;
    log?: (line: string) => void;
    persistConfig?: (config: LocalRuntimeConfig) => void;
};

export function createDefaultLocalRuntimeModules(config: LocalRuntimeConfig): LocalRuntimeModule[] {
    return [
        createCanvasAgentHttpModule(config),
        createDreaminaHttpModule({
            ownerId: ensureRuntimeOwnerId(config),
            configDir: CONFIG_DIR,
            referenceRoots: () => [
                path.join(CONFIG_DIR, "codex-workspaces"),
                ...Object.values(config.canvases ?? {}).map((canvas) => canvas.workspacePath),
            ],
        }),
        createPortraitClearanceHttpModule({ ownerId: ensureRuntimeOwnerId(config), configDir: CONFIG_DIR }),
    ];
}

export function startLocalRuntime(options: StartLocalRuntimeOptions = {}) {
    const config = options.config ?? loadConfig(true);
    const persistConfig = options.persistConfig ?? saveConfig;
    const modules = [...(options.modules ?? createDefaultLocalRuntimeModules(config))];
    const runtime = startLocalRuntimeServer({ config, modules, persistConfig, port: options.port, log: options.log });
    (options.log ?? console.log)("Codex MCP: codex mcp add yingce -- npx -y @ddcat666/open-ai-canvas-agent mcp");
    return runtime;
}

import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CONFIG_DIR, type LocalRuntimeConfig } from "../config.js";
import { JsonlFilmAgentAuditSink } from "./audit.js";
import { filmToolAnnotations, filmToolDescriptions, filmToolInputSchemas, filmToolNames, type FilmActorKind } from "./contracts.js";
import { FilmAgentGateway } from "./gateway.js";
import { CanvasAgentObservationSource, filmAgentGatewayEnabled, filmCoreBaseUrl, HttpFilmCoreTransport } from "./http.js";

export type FilmAgentMcpOptions = {
    enabled?: boolean;
    gateway?: FilmAgentGateway;
    env?: NodeJS.ProcessEnv;
};

export function registerFilmAgentMcp(
    server: McpServer,
    config: Pick<LocalRuntimeConfig, "url" | "token">,
    options: FilmAgentMcpOptions = {},
) {
    const env = options.env ?? process.env;
    const enabled = options.enabled ?? filmAgentGatewayEnabled(env);
    if (!enabled) return { enabled: false, registered: [] as string[] };
    const gateway = options.gateway ?? new FilmAgentGateway({
        identity: filmIdentity(env),
        transport: new HttpFilmCoreTransport(filmCoreBaseUrl(env)),
        canvas: new CanvasAgentObservationSource(config),
        audit: new JsonlFilmAgentAuditSink(path.join(CONFIG_DIR, "film-agent", "audit.jsonl")),
    });
    for (const name of filmToolNames) {
        const schema = filmToolInputSchemas[name];
        server.registerTool(name, {
            description: filmToolDescriptions[name],
            inputSchema: schema.shape,
            annotations: filmToolAnnotations[name],
        }, async (input: unknown, extra: { signal?: AbortSignal }) => {
            const result = await gateway.callTool(name, schema.parse(input), extra.signal);
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        });
    }
    return { enabled: true, registered: [...filmToolNames] };
}

function filmIdentity(env: NodeJS.ProcessEnv) {
    const mode = env.FILMOS_AGENT_MODE === "human_only" ? "human_only" as const : "agent" as const;
    const actorKind: FilmActorKind = mode === "human_only" ? "human" : parseAgentActorKind(env.FILMOS_AGENT_ACTOR_KIND);
    return {
        mode,
        actorKind,
        actorId: (env.FILMOS_AGENT_ACTOR_ID || `${actorKind}-mcp`).trim(),
    };
}

function parseAgentActorKind(value: string | undefined): Exclude<FilmActorKind, "human"> {
    if (value === "deepseek" || value === "claude" || value === "local_model" || value === "system") return value;
    return "codex";
}

import path from "node:path";

import { CONFIG_DIR } from "../config.js";
import { JsonlFilmAgentAuditSink } from "../film/audit.js";
import type { FilmActorKind } from "../film/contracts.js";
import { FilmAgentGateway } from "../film/gateway.js";
import { filmCoreBaseUrl, HttpFilmCoreTransport } from "../film/http.js";
import type { BrowserRuntimeTransport } from "./browser-runtime-port.js";
import type { BrainProfile, BrainSession } from "./contracts.js";
import type { WorkbenchContextSnapshot } from "./context-broker.js";
import type { CanonicalAgentToolProvider } from "./tool-broker.js";
import { CanonicalAgentToolManifest } from "./tool-manifest.js";

export type CanonicalCanvasToolExecutor = {
    callTool(name: unknown, input: unknown, metadata?: CanonicalToolExecutionMetadata): Promise<unknown>;
};

export type CanonicalToolExecutionMetadata = {
    canonicalRequestId: string;
    canonicalSessionId: string;
    canonicalContextReceiptId: string;
};

abstract class BrowserBackedToolProvider implements CanonicalAgentToolProvider {
    constructor(protected readonly executor: CanonicalCanvasToolExecutor) {}

    async execute({ request, manifest, session }: Parameters<CanonicalAgentToolProvider["execute"]>[0]) {
        const output = await this.executor.callTool(manifest.name, request.input, {
            canonicalRequestId: request.requestId,
            canonicalSessionId: session.id,
            canonicalContextReceiptId: request.contextReceiptId,
        });
        return {
            output,
            ...(["read", "draft"].includes(manifest.risk) ? {} : { postcondition: browserPostcondition(output) }),
        };
    }

    async verifyPostcondition({ postcondition }: Parameters<NonNullable<CanonicalAgentToolProvider["verifyPostcondition"]>>[0]) {
        return postcondition.verified === true;
    }
}

export class CanvasToolProvider extends BrowserBackedToolProvider {}
export class ProjectToolProvider extends BrowserBackedToolProvider {}
export class GenerationToolProvider extends BrowserBackedToolProvider {}

export class WorkbenchContextToolProvider implements CanonicalAgentToolProvider {
    constructor(private readonly snapshot: () => WorkbenchContextSnapshot) {}
    async execute() { return { output: this.snapshot() }; }
}

export class FilmCoreToolProvider implements CanonicalAgentToolProvider {
    private readonly gateways = new Map<string, FilmAgentGateway>();

    constructor(private readonly snapshot: () => WorkbenchContextSnapshot) {}

    async execute({ request, manifest, session, profile }: Parameters<CanonicalAgentToolProvider["execute"]>[0]) {
        const gateway = this.gateway(session, profile);
        const output = await gateway.callTool(manifest.name, request.input);
        return {
            output,
            ...(["read", "draft"].includes(manifest.risk) ? {} : { postcondition: { verified: true, provider: "film_core", requestId: request.requestId } }),
        };
    }

    async verifyPostcondition({ postcondition }: Parameters<NonNullable<CanonicalAgentToolProvider["verifyPostcondition"]>>[0]) {
        return postcondition.verified === true && postcondition.provider === "film_core";
    }

    private gateway(session: BrainSession, profile: BrainProfile) {
        const current = this.gateways.get(session.id);
        if (current) return current;
        const gateway = new FilmAgentGateway({
            identity: {
                actorKind: filmActorKind(profile.id),
                actorId: session.id,
                ...(profile.id === "human.only" ? { mode: "human_only" as const, formalApplyPolicy: "human_only" as const } : { mode: "agent" as const, formalApplyPolicy: "human_only" as const }),
            },
            transport: new HttpFilmCoreTransport(filmCoreBaseUrl()),
            canvas: { current: async () => ({ revision: this.snapshot().canvasRevision, stateHash: this.snapshot().canvasStateHash }) },
            audit: new JsonlFilmAgentAuditSink(path.join(CONFIG_DIR, "film-agent", `${session.id}.jsonl`)),
        });
        this.gateways.set(session.id, gateway);
        return gateway;
    }
}

export class ChatGPTHandoffToolProvider implements CanonicalAgentToolProvider {
    constructor(private readonly browserRuntime: BrowserRuntimeTransport) {}
    async execute({ request, session }: Parameters<CanonicalAgentToolProvider["execute"]>[0]) {
        const output = await this.browserRuntime.request({
            channel: "chatgpt_host",
            operation: "prepare_handoff",
            profileId: session.brainProfileId,
            sessionId: session.id,
            turnId: request.turnId,
            payload: { input: request.input, contextReceiptId: request.contextReceiptId },
        });
        return { output };
    }
}

export function registerProductionToolProviders(input: {
    broker: { register(toolName: string, provider: CanonicalAgentToolProvider): void };
    manifest: CanonicalAgentToolManifest;
    canvas: CanonicalCanvasToolExecutor;
    snapshot: () => WorkbenchContextSnapshot;
    browserRuntime: BrowserRuntimeTransport;
}) {
    const providers = {
        runtime: new WorkbenchContextToolProvider(input.snapshot),
        canvas: new CanvasToolProvider(input.canvas),
        host_project: new ProjectToolProvider(input.canvas),
        film_core: new FilmCoreToolProvider(input.snapshot),
        generation: new GenerationToolProvider(input.canvas),
        chatgpt_handoff: new ChatGPTHandoffToolProvider(input.browserRuntime),
    } as const;
    for (const tool of input.manifest.list()) {
        const provider = providers[tool.provider as keyof typeof providers];
        if (!provider) continue;
        input.broker.register(tool.name, provider);
    }
    return providers;
}

function browserPostcondition(output: unknown) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return { verified: false };
    const record = output as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined;
    const verification = (data?.verification ?? record.verification) as Record<string, unknown> | undefined;
    const verified = record.ok !== false && (verification ? verification.ok !== false : true);
    return { verified, providerReceipt: data?.receipt ?? record.receipt ?? null };
}

function filmActorKind(profileId: string): FilmActorKind {
    if (profileId === "codex.subscription") return "codex";
    if (profileId === "anthropic.api") return "claude";
    if (profileId === "deepseek.api") return "deepseek";
    if (profileId === "local.model") return "local_model";
    if (profileId === "human.only") return "human";
    return "system";
}

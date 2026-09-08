import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import { CanvasSession } from "../../src/canvas-session.js";
import type { LocalRuntimeConfig } from "../../src/config.js";
import { createCanvasAgentHttpModule, type CanvasAgentHttpModuleOptions } from "../../src/modules/canvas-agent-http.js";
import { MemoryBrainSessionStore } from "../../src/brains/session-store.js";
import type { RuntimeAccountPrincipal, RuntimeAccountBinding } from "../../src/runtime-account.js";

export function accountCanvasFixture(config: LocalRuntimeConfig, canvas = new CanvasSession(), options: CanvasAgentHttpModuleOptions = {}) {
    let now = Date.now(), sequence = 0;
    const store = options.brainSessionStore ?? new MemoryBrainSessionStore();
    const proofs = new Map<string, unknown>();
    const module = createCanvasAgentHttpModule(config, canvas, { ...options, persistentAudit: false, brainSessionStore: store, accountNow: () => now,
        accountVerifierFetch: async (_target, init) => Response.json({ code: 0, msg: "", data: proofs.get(JSON.parse(String(init?.body)).proof) }),
    });
    type Input = { body?: unknown; query?: Record<string, string>; params?: Record<string, string>; method?: "GET" | "POST"; principal?: RuntimeAccountPrincipal };
    const invoke = <T = Record<string, unknown>>(path: string, input: Input = {}) => new Promise<T>((resolve, reject) => {
        const route = module.routes.find(item => item.path === path && item.method === (input.method ?? (input.body === undefined ? "GET" : "POST")));
        if (!route) { reject(new Error(`Fixture route missing: ${path}`)); return; }
        const response = { locals: { runtimeSession: input.principal }, json: resolve, status() { return this; } };
        route.handler({ params: input.params ?? {}, query: input.query ?? {}, body: Buffer.from(JSON.stringify(input.body ?? {})) } as Request, response as unknown as ExpressResponse, reject);
    });
    const bind = async (userId: string, authMode: RuntimeAccountBinding["authMode"] = "account") => {
        const serial = String(++sequence).padStart(20, "0");
        const principal: RuntimeAccountPrincipal = { runtimeInstanceId: "runtime-instance-fixture", sessionId: `runtime-session-${serial}`, keyId: `key-${serial}`, origin: config.trustedWebOrigins[0], expiresAt: new Date(now + 600_000).toISOString() };
        const { challenge } = await invoke("/agent/account/challenge", { body: {}, principal });
        const proof = `fixture_${sequence}.${"s".repeat(43)}`;
        proofs.set(proof, { protocol: "filmos-runtime-account-v1", userId, authMode, challenge, issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 60 });
        const { binding } = await invoke<{ binding: RuntimeAccountBinding }>("/agent/account/bind", { body: { proof }, principal });
        return { principal, binding };
    };
    const connect = async (principal: RuntimeAccountPrincipal, clientId: string) => {
        const writes: string[] = [];
        const response = new EventEmitter() as EventEmitter & { locals: unknown; writeHead: () => void; write: (chunk: unknown) => boolean; end: () => void };
        response.locals = { runtimeSession: principal };
        response.write = chunk => { writes.push(String(chunk)); return true; };
        response.end = () => { response.emit("close"); };
        await new Promise<void>((resolve, reject) => {
            response.writeHead = resolve;
            module.routes.find(item => item.path === "/events")!.handler({ url: `/events?clientId=${encodeURIComponent(clientId)}` } as Request, response as unknown as ExpressResponse, reject);
        });
        return { response, writes };
    };
    return { module, canvas, store, invoke, bind, connect, advance: (ms: number) => { now += ms; }, dispose: () => module.dispose?.() };
}

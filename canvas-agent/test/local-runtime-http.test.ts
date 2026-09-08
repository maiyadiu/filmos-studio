import assert from "node:assert/strict";
import crypto, { type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import http, { type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    canonicalRuntimeJson,
    createRuntimeRequestPayload,
    sha256Base64Url,
    type LocalRuntimeModuleDescriptor,
} from "../src/local-runtime-contract.js";
import { createLocalRuntimeApp, type LocalRuntimeModule } from "../src/local-runtime.js";
import { createDreaminaHttpModule } from "../src/modules/dreamina-http.js";
import { createCanvasAgentHttpModule } from "../src/modules/canvas-agent-http.js";
import { CanvasSession } from "../src/canvas-session.js";
import { MemoryBrainSessionStore } from "../src/brains/session-store.js";
import { AGENT_FEATURE_FLAG_IDS } from "../src/brains/feature-flags.js";
import {
    LocalRuntimeSessionManager,
    type RuntimeBrowserRegistration,
} from "../src/local-runtime-session.js";

const origin = "http://127.0.0.1:3001";
const hostileOrigin = "https://hostile.example";
const authority = "127.0.0.1:41742";
const endpoint = `http://${authority}`;
const runtimeInstanceId = "runtime-http-fixture";
const now = Date.parse("2026-08-10T00:00:00.000Z");

test("runtime info has exact Host and route-scoped CORS/PNA without exposing modules", async () => {
    await withRuntime(async ({ server }) => {
        const wrongHost = await request(server, {
            path: "/runtime/info",
            headers: { Host: "localhost:41742", Origin: hostileOrigin },
        });
        assert.equal(wrongHost.status, 421);
        assert.equal(wrongHost.headers["access-control-allow-origin"], undefined);

        const info = await request(server, {
            path: "/runtime/info",
            headers: { Host: authority, Origin: hostileOrigin },
        });
        assert.equal(info.status, 200);
        assert.equal(info.headers["access-control-allow-origin"], hostileOrigin);
        assert.equal(info.headers["access-control-allow-credentials"], undefined);
        assert.equal(info.headers["cache-control"], "no-store, max-age=0");
        assert.deepEqual(JSON.parse(info.body), {
            runtime: "framefield-local-runtime",
            apiVersion: 2,
            protocolVersion: "framefield-runtime-session-v1",
            runtimeInstanceId,
            originTrusted: false,
        });
        assert.equal(info.body.includes("module"), false);
        assert.equal(info.body.includes("token"), false);

        const preflight = await request(server, {
            method: "OPTIONS",
            path: "/runtime/info",
            headers: {
                Host: authority,
                Origin: hostileOrigin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Private-Network": "true",
            },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers["access-control-allow-private-network"], "true");

        const forbidden = await request(server, {
            method: "POST",
            path: "/runtime/session/challenge",
            headers: jsonHeaders(hostileOrigin),
            body: "{}",
        });
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.headers["access-control-allow-origin"], undefined);
    });
});

test("route-scoped CORS keeps every method registered on the same path", async () => {
    await withRuntime(async ({ server }) => {
        const preflight = await request(server, {
            method: "OPTIONS",
            path: "/dreamina/tasks",
            headers: {
                Host: authority,
                Origin: origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-framefield-runtime-session,x-framefield-runtime-timestamp,x-framefield-runtime-nonce,x-framefield-runtime-proof",
            },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers["access-control-allow-methods"], "GET,POST");
        assert.equal(preflight.headers["access-control-allow-origin"], origin);
        assert.equal(preflight.headers["access-control-allow-headers"], "x-framefield-runtime-session,x-framefield-runtime-timestamp,x-framefield-runtime-nonce,x-framefield-runtime-proof,content-type");
    });
});

test("only an exact trusted Origin can silently establish a signed browser session", async () => {
    await withRuntime(async ({ server }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        assert.equal(challenge.state, "challenge");
        assert.equal(JSON.stringify(challenge).includes("pair"), false);
        const session = await exchangeRequest(server, key.privateKey, challenge);
        assert.equal(session.keyId, challenge.keyId);

        for (const rejectedOrigin of [undefined, "null", hostileOrigin]) {
            const rejected = await request(server, {
                method: "POST",
                path: "/runtime/session/challenge",
                headers: {
                    Host: authority,
                    ...(rejectedOrigin ? { Origin: rejectedOrigin } : {}),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ publicKeyJwk: browserKey().publicJwk }),
            });
            assert.equal(rejected.status, 403);
            assert.equal(rejected.headers.location, undefined);
        }

        for (const method of ["GET", "POST"]) {
            const removed = await request(server, { method, path: `/runtime/pair/${challenge.challengeId}`, headers: { Host: authority } });
            assert.equal(removed.status, 404);
        }
    });
});

test("signed protected route maps its own scope and rejects replay or substituted paths before module invocation", async () => {
    let calls = 0;
    await withRuntime(async ({ server, manager }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        const session = await exchangeRequest(server, key.privateKey, challenge);
        const signed = signedHeaders(key.privateKey, session, "GET", "/dreamina/status", Buffer.alloc(0));

        const accepted = await request(server, {
            path: "/dreamina/status",
            headers: { Host: authority, Origin: origin, ...signed },
        });
        assert.equal(accepted.status, 200);
        assert.equal(calls, 1);

        const replay = await request(server, {
            path: "/dreamina/status",
            headers: { Host: authority, Origin: origin, ...signed },
        });
        assert.equal(replay.status, 409);
        assert.equal(calls, 1);

        const freshDreaminaProof = signedHeaders(
            key.privateKey,
            session,
            "GET",
            "/dreamina/status",
            Buffer.alloc(0),
        );
        const substituted = await request(server, {
            path: "/runtime/status",
            headers: { Host: authority, Origin: origin, ...freshDreaminaProof },
        });
        assert.equal(substituted.status, 401);
        assert.equal(calls, 1);
    }, () => {
        calls += 1;
    });
});

test("Dreamina effect routes require a signed dreamina:generate request before invocation", async () => {
    let calls = 0;
    await withRuntime(async ({ server }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        const session = await exchangeRequest(server, key.privateKey, challenge);
        const path = "/dreamina/generate/effects/claim";
        const body = Buffer.from(JSON.stringify({
            consumerId: "web-generation-materializer",
            taskId: "dreamina:signed-effect-task-0001",
            effectKey: "materialize:dreamina:signed-effect-task-0001:0",
        }));

        const unsigned = await request(server, {
            method: "POST",
            path,
            headers: jsonHeaders(origin),
            body: body.toString("utf8"),
        });
        assert.equal(unsigned.status, 401);
        assert.equal(calls, 0);

        const substitutedBody = Buffer.from(JSON.stringify({ consumerId: "substituted" }));
        const substituted = await request(server, {
            method: "POST",
            path,
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, session, "POST", path, body),
            },
            body: substitutedBody.toString("utf8"),
        });
        assert.equal(substituted.status, 401);
        assert.equal(calls, 0);

        const accepted = await request(server, {
            method: "POST",
            path,
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, session, "POST", path, body),
            },
            body: body.toString("utf8"),
        });
        assert.equal(accepted.status, 200);
        assert.equal(calls, 1);
    }, undefined, () => {
        calls += 1;
    });
});

test("production Dreamina effect claim composes signing scope and strict JSON in the real runtime app", async () => {
    await withProductionDreaminaRuntime(async ({ server }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        const session = await exchangeRequest(server, key.privateKey, challenge);
        const route = "/dreamina/generate/effects/claim";
        const body = Buffer.from(JSON.stringify({
            consumerId: "web-generation-materializer",
            taskId: "dreamina:dreamina-http-effect-task-0001",
            effectKey: "materialize:dreamina:dreamina-http-effect-task-0001:0",
        }));

        const substitutedBody = Buffer.from(JSON.stringify({
            consumerId: "web-generation-materializer",
            taskId: "dreamina:dreamina-http-effect-task-0001",
            effectKey: "materialize:dreamina:dreamina-http-effect-task-0001:0",
            unexpected: true,
        }));
        const substituted = await request(server, {
            method: "POST",
            path: route,
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, session, "POST", route, body),
            },
            body: substitutedBody.toString("utf8"),
        });
        assert.equal(substituted.status, 401);

        const unexpected = await request(server, {
            method: "POST",
            path: route,
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, session, "POST", route, substitutedBody),
            },
            body: substitutedBody.toString("utf8"),
        });
        assert.equal(unexpected.status, 400);
        assert.equal((JSON.parse(unexpected.body) as { code?: string }).code, "dreamina_request_invalid");

        const accepted = await request(server, {
            method: "POST",
            path: route,
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, session, "POST", route, body),
            },
            body: body.toString("utf8"),
        });
        assert.equal(accepted.status, 200);
        assert.equal((JSON.parse(accepted.body) as { result?: { status?: string } }).result?.status, "claimed");
    });

    await withProductionDreaminaRuntime(async ({ server }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        const session = await exchangeRequest(server, key.privateKey, challenge);
        assert.equal(session.scopes.includes("dreamina:generate"), false);
        const route = "/dreamina/generate/effects/claim";
        const body = Buffer.from(JSON.stringify({
            consumerId: "web-generation-materializer",
            taskId: "dreamina:dreamina-http-effect-task-0001",
            effectKey: "materialize:dreamina:dreamina-http-effect-task-0001:0",
        }));
        const denied = await request(server, {
            method: "POST",
            path: route,
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, session, "POST", route, body),
            },
            body: body.toString("utf8"),
        });
        assert.equal(denied.status, 403);
        assert.equal((JSON.parse(denied.body) as { code?: string }).code, "scope_denied");
    }, ["dreamina:status"]);
});

test("production Dreamina task list accepts the signed canonical pagination query", async () => {
    await withProductionDreaminaRuntime(async ({ server }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        const session = await exchangeRequest(server, key.privateKey, challenge);
        const route = "/dreamina/generate/tasks?activeOnly=true&limit=100";
        const response = await request(server, {
            path: route,
            headers: {
                Host: authority,
                Origin: origin,
                ...signedHeaders(key.privateKey, session, "GET", route, Buffer.alloc(0)),
            },
        });

        assert.equal(response.status, 200);
        const body = JSON.parse(response.body) as { ok?: boolean; result?: { tasks?: unknown[] } };
        assert.equal(body.ok, true);
        assert.equal(Array.isArray(body.result?.tasks), true);
    });
});

test("signed session and registration revoke invalidate the intended authorization", async () => {
    await withRuntime(async ({ server, manager }) => {
        const key = browserKey();
        const challenge = await challengeRequest(server, key.publicJwk);
        const firstSession = await exchangeRequest(server, key.privateKey, challenge);
        const emptyBody = Buffer.from("{}");

        const revokeSession = await request(server, {
            method: "POST",
            path: "/runtime/session/revoke",
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, firstSession, "POST", "/runtime/session/revoke", emptyBody),
            },
            body: emptyBody.toString("utf8"),
        });
        assert.equal(revokeSession.status, 200);
        assert.deepEqual(JSON.parse(revokeSession.body), { ok: true });
        assert.equal(revokeSession.headers["access-control-allow-origin"], origin);

        const rejectedSession = await request(server, {
            path: "/runtime/status",
            headers: {
                Host: authority,
                Origin: origin,
                ...signedHeaders(key.privateKey, firstSession, "GET", "/runtime/status", Buffer.alloc(0)),
            },
        });
        assert.equal(rejectedSession.status, 401);

        const secondChallenge = await challengeRequest(server, undefined, firstSession.keyId);
        const secondSession = await exchangeRequest(server, key.privateKey, secondChallenge);
        const thirdChallenge = await challengeRequest(server, undefined, firstSession.keyId);
        const thirdSession = await exchangeRequest(server, key.privateKey, thirdChallenge);
        const revokeRegistration = await request(server, {
            method: "POST",
            path: "/runtime/session/registration/revoke",
            headers: {
                ...jsonHeaders(origin),
                ...signedHeaders(key.privateKey, secondSession, "POST", "/runtime/session/registration/revoke", emptyBody),
            },
            body: emptyBody.toString("utf8"),
        });
        assert.equal(revokeRegistration.status, 200);
        assert.deepEqual(JSON.parse(revokeRegistration.body), { ok: true });

        const rejectedSiblingSession = await request(server, {
            path: "/runtime/status",
            headers: {
                Host: authority,
                Origin: origin,
                ...signedHeaders(key.privateKey, thirdSession, "GET", "/runtime/status", Buffer.alloc(0)),
            },
        });
        assert.equal(rejectedSiblingSession.status, 401);

        const rejectedRegistration = await request(server, {
            method: "POST",
            path: "/runtime/session/challenge",
            headers: jsonHeaders(origin),
            body: JSON.stringify({ keyId: firstSession.keyId }),
        });
        assert.equal(rejectedRegistration.status, 404);
        assert.equal(JSON.parse(rejectedRegistration.body).code, "registration_not_found");
    });
});

async function withProductionDreaminaRuntime(
    run: (fixture: { server: Server; manager: LocalRuntimeSessionManager }) => Promise<void>,
    scopes?: ConstructorParameters<typeof LocalRuntimeSessionManager>[0]["scopes"],
) {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreamina-production-http-"));
    const idempotencyKey = "dreamina-http-effect-task-0001";
    await fs.writeFile(path.join(configDir, "dreamina-runtime-state.json"), JSON.stringify({
        version: 1,
        records: [{
            ownerId: "owner-production-http-0001",
            idempotencyKey,
            requestHash: "a".repeat(64),
            state: "accepted",
            updatedAt: "2026-08-13T00:00:00.000Z",
            submitId: "opaque-fixture-id",
            taskVersion: 1,
            operation: "text2video",
            mode: "video",
            model: "seedance2.0mini",
            createdAt: "2026-08-13T00:00:00.000Z",
        }],
    }));
    const registrations: RuntimeBrowserRegistration[] = [];
    const manager = new LocalRuntimeSessionManager({
        endpoint,
        runtimeInstanceId,
        trustedOrigins: [origin],
        registrations,
        now: () => now,
        scopes,
    });
    const task = (id: string) => ({
        id,
        provider: "dreamina-cli" as const,
        mode: "video" as const,
        operation: "text2video" as const,
        model: "seedance2.0mini",
        status: "running" as const,
        stage: "submitted" as const,
        progress: 10,
        receiptRecorded: true,
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
    });
    const module = createDreaminaHttpModule({
        ownerId: "owner-production-http-0001",
        configDir,
        dreaminaRuntime: {
            run: async () => ({ state: "accepted" as const, submitId: "opaque-fixture-id" }),
            generateToResult: async () => ({ mode: "video" as const, video: { dataUrl: "data:video/mp4;base64,AA==", mimeType: "video/mp4", bytes: 1 } }),
            resumeToResult: async () => ({ mode: "video" as const, video: { dataUrl: "data:video/mp4;base64,AA==", mimeType: "video/mp4", bytes: 1 } }),
            getTask: async (id: string) => task(id),
            waitForTask: async () => ({ mode: "video" as const, video: { dataUrl: "data:video/mp4;base64,AA==", mimeType: "video/mp4", bytes: 1 } }),
            refreshTask: async (id: string) => task(id),
            listTasks: async () => [task(idempotencyKey)],
            cancelTask: async (id: string) => ({ ...task(id), status: "cancelled" as const, stage: "cancelled" as const }),
            deleteTask: async () => ({ deleted: true as const }),
            enqueue: async () => task(idempotencyKey),
        },
    });
    const app = createLocalRuntimeApp({
        authority,
        endpoint,
        version: "0.1.0",
        sessionManager: manager,
        modules: [module],
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    try {
        await run({ server, manager });
    } finally {
        manager.dispose();
        await module.dispose?.();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await fs.rm(configDir, { recursive: true, force: true });
    }
}

test("account HTTP handshake uses the signed server identity, rejects body identity and cannot survive revocation", async () => {
    let accountChallenge: Record<string, string> | undefined;
    let verifications = 0;
    let modelReads = 0;
    const module = createCanvasAgentHttpModule({
        url: endpoint, token: "fixture-master-token", ownerId: "fixture-owner", trustedWebOrigins: [origin], browserRegistrations: [],
        agentFeatureFlags: Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map(id => [id, true])),
    }, new CanvasSession(), {
        brainSessionStore: new MemoryBrainSessionStore(), accountNow: () => now,
        listCodexModels: async () => { modelReads++; return []; },
        accountVerifierFetch: async (target, init) => {
            verifications += 1;
            assert.equal(String(target), origin + "/api/auth/runtime-account/verify");
            assert.equal(init?.credentials, "omit");
            return Response.json({ code: 0, msg: "", data: {
                protocol: "filmos-runtime-account-v1", userId: "fixture-web-user", authMode: "account",
                challenge: accountChallenge, issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 60,
            } });
        },
    });
    await withRuntime(async ({ server }) => {
        const key = browserKey();
        const signed = await exchangeRequest(server, key.privateKey, await challengeRequest(server, key.publicJwk));
        const call = (path: string, body?: string) => {
            const method = body === undefined ? "GET" : "POST";
            return request(server, { path, method, body, headers: { ...jsonHeaders(origin), ...signedHeaders(key.privateKey, signed, method, path, Buffer.from(body ?? "")) } });
        };
        for (const headers of [jsonHeaders(origin), { ...jsonHeaders(origin), "X-Canvas-Token": "fixture-master-token" }]) {
            const response = await request(server, { path: "/agent/account/challenge", method: "POST", headers, body: "{}" });
            assert.equal(response.status, 401);
        }
        assert.equal((await call("/agent/account")).status, 401);
        assert.equal((await call("/agent/models")).status, 401);
        assert.equal(modelReads, 0);
        assert.equal((await call("/agent/sessions")).status, 401, "signed transport alone does not grant private history access");
        for (const body of ["null", "[]", "{", JSON.stringify({ userId: "spoofed" }), " ".repeat(8193)]) {
            const denied = await call("/agent/account/challenge", body);
            assert.equal(denied.status, 400);
            assert.equal(JSON.parse(denied.body).code, "agent_account_body_invalid");
        }
        const issued = await call("/agent/account/challenge", "{}");
        assert.equal(issued.status, 200);
        accountChallenge = JSON.parse(issued.body).challenge;
        assert.deepEqual({ ...accountChallenge, nonce: "server-generated" }, {
            runtimeInstanceId, runtimeSessionId: signed.sessionId, keyId: signed.keyId, origin, nonce: "server-generated",
        });
        const proofBody = JSON.stringify({ proof: "fixture." + "s".repeat(43) });
        assert.equal((await call("/agent/account/bind", JSON.stringify({ ...JSON.parse(proofBody), userId: "spoofed" }))).status, 400);
        assert.equal(verifications, 0);
        const bound = await call("/agent/account/bind", proofBody);
        assert.equal(bound.status, 200);
        assert.equal(JSON.parse(bound.body).binding.userId, "fixture-web-user");
        assert.deepEqual(JSON.parse((await call("/agent/models")).body), { ok: true, models: [] });
        assert.equal(modelReads, 1);
        assert.deepEqual(JSON.parse((await call("/agent/account")).body), JSON.parse(bound.body));
        assert.equal((await call("/agent/sessions")).status, 200);
        assert.deepEqual(JSON.parse((await call("/agent/sessions")).body).sessions, []);
        assert.equal((await call("/agent/account/bind", proofBody)).status, 409);
        assert.equal(verifications, 1);
        assert.equal((await call("/runtime/session/revoke", "{}")).status, 200);
        assert.equal((await call("/agent/models")).status, 401);
        assert.equal(modelReads, 1);
        assert.equal((await call("/agent/account")).status, 401);
        assert.equal((await call("/agent/sessions")).status, 401);
        const second = await exchangeRequest(server, key.privateKey, await challengeRequest(server, undefined, signed.keyId));
        const unbound = await request(server, { path: "/agent/account", headers: {
            ...jsonHeaders(origin), ...signedHeaders(key.privateKey, second, "GET", "/agent/account", Buffer.alloc(0)),
        } });
        assert.equal(unbound.status, 401, "a new signed session never inherits the old proof lease");
        assert.equal(verifications, 1);
    }, undefined, undefined, [module]);
});

test("signed canvas HTTP state and result use verified session identity, never a body substitute", async () => {
    const canvas = new CanvasSession();
    const module = createCanvasAgentHttpModule({ url: endpoint, token: "fixture", ownerId: "fixture-owner", trustedWebOrigins: [origin], browserRegistrations: [] }, canvas);
    await withRuntime(async ({ server }) => {
        const keyA = browserKey(), keyB = browserKey();
        const signedA = await exchangeRequest(server, keyA.privateKey, await challengeRequest(server, keyA.publicJwk));
        const signedB = await exchangeRequest(server, keyB.privateKey, await challengeRequest(server, keyB.publicJwk));
        const frames: string[] = [];
        const stream = Object.assign(new EventEmitter(), {
            writeHead() {}, end() {}, write(chunk: unknown) { frames.push(String(chunk)); },
        });
        canvas.openEvents(new URL(endpoint + "/events?clientId=client-a"), stream as never, signedA.sessionId);
        const post = (key: KeyObject, signed: typeof signedA, route: string, value: unknown) => {
            const body = JSON.stringify(value);
            return request(server, { path: route, method: "POST", body, headers: { ...jsonHeaders(origin), ...signedHeaders(key, signed, "POST", route, Buffer.from(body)) } });
        };
        const state = { projectId: "canvas-a", nodes: [], revision: 1 };
        const statePath = "/canvas/state?clientId=client-a";
        const denial = await post(keyB.privateKey, signedB, statePath, { ...state, runtimeSessionId: signedA.sessionId });
        assert.equal(denial.status, 403);
        assert.equal(JSON.parse(denial.body).code, "canvas_client_session_mismatch");
        assert.throws(() => canvas.workbenchContext(), /CANVAS_CONTEXT_UNAVAILABLE/);
        assert.equal((await post(keyA.privateKey, signedA, statePath, state)).status, 200);
        const pending = canvas.callTool("canvas_apply_ops", { ops: [{ type: "select_nodes", ids: [] }] });
        const frame = frames.find(item => item.startsWith("event: tool_call\n"))!;
        const { requestId } = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
        const resultPath = "/canvas/result?clientId=client-a";
        const resultDenial = await post(keyB.privateKey, signedB, resultPath, { requestId, runtimeSessionId: signedA.sessionId, result: "forged" });
        assert.equal(resultDenial.status, 403);
        assert.equal(JSON.parse(resultDenial.body).code, "canvas_client_session_mismatch");
        assert.equal((await post(keyA.privateKey, signedA, "/canvas/result?clientId=client-b", { requestId, result: "wrong-tab" })).status, 403);
        assert.equal((await post(keyA.privateKey, signedA, resultPath, { requestId, result: "saved" })).status, 200);
        assert.equal(await pending, "saved");
    }, undefined, undefined, [module]);
});

async function withRuntime(
    run: (fixture: { server: Server; manager: LocalRuntimeSessionManager }) => Promise<void>,
    onDreaminaStatus: (() => void) | undefined = () => undefined,
    onDreaminaEffect: () => void = () => undefined,
    additionalModules: LocalRuntimeModule[] = [],
) {
    const registrations: RuntimeBrowserRegistration[] = [];
    const manager = new LocalRuntimeSessionManager({
        endpoint,
        runtimeInstanceId,
        trustedOrigins: [origin],
        registrations,
        now: () => now,
        onSessionRevoked: id => { for (const module of additionalModules) module.onRuntimeSessionRevoked?.(id); },
    });
    const descriptor: LocalRuntimeModuleDescriptor = {
        id: "dreamina",
        displayName: "Dreamina CLI",
        apiVersion: 1,
        scopes: ["dreamina:status", "dreamina:generate"],
    };
    const module: LocalRuntimeModule = {
        descriptor,
        routes: [
            {
                method: "GET",
                path: "/dreamina/status",
                scope: "dreamina:status",
                handler: (_req, res) => {
                    onDreaminaStatus?.();
                    res.json({ ok: true });
                },
            },
            {
                method: "GET",
                path: "/dreamina/tasks",
                scope: "dreamina:status",
                handler: (_req, res) => res.json({ ok: true }),
            },
            {
                method: "POST",
                path: "/dreamina/tasks",
                scope: "dreamina:generate",
                handler: (_req, res) => res.json({ ok: true }),
            },
            {
                method: "POST",
                path: "/dreamina/generate/effects/claim",
                scope: "dreamina:generate",
                handler: (_req, res) => {
                    onDreaminaEffect();
                    res.json({ ok: true });
                },
            },
        ],
    };
    const app = createLocalRuntimeApp({
        authority,
        endpoint,
        version: "0.1.0",
        sessionManager: manager,
        modules: [module, ...additionalModules],
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    try {
        await run({ server, manager });
    } finally {
        manager.dispose();
        await Promise.all(additionalModules.map(module => module.dispose?.()));
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

async function challengeRequest(server: Server, publicKeyJwk?: JsonWebKey, keyId?: string) {
    const response = await request(server, {
        method: "POST",
        path: "/runtime/session/challenge",
        headers: jsonHeaders(origin),
        body: JSON.stringify(publicKeyJwk ? { publicKeyJwk } : { keyId }),
    });
    assert.equal(response.status, 200);
    return JSON.parse(response.body) as {
        state: "challenge";
        challengeId: string;
        nonce: string;
        runtimeInstanceId: string;
        expiresAt: string;
        keyId: string;
    };
}

async function exchangeRequest(
    server: Server,
    privateKey: KeyObject,
    challenge: Awaited<ReturnType<typeof challengeRequest>>,
) {
    const signature = crypto.sign("sha256", Buffer.from(canonicalRuntimeJson({
        protocol: "framefield-runtime-session-v1",
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        origin,
        endpoint,
        runtimeInstanceId,
        expiresAt: challenge.expiresAt,
    })), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const response = await request(server, {
        method: "POST",
        path: "/runtime/session/exchange",
        headers: jsonHeaders(origin),
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
    });
    assert.equal(response.status, 200);
    return JSON.parse(response.body) as {
        sessionId: string;
        keyId: string;
        scopes: string[];
        expiresAt: string;
    };
}

function signedHeaders(
    privateKey: KeyObject,
    session: { sessionId: string; keyId: string; expiresAt: string },
    method: string,
    pathAndQuery: string,
    body: Buffer,
) {
    const requestNonce = crypto.randomBytes(16).toString("base64url");
    const payload = createRuntimeRequestPayload({
        sessionId: session.sessionId,
        keyId: session.keyId,
        method,
        pathAndQuery,
        bodySha256: sha256Base64Url(body),
        lastEventId: null,
        origin,
        endpoint,
        runtimeInstanceId,
        requestNonce,
        timestamp: now,
        sessionExpiresAt: session.expiresAt,
    });
    return {
        "X-Framefield-Runtime-Session": session.sessionId,
        "X-Framefield-Runtime-Timestamp": String(now),
        "X-Framefield-Runtime-Nonce": requestNonce,
        "X-Framefield-Runtime-Proof": crypto.sign(
            "sha256",
            Buffer.from(canonicalRuntimeJson(payload)),
            { key: privateKey, dsaEncoding: "ieee-p1363" },
        ).toString("base64url"),
    };
}

function browserKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const exported = publicKey.export({ format: "jwk" });
    return {
        privateKey,
        publicJwk: {
            kty: exported.kty,
            crv: exported.crv,
            x: exported.x,
            y: exported.y,
            ext: true,
            key_ops: ["verify"],
        } satisfies JsonWebKey,
    };
}

function jsonHeaders(requestOrigin: string) {
    return { Host: authority, Origin: requestOrigin, "Content-Type": "application/json" };
}

function request(
    server: Server,
    options: {
        method?: string;
        path: string;
        headers?: Record<string, string>;
        body?: string;
    },
) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server is not listening");
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port: address.port,
            method: options.method ?? "GET",
            path: options.path,
            headers: options.headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            }));
        });
        req.once("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

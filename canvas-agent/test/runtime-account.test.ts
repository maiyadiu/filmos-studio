import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeAccountBindings, type RuntimeAccountPrincipal, type RuntimeAccountChallenge } from "../src/runtime-account.js";
import { LocalRuntimeSessionError } from "../src/local-runtime-session.js";

const start = Date.parse("2026-09-08T00:00:00Z");
const origin = "http://127.0.0.1:43100";
const proof = "fixture." + "s".repeat(43);
const principal = (suffix = "a"): RuntimeAccountPrincipal => ({ runtimeInstanceId: "runtime-instance-" + "i".repeat(20), sessionId: "runtime-session-" + suffix.repeat(20), keyId: "key-" + suffix.repeat(40), origin, expiresAt: new Date(start + 600_000).toISOString() });
const rejects = (code: string) => (error: unknown) => error instanceof LocalRuntimeSessionError && error.code === code;

function fixture() {
    const state = { now: start, user: "user-a", authMode: "account", challenge: undefined as RuntimeAccountChallenge | undefined, calls: [] as Array<{ target: string; init?: RequestInit }>, respond: undefined as undefined | (() => Response | Promise<Response>) };
    const envelope = () => ({ code: 0, msg: "", data: { protocol: "filmos-runtime-account-v1", userId: state.user, authMode: state.authMode, challenge: state.challenge, issuedAt: Math.floor(state.now / 1000), expiresAt: Math.floor(state.now / 1000) + 60 } });
    const fetch: typeof globalThis.fetch = async (target, init) => { state.calls.push({ target: String(target), init }); return state.respond ? state.respond() : Response.json(envelope()); };
    const registry = new RuntimeAccountBindings({ ownerId: "owner-a", trustedOrigins: [origin, "https://workbench.example"], now: () => state.now, fetch });
    const challenge = (p = principal()) => { const issued = registry.challenge(p); state.challenge = issued.challenge; return issued; };
    return { state, registry, challenge, envelope, fetch };
}

test("account binding consumes a server challenge, uses only a fixed trusted verifier and keeps stable account scope", async t => {
    const f = fixture(); t.after(() => f.registry.dispose());
    f.challenge();
    const a = await f.registry.bind(principal(), proof);
    assert.equal(a.userId, "user-a");
    assert.equal(Date.parse(a.expiresAt), start + 60_000);
    assert.match(a.accountScopeId, /^account_[a-f0-9]{64}$/);
    const call = f.state.calls[0];
    assert.equal(call.target, origin + "/api/auth/runtime-account/verify");
    assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.cache, "no-store"); assert.equal(call.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(call.init?.body)), { proof });
    assert.deepEqual(call.init?.headers, { "content-type": "application/json", accept: "application/json" });
    a.userId = "caller-mutated";
    assert.equal(f.registry.require(principal()).userId, "user-a");
    await assert.rejects(f.registry.bind(principal(), proof), rejects("agent_account_challenge_required"));
    const reconnect = principal("b"); f.challenge(reconnect);
    assert.equal((await f.registry.bind(reconnect, proof)).accountScopeId, a.accountScopeId);
    f.state.user = "user-b"; const other = principal("c"); f.challenge(other);
    assert.notEqual((await f.registry.bind(other, proof)).accountScopeId, a.accountScopeId);
    const tenant = { ...principal("d"), origin: "https://workbench.example" }; f.state.user = "user-a"; f.challenge(tenant);
    assert.notEqual((await f.registry.bind(tenant, proof)).accountScopeId, a.accountScopeId);
});

test("proof expiry does not allow the signed Runtime session to change user or principal", async t => {
    const f = fixture(); t.after(() => f.registry.dispose()); f.challenge();
    const first = await f.registry.bind(principal(), proof);
    f.state.now += 60_000;
    assert.throws(() => f.registry.require(principal()), rejects("agent_account_binding_required"));
    f.state.user = "user-b"; f.challenge();
    await assert.rejects(f.registry.bind(principal(), proof), rejects("agent_account_session_rebind_denied"));
    f.state.user = "user-a"; f.challenge();
    assert.equal((await f.registry.bind(principal(), proof)).accountScopeId, first.accountScopeId);
    for (const patch of [{ keyId: "another-"+"k".repeat(25) }, { runtimeInstanceId: "another-"+"i".repeat(25) }, { expiresAt: new Date(start + 700_000).toISOString() }, { origin: "https://workbench.example" }]) {
        assert.throws(() => f.registry.require({ ...principal(), ...patch }), rejects("agent_account_binding_required"));
        assert.throws(() => f.registry.challenge({ ...principal(), ...patch }), rejects("agent_account_session_rebind_denied"));
    }
    f.registry.revoke(principal().sessionId);
    assert.throws(() => f.registry.require(principal()), rejects("agent_account_binding_required"));
});

test("unsigned, expired, untrusted or malformed origins never reach the verifier", async t => {
    const f = fixture(); t.after(() => f.registry.dispose());
    for (const value of [undefined, {}, { ...principal(), keyId: "" }, { ...principal(), expiresAt: new Date(start).toISOString() }, { ...principal(), origin: "https://hostile.example" }, { ...principal(), origin: origin+"?" }]) {
        assert.throws(() => f.registry.challenge(value), LocalRuntimeSessionError);
    }
    for (const bad of ["http://public.example", "https://workbench.example/path", "https://user:password@workbench.example"]) {
        const registry = new RuntimeAccountBindings({ ownerId: "owner-a", trustedOrigins: [bad], fetch: f.fetch, now: () => start });
        assert.throws(() => registry.challenge({ ...principal(), origin: bad }), rejects("agent_account_origin_denied")); registry.dispose();
    }
    const missing = new RuntimeAccountBindings({ trustedOrigins: [origin], fetch: f.fetch, now: () => start });
    assert.throws(() => missing.challenge(principal()), rejects("agent_account_owner_required")); missing.dispose();
    assert.equal(f.state.calls.length, 0);
});

test("forged verifier facts, expiry and business failure cannot bind an account", async t => {
    const cases: Array<(body: ReturnType<ReturnType<typeof fixture>["envelope"]>) => unknown> = [
        body => ({ ...body, code: 401 }), body => ({ ...body, data: { ...body.data, userId: "" } }),
        body => ({ ...body, data: { ...body.data, role: "admin" } }), body => ({ ...body, data: { ...body.data, protocol: "other" } }),
        body => ({ ...body, data: { ...body.data, expiresAt: Math.floor(start / 1000) } }),
        body => ({ ...body, data: { ...body.data, expiresAt: body.data.issuedAt + 61 } }),
        body => ({ ...body, data: { ...body.data, issuedAt: body.data.issuedAt + 6, expiresAt: body.data.expiresAt + 6 } }),
        ...["runtimeInstanceId", "runtimeSessionId", "keyId", "nonce", "origin"].map(key => (body: ReturnType<ReturnType<typeof fixture>["envelope"]>) => ({ ...body, data: { ...body.data, challenge: { ...body.data.challenge, [key]: "different-"+"d".repeat(24) } } })),
    ];
    for (const mutate of cases) {
        const f = fixture(); t.after(() => f.registry.dispose()); f.challenge();
        f.state.respond = () => Response.json(mutate(f.envelope()));
        await assert.rejects(f.registry.bind(principal(), proof), rejects("agent_account_verification_invalid"));
        assert.throws(() => f.registry.require(principal()), rejects("agent_account_binding_required"));
    }
});

test("HTTP failure, redirect, oversized body and private verifier errors are bounded and sanitized", async t => {
    for (const response of [() => new Response("secret", { status: 403 }), () => Response.redirect("https://evil.example", 302), () => new Response("secret", { headers: { "content-type": "text/html" } }), () => new Response("x".repeat(8193), { headers: { "content-type": "application/json" } }), () => { throw new Error("private token /secret/path"); }]) {
        const f = fixture(); t.after(() => f.registry.dispose()); f.challenge(); f.state.respond = response;
        await assert.rejects(f.registry.bind(principal(), proof), error => error instanceof LocalRuntimeSessionError && !/secret|private|token|evil/.test(error.message));
        assert.equal(f.state.calls.length, 1); assert.throws(() => f.registry.require(principal()), LocalRuntimeSessionError);
    }
});

test("revocation while verification is in flight cannot resurrect identity or cancel a fresh challenge", async t => {
    const f = fixture(); t.after(() => f.registry.dispose()); f.challenge();
    let resolve!: (r: Response) => void;
    const oldEnvelope = f.envelope(); f.state.respond = () => new Promise<Response>(done => { resolve = done; });
    const pending = f.registry.bind(principal(), proof);
    assert.throws(() => f.challenge(), rejects("agent_account_binding_busy"));
    f.registry.revoke(principal().sessionId);
    assert.equal(f.state.calls[0].init?.signal?.aborted, true);
    f.challenge(); resolve(Response.json(oldEnvelope));
    await assert.rejects(pending, LocalRuntimeSessionError);
    assert.throws(() => f.registry.require(principal()), rejects("agent_account_binding_required"));
    f.state.respond = undefined;
    assert.equal((await f.registry.bind(principal(), proof)).userId, "user-a");
});

test("pending challenges and expired Runtime sessions are rejected without network I/O", async t => {
    const f = fixture(); t.after(() => f.registry.dispose()); f.challenge();
    for (const bad of ["", "fake", "x".repeat(6145)]) await assert.rejects(f.registry.bind(principal(), bad), rejects("agent_account_proof_invalid"));
    f.state.now += 60_000;
    await assert.rejects(f.registry.bind(principal(), proof), rejects("agent_account_challenge_required"));
    f.state.now = start + 600_000;
    assert.throws(() => f.challenge(), rejects("agent_account_signed_session_required"));
    assert.equal(f.state.calls.length, 0);
});

test("challenge capacity is bounded and expired challenges release capacity", t => {
    const f = fixture(); t.after(() => f.registry.dispose());
    for (let n = 0; n < 64; n++) f.challenge({ ...principal(), sessionId: "session-" + String(n).padStart(20, "0") });
    assert.throws(() => f.challenge(), rejects("agent_account_challenge_limit"));
    f.state.now += 60_000;
    assert.ok(f.challenge().challenge.nonce);
    assert.equal(f.state.calls.length, 0);
});

test("verifier timeout cancels a stalled JSON body and never creates an account binding", async t => {
    const f = fixture(); t.after(() => f.registry.dispose()); f.challenge();
    let cancelled = false;
    f.state.respond = () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"code":')); },
        cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    await assert.rejects(f.registry.bind(principal(), proof), LocalRuntimeSessionError);
    assert.equal(cancelled, true);
    assert.equal(f.state.calls[0].init?.signal?.aborted, true);
    assert.throws(() => f.registry.require(principal()), rejects("agent_account_binding_required"));
});

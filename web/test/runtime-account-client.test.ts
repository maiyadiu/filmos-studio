import { expect, test } from "bun:test";
import { RuntimeAccountClient, type RuntimeAccountBinding } from "../src/film/agent/runtime-account-client";
import type { LocalRuntimeConnection, RuntimePublicSession } from "../src/services/local-runtime-session";

const origin = "http://127.0.0.1:43100";
const proof = { proof: `fixture.${"a".repeat(43)}`, expiresAt: 1_800_000_060 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(userId = "user-1") {
    let now = 1_800_000_000_000;
    let session: RuntimePublicSession | undefined;
    let connects = 0, proofCalls = 0, revokes = 0, timerId = 0;
    const requests: string[] = [];
    const timers = new Map<number, () => void>();
    const options = {
        bind: (binding: RuntimeAccountBinding) => binding,
        issue: async () => proof,
        business: async () => Response.json({ ok: true }),
    };
    const runtime = {
        currentSession: () => session,
        connect: async (): Promise<LocalRuntimeConnection> => {
            session ??= { sessionId: `session_${String(++connects).padStart(16, "0")}`, keyId: "fixture_key_12345678", expiresAt: new Date(now + 600_000).toISOString(), scopes: ["agent:sessions:manage"] };
            return { state: "connected", session: { ...session }, runtimeVersion: 2 };
        },
        request: async (path: string) => {
            requests.push(path);
            if (path === "/agent/account/challenge") return Response.json({ ok: true, challenge: { runtimeInstanceId: "runtime_1234567890", runtimeSessionId: session!.sessionId, keyId: session!.keyId, origin, nonce: "nonce_123456789012" } });
            if (path === "/agent/account/bind") return Response.json({ ok: true, binding: options.bind({ accountScopeId: `account_${"a".repeat(64)}`, userId, authMode: "desktop_local", runtimeSessionId: session!.sessionId, keyId: session!.keyId, origin, expiresAt: new Date(now + 60_000).toISOString() }) });
            return options.business();
        },
        revokeRemoteSession: async () => { revokes++; session = undefined; },
    };
    let instances = 0;
    const client = new RuntimeAccountClient({ userId, origin, runtime: () => { instances++; return runtime; }, issueProof: async () => { proofCalls++; return options.issue(); }, now: () => now,
        timers: { setTimeout: ((fn: () => void) => { timers.set(++timerId, fn); return timerId; }) as unknown as typeof setTimeout, clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout },
    });
    return { client, runtime, options, requests, timers, stats: () => ({ instances, connects, proofCalls, revokes }), advance: (ms: number) => { now += ms; } };
}

test("account client is lazy and an absent login cannot create a signed runtime session", async () => {
    const f = fixture("");
    await expect(f.client.connect()).rejects.toMatchObject({ code: "agent_account_login_required", status: 401 });
    await f.client.disconnect();
    expect(f.stats()).toEqual({ instances: 0, connects: 0, proofCalls: 0, revokes: 0 });
});

test("parallel connections share one proof and business requests are dispatched only after binding", async () => {
    const f = fixture();
    try {
        await Promise.all([f.client.connect(), f.client.connect()]);
        expect(f.stats().proofCalls).toBe(1);
        expect(f.requests).toEqual(["/agent/account/challenge", "/agent/account/bind"]);
        await f.client.request("/business/save", { method: "POST" });
        expect(f.requests.at(-1)).toBe("/business/save");
        expect(f.timers.size).toBe(1);
        expect(f.client.currentBinding()?.userId).toBe("user-1");
    } finally { await f.client.disconnect(); }
    expect(f.timers.size).toBe(0);
});

test("cancelled coalesced connect must not resolve successfully after another caller binds", async () => {
    const f = fixture(); const hold = deferred<typeof proof>(); f.options.issue = () => hold.promise;
    const abort = new AbortController();
    const first = f.client.connect();
    const second = f.client.connect(abort.signal);
    const result = second.then(() => ({ name: "resolved" }), error => error);
    abort.abort(); hold.resolve(proof);
    try { await first; expect(await result).toMatchObject({ name: "AbortError" }); expect(f.stats().proofCalls).toBe(1); }
    finally { await f.client.disconnect(); }
});

test("a proof arriving after disconnect cannot bind or revive the old lifecycle", async () => {
    const f = fixture(); const hold = deferred<typeof proof>(); const entered = deferred<void>();
    f.options.issue = () => { entered.resolve(); return hold.promise; };
    const pending = f.client.connect().then(() => ({ name: "resolved" }), error => error);
    await entered.promise; await f.client.disconnect(); hold.resolve(proof);
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(f.requests).toEqual(["/agent/account/challenge"]);
    expect(f.client.currentBinding()).toBeUndefined(); expect(f.timers.size).toBe(0);
    f.options.issue = async () => proof;
    try { await f.client.connect(); expect(f.stats().connects).toBe(2); }
    finally { await f.client.disconnect(); }
});

test("a cancelled business waiter aborts before shared renewal finishes without submitting or cancelling the other caller", async () => {
    const f = fixture(); const hold = deferred<typeof proof>(); f.options.issue = () => hold.promise;
    const first = f.client.connect(); const abort = new AbortController();
    const result = f.client.request("/business/save", { method: "POST", signal: abort.signal }).then(() => ({ name: "resolved" }), error => error);
    try {
        abort.abort();
        expect(await result).toMatchObject({ name: "AbortError" });
        expect(f.requests).not.toContain("/business/save");
        hold.resolve(proof); await first;
        expect(f.client.currentBinding()?.userId).toBe("user-1");
    } finally { hold.resolve(proof); await first.catch(() => undefined); await f.client.disconnect(); }
});

test("changed account or malformed binding prevents business dispatch", async () => {
    for (const change of [(b: RuntimeAccountBinding) => ({ ...b, userId: "other" }), (b: RuntimeAccountBinding) => ({ ...b, origin: "https://other.example" }), (b: RuntimeAccountBinding) => ({ ...b, expiresAt: new Date(1_800_000_090_000).toISOString() })]) {
        const f = fixture(); f.options.bind = change;
        try { await expect(f.client.connect()).rejects.toBeDefined(); expect(f.requests).not.toContain("/business/save"); expect(f.client.currentBinding()).toBeUndefined(); }
        finally { await f.client.disconnect(); }
    }
});

test("401 business failure is returned once, never automatically replayed, and the next request renews", async () => {
    const f = fixture(); f.options.business = async () => Response.json({ ok: false }, { status: 401 });
    try {
        await f.client.connect();
        expect((await f.client.request("/business/save", { method: "POST" })).status).toBe(401);
        expect(f.requests.filter(path => path === "/business/save")).toHaveLength(1);
        expect(f.client.currentBinding()).toBeUndefined();
        f.options.business = async () => Response.json({ ok: true });
        await f.client.request("/business/read");
        expect(f.stats().proofCalls).toBe(2);
    } finally { await f.client.disconnect(); }
});

test("an expired lease renews before the next business request", async () => {
    const f = fixture();
    try { await f.client.connect(); f.advance(61_000); await f.client.request("/business/read"); expect(f.stats().proofCalls).toBe(2); expect(f.requests.at(-1)).toBe("/business/read"); }
    finally { await f.client.disconnect(); }
});

test("a late response from a disconnected account is not delivered to the replacement lifecycle", async () => {
    const f = fixture(); const hold = deferred<Response>(); const entered = deferred<void>();
    f.options.business = () => { entered.resolve(); return hold.promise; };
    await f.client.connect();
    const result = f.client.request("/business/read").then(() => ({ name: "resolved" }), error => error);
    await entered.promise; await f.client.disconnect(); await f.client.connect();
    hold.resolve(Response.json({ ok: false }, { status: 401 }));
    try { expect(await result).toMatchObject({ name: "AbortError" }); expect(f.client.currentBinding()?.userId).toBe("user-1"); }
    finally { await f.client.disconnect(); }
});

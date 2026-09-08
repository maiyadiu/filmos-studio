import crypto from "node:crypto";
import { z } from "zod";
import { LocalRuntimeSessionError } from "./local-runtime-session.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const challengeSchema = z.object({ runtimeInstanceId: id, runtimeSessionId: id, keyId: id, nonce: id, origin: z.string().max(2048) }).strict();
const principalSchema = z.object({ runtimeInstanceId: id, sessionId: id, keyId: id, origin: z.string().max(2048), expiresAt: z.string().datetime() }).passthrough();
const identitySchema = z.object({
    protocol: z.literal("filmos-runtime-account-v1"), userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    authMode: z.enum(["account", "desktop_local"]), challenge: challengeSchema,
    issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict();
const responseSchema = z.object({ code: z.literal(0), data: identitySchema, msg: z.string() }).strict();

export type RuntimeAccountPrincipal = z.infer<typeof principalSchema>;
export type RuntimeAccountChallenge = z.infer<typeof challengeSchema>;
export type RuntimeAccountBinding = {
    accountScopeId: string; userId: string; authMode: "account" | "desktop_local";
    runtimeSessionId: string; keyId: string; origin: string; expiresAt: string;
};
type Pending = { principal: RuntimeAccountPrincipal; challenge: RuntimeAccountChallenge; createdAt: number; expiresAt: number };

export class RuntimeAccountBindings {
    private readonly pending = new Map<string, Pending>();
    private readonly bindings = new Map<string, { principal: RuntimeAccountPrincipal; binding: RuntimeAccountBinding }>();
    private readonly attempts = new Map<string, AbortController>();
    private readonly now: () => number;
    private readonly fetch: typeof globalThis.fetch;
    private readonly origins: ReadonlySet<string>;
    private disposed = false;

    constructor(private readonly options: { ownerId?: string; trustedOrigins: readonly string[]; fetch?: typeof globalThis.fetch; now?: () => number }) {
        this.now = options.now ?? Date.now;
        this.fetch = options.fetch ?? globalThis.fetch;
        this.origins = new Set(options.trustedOrigins);
    }

    challenge(value: unknown) {
        const principal = this.principal(value);
        this.prune();
        if (this.attempts.has(principal.sessionId)) throw failure("agent_account_binding_busy", 409);
        if (this.pending.size >= 64 && !this.pending.has(principal.sessionId)) throw failure("agent_account_challenge_limit", 429);
        if (this.bindings.size + this.pending.size + this.attempts.size >= 256 && !this.bindings.has(principal.sessionId) && !this.pending.has(principal.sessionId)) throw failure("agent_account_challenge_limit", 429);
        const previous = this.bindings.get(principal.sessionId);
        if (previous && !samePrincipal(previous.principal, principal)) throw failure("agent_account_session_rebind_denied", 409);
        const challenge = { runtimeInstanceId: principal.runtimeInstanceId, runtimeSessionId: principal.sessionId, keyId: principal.keyId, origin: principal.origin, nonce: crypto.randomBytes(24).toString("base64url") };
        const expiresAt = Math.min(this.now() + 60_000, Date.parse(principal.expiresAt));
        this.pending.set(principal.sessionId, { principal, challenge, createdAt: this.now(), expiresAt });
        return { challenge: structuredClone(challenge), expiresAt: new Date(expiresAt).toISOString() };
    }

    async bind(value: unknown, proof: unknown) {
        const principal = this.principal(value);
        this.prune();
        if (typeof proof !== "string" || proof.length > 6144 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(proof)) throw failure("agent_account_proof_invalid", 400);
        const pending = this.pending.get(principal.sessionId);
        if (!pending || !samePrincipal(pending.principal, principal)) throw failure("agent_account_challenge_required", 409);
        if (this.attempts.has(principal.sessionId)) throw failure("agent_account_binding_busy", 409);
        // Consume before network I/O. Retry requires a new challenge, never a replay.
        this.pending.delete(principal.sessionId);
        const controller = new AbortController();
        this.attempts.set(principal.sessionId, controller);
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
            const target = `${principal.origin}/api/auth/runtime-account/verify`;
            const response = await this.fetch(target, {
                method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({ proof }), signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
            });
            if (response.redirected || (response.url && response.url !== target) || !response.ok) {
                await response.body?.cancel();
                throw failure(response.status === 401 || response.status === 403 ? "agent_account_proof_rejected" : "agent_account_verifier_unavailable", response.status === 401 || response.status === 403 ? 401 : 503);
            }
            const parsed = responseSchema.safeParse(await boundedJson(response, controller.signal));
            if (!parsed.success) throw failure("agent_account_verification_invalid", 502);
            const identity = parsed.data.data;
            const now = this.now();
            if (this.attempts.get(principal.sessionId) !== controller || controller.signal.aborted || this.disposed || pending.expiresAt <= now || Date.parse(principal.expiresAt) <= now) throw failure("agent_account_challenge_expired", 409);
            if (Object.keys(pending.challenge).some(key => identity.challenge[key as keyof RuntimeAccountChallenge] !== pending.challenge[key as keyof RuntimeAccountChallenge]) ||
                identity.issuedAt < Math.floor(pending.createdAt / 1000) - 5 || identity.issuedAt > Math.floor(now / 1000) + 5 ||
                identity.expiresAt <= Math.floor(now / 1000) || identity.expiresAt <= identity.issuedAt || identity.expiresAt - identity.issuedAt > 60) throw failure("agent_account_verification_invalid", 502);
            const accountScopeId = "account_" + crypto.createHash("sha256").update(JSON.stringify([this.options.ownerId, principal.origin, identity.userId])).digest("hex");
            const previous = this.bindings.get(principal.sessionId);
            if (previous && (!samePrincipal(previous.principal, principal) || previous.binding.accountScopeId !== accountScopeId || previous.binding.authMode !== identity.authMode)) throw failure("agent_account_session_rebind_denied", 409);
            const binding: RuntimeAccountBinding = {
                accountScopeId, userId: identity.userId, authMode: identity.authMode, runtimeSessionId: principal.sessionId,
                keyId: principal.keyId, origin: principal.origin, expiresAt: new Date(Math.min(identity.expiresAt * 1000, Date.parse(principal.expiresAt))).toISOString(),
            };
            this.bindings.set(principal.sessionId, { principal, binding });
            return structuredClone(binding);
        } catch (error) {
            if (error instanceof LocalRuntimeSessionError) throw error;
            throw failure("agent_account_verifier_unavailable", 503);
        } finally {
            clearTimeout(timer);
            if (this.attempts.get(principal.sessionId) === controller) this.attempts.delete(principal.sessionId);
        }
    }

    require(value: unknown) {
        const principal = this.principal(value);
        this.prune();
        const record = this.bindings.get(principal.sessionId);
        if (!record || !samePrincipal(record.principal, principal) || Date.parse(record.binding.expiresAt) <= this.now()) throw failure("agent_account_binding_required", 401);
        return structuredClone(record.binding);
    }

    revoke(sessionId: string) {
        this.pending.delete(sessionId);
        this.bindings.delete(sessionId);
        this.attempts.get(sessionId)?.abort();
        this.attempts.delete(sessionId);
    }

    dispose() {
        this.disposed = true;
        for (const controller of this.attempts.values()) controller.abort();
        this.attempts.clear(); this.pending.clear(); this.bindings.clear();
    }

    private principal(value: unknown) {
        if (this.disposed) throw failure("agent_account_binding_required", 401);
        if (!this.options.ownerId || !/^[A-Za-z0-9_-]{1,128}$/.test(this.options.ownerId)) throw failure("agent_account_owner_required", 503);
        const parsed = principalSchema.safeParse(value);
        if (!parsed.success || Date.parse(parsed.data.expiresAt) <= this.now()) throw failure("agent_account_signed_session_required", 401);
        const principal = parsed.data;
        if (!this.origins.has(principal.origin) || !safeOrigin(principal.origin)) throw failure("agent_account_origin_denied", 403);
        return principal;
    }

    private prune() {
        const now = this.now();
        for (const [key, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(key);
        // Remember the subject after proof expiry until the signed session expires.
        // Otherwise an expired lease could let this same session silently change user.
        for (const [key, item] of this.bindings) if (Date.parse(item.principal.expiresAt) <= now) this.bindings.delete(key);
    }
}

function samePrincipal(a: RuntimeAccountPrincipal, b: RuntimeAccountPrincipal) {
    return ["runtimeInstanceId", "sessionId", "keyId", "origin", "expiresAt"].every(key => a[key] === b[key]);
}

function safeOrigin(value: string) {
    try {
        const url = new URL(value);
        return url.origin === value && !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
    } catch { return false; }
}

async function boundedJson(response: Response, signal: AbortSignal) {
    if (signal.aborted) {
        await response.body?.cancel();
        throw failure("agent_account_challenge_expired", 409);
    }
    if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        await response.body?.cancel();
        throw failure("agent_account_verification_invalid", 502);
    }
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > 8192) throw failure("agent_account_verification_invalid", 502);
            chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function failure(code: string, status: number) {
    return new LocalRuntimeSessionError(code, "工作台账号绑定未完成，请刷新登录状态后重新连接；未取得新的作品或工具权限", status);
}

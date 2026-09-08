import { LocalRuntimeClientError, type LocalRuntimeSessionClient } from "@/services/local-runtime-session";
import type { RuntimeAccountChallenge } from "@/services/api/auth";

export type RuntimeAccountBinding = {
    accountScopeId: string; userId: string; authMode: "account" | "desktop_local";
    runtimeSessionId: string; keyId: string; origin: string; expiresAt: string;
};
type Runtime = Pick<LocalRuntimeSessionClient, "connect" | "request" | "currentSession" | "revokeRemoteSession">;
type Options = {
    userId: string; origin: string; runtime: Runtime | (() => Runtime);
    issueProof(challenge: RuntimeAccountChallenge, signal?: AbortSignal): Promise<{ proof: string; expiresAt: number }>;
    now?: () => number;
    timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
};

// One panel/account owns one in-memory signed session, not another browser key
// or a business database. No business request is replayed after renewal.
export class RuntimeAccountClient {
    private active = false;
    private epoch = 0;
    private lifecycle = new AbortController();
    private binding?: RuntimeAccountBinding;
    private pending?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private runtimeInstance?: Runtime;
    private readonly now: () => number;
    private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

    constructor(private readonly options: Options) {
        this.now = options.now ?? Date.now;
        this.timers = options.timers ?? globalThis;
    }

    private get runtime() {
        return this.runtimeInstance ??= typeof this.options.runtime === "function" ? this.options.runtime() : this.options.runtime;
    }

    async connect(signal?: AbortSignal) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        if (!this.options.userId) throw accountError("agent_account_login_required", 401);
        if (!this.active) { this.active = true; this.lifecycle = new AbortController(); this.epoch += 1; }
        await this.ensureBinding(signal);
    }

    async request(path: string, init: RequestInit = {}) {
        const epoch = this.epoch;
        this.assertActive(epoch);
        await this.ensureBinding(init.signal ?? undefined);
        this.assertActive(epoch, init.signal ?? undefined);
        const response = await this.runtime.request(path, init);
        this.assertActive(epoch, init.signal ?? undefined);
        if (response.status === 401 && epoch === this.epoch) this.binding = undefined;
        return response;
    }

    currentBinding() { return this.binding ? { ...this.binding } : undefined; }

    async disconnect() {
        this.active = false; this.epoch += 1; this.lifecycle.abort();
        this.binding = undefined; this.pending = undefined;
        if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
        this.timer = undefined;
        return this.runtimeInstance?.revokeRemoteSession(AbortSignal.timeout(5_000));
    }

    private async ensureBinding(signal?: AbortSignal, force = false) {
        const epoch = this.epoch;
        this.assertActive(epoch);
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const session = this.runtime.currentSession();
        if (!force && session && this.binding?.runtimeSessionId === session.sessionId &&
            Date.parse(this.binding.expiresAt) > this.now() + 5_000) return;
        if (this.pending) {
            const pending = this.pending;
            // A caller cancelling its wait must not cancel another caller's
            // renewal, nor report a successful connection once that renewal ends.
            if (signal) {
                await new Promise<void>((resolve, reject) => {
                    const abort = () => reject(new DOMException("aborted", "AbortError"));
                    signal.addEventListener("abort", abort, { once: true });
                    pending.then(
                        () => { signal.removeEventListener("abort", abort); resolve(); },
                        error => { signal.removeEventListener("abort", abort); reject(error); },
                    );
                });
            } else await pending;
            this.assertActive(epoch, signal);
            return;
        }
        const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
        const pending = this.renew(epoch, combined).finally(() => { if (this.pending === pending) this.pending = undefined; });
        this.pending = pending;
        await pending;
    }

    private async renew(epoch: number, signal: AbortSignal) {
        const connected = await this.runtime.connect(signal);
        this.assertActive(epoch, signal);
        if (connected.state !== "connected") throw accountError("agent_account_connection_required", 401);
        const session = connected.session;
        const challengeBody = await this.json("/agent/account/challenge", {}, signal);
        this.assertActive(epoch, signal);
        const challenge = challengeBody.challenge as RuntimeAccountChallenge | undefined;
        if (!challenge || challenge.runtimeSessionId !== session.sessionId || challenge.keyId !== session.keyId || challenge.origin !== this.options.origin ||
            [challenge.runtimeInstanceId, challenge.runtimeSessionId, challenge.keyId, challenge.nonce].some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value))) throw accountError("agent_account_challenge_invalid", 502);
        const proof = await this.options.issueProof(challenge, signal);
        this.assertActive(epoch, signal);
        if (typeof proof.proof !== "string" || proof.proof.length > 6144 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(proof.proof)) throw accountError("agent_account_proof_invalid", 502);
        const result = await this.json("/agent/account/bind", { proof: proof.proof }, signal);
        this.assertActive(epoch, signal);
        const binding = result.binding as RuntimeAccountBinding | undefined;
        if (!binding || binding.runtimeSessionId !== session.sessionId || binding.keyId !== session.keyId || binding.origin !== this.options.origin ||
            !/^account_[a-f0-9]{64}$/.test(binding.accountScopeId) || !["account", "desktop_local"].includes(binding.authMode) ||
            !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= this.now() ||
            Date.parse(binding.expiresAt) > Math.min(Date.parse(session.expiresAt), this.now() + 65_000) ||
            this.runtime.currentSession()?.sessionId !== session.sessionId) throw accountError("agent_account_binding_invalid", 502);
        if (binding.userId !== this.options.userId) {
            await this.disconnect().catch(() => undefined);
            throw accountError("agent_account_user_changed", 403);
        }
        this.binding = { accountScopeId: binding.accountScopeId, userId: binding.userId, authMode: binding.authMode,
            runtimeSessionId: binding.runtimeSessionId, keyId: binding.keyId, origin: binding.origin, expiresAt: binding.expiresAt };
        this.schedule(epoch, Math.max(1000, Math.min(30_000, (Date.parse(binding.expiresAt) - this.now()) / 2)));
    }

    private schedule(epoch: number, delay: number) {
        if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
        this.timer = this.timers.setTimeout(() => {
            this.timer = undefined;
            if (!this.active || epoch !== this.epoch) return;
            void this.ensureBinding(undefined, true).catch(() => {
                if (!this.active || epoch !== this.epoch) return;
                this.binding = undefined;
                this.schedule(epoch, 5_000);
            });
        }, delay);
    }

    private assertActive(epoch: number, signal?: AbortSignal) {
        if (!this.active || epoch !== this.epoch || signal?.aborted) throw new DOMException("aborted", "AbortError");
    }

    private async json(path: string, body: Record<string, unknown>, signal: AbortSignal) {
        const response = await this.runtime.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
        if (!response.ok) throw accountError("agent_account_binding_failed", response.status);
        const text = await response.text();
        if (text.length > 8192) throw accountError("agent_account_binding_invalid", 502);
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(text); } catch { throw accountError("agent_account_binding_invalid", 502); }
        if (!parsed || typeof parsed !== "object" || parsed.ok !== true) throw accountError("agent_account_binding_invalid", 502);
        return parsed;
    }
}

function accountError(code: string, status: number) {
    return new LocalRuntimeClientError(code, "工作台账号连接尚未完成，请检查登录状态；未重发创作或保存请求", status);
}

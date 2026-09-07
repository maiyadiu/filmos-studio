import type { ProviderTaskReceipt, ProductionAuthorizationBundle, ProductionCandidate, ProductionGenerationAuthority, ProductionPreviewBundle, ProductionTraceEvent } from "./production-composition";
import type { AcceptanceMockBindings } from "./acceptance-production-contract";

const DEFAULT_FILM_CORE_BASE_URL = "http://127.0.0.1:17650/film";

export class FilmCoreHttpProductionGenerationAuthority implements ProductionGenerationAuthority {
    constructor(
        private readonly guardReader: (preview?: ProductionPreviewBundle) => Promise<ReadonlyMap<string, { version: number; contentHash: string }>>,
        private readonly baseUrl = DEFAULT_FILM_CORE_BASE_URL,
        // Packaged WebKit/Chromium requires native fetch to keep its global
        // receiver. Node accepts the unbound function, which hid this failure
        // from unit tests until the candidate App black-box run.
        private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    ) {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname.replace(/\/$/, "") !== "/film") throw new Error("FILM_CORE_PRODUCTION_AUTHORITY_LOOPBACK_REQUIRED");
    }

    async persistPreview(bundle: ProductionPreviewBundle) {
        await this.request("/generation-production/previews", { method: "POST", body: bundle });
    }
    async ensureAcceptanceAuthority(projectId: string, projectName: string, bindings: AcceptanceMockBindings): Promise<AcceptanceMockBindings> {
        await this.request("/generation-production/acceptance-authority", { method: "POST", body: { projectId, projectName, bindings } });
        const stored = await this.read<{
            projectId: string;
            projectName: string;
            bindings: AcceptanceMockBindings;
        }>(await this.fetchImpl(`${this.baseUrl}/generation-production/acceptance-authority/${encodeURIComponent(projectId)}`, { credentials: "omit", cache: "no-store" }));
        if (stored.projectId !== projectId || stored.projectName !== projectName) throw new Error("FILM_CORE_ACCEPTANCE_AUTHORITY_MISMATCH");
        return stored.bindings;
    }
    async ensureProjectAuthority<TBindings>(projectId: string, projectName: string, bindings: TBindings): Promise<TBindings> {
        await this.request("/generation-production/project-authority", { method: "POST", body: { projectId, projectName, bindings } });
        const stored = await this.read<{ projectId: string; projectName: string; bindings: TBindings }>(
            await this.fetchImpl(`${this.baseUrl}/generation-production/project-authority/${encodeURIComponent(projectId)}`, { credentials: "omit", cache: "no-store" }),
        );
        if (stored.projectId !== projectId || stored.projectName !== projectName) throw new Error("FILM_CORE_PROJECT_AUTHORITY_MISMATCH");
        return stored.bindings;
    }
    async loadProjectAuthority<TBindings>(projectId: string): Promise<{ projectId: string; projectName: string; bindings: TBindings } | undefined> {
        return this.optional<{ projectId: string; projectName: string; bindings: TBindings }>(`/generation-production/project-authority/${encodeURIComponent(projectId)}`);
    }
    async loadPreview(proposalId: string) {
        return this.optional<ProductionPreviewBundle>(`/generation-production/previews/${encodeURIComponent(proposalId)}`);
    }
    async recordRejection(proposalId: string, decisionId: string, traceEvent: ProductionTraceEvent) {
        await this.request(`/generation-production/previews/${encodeURIComponent(proposalId)}/reject`, { method: "POST", body: { decisionId, traceEvent } });
    }
    async reserveAndAuthorize(bundle: ProductionAuthorizationBundle) {
        await this.request("/generation-production/authorizations", { method: "POST", body: bundle });
    }
    async loadAuthorized(id: string) {
        return this.optional<ProductionAuthorizationBundle>(`/generation-production/authorizations/${encodeURIComponent(id)}`);
    }
    async currentGuards(preview?: ProductionPreviewBundle) {
        return this.guardReader(preview);
    }
    async loadProviderReceipt(key: string) {
        return this.optional<ProviderTaskReceipt>(`/generation-production/provider-receipts/${encodeURIComponent(key)}`);
    }
    async persistExecutionResult(authorization: ProductionAuthorizationBundle, receipt: ProviderTaskReceipt) {
        return await this.request<ProductionCandidate>("/generation-production/execution-results", { method: "POST", body: { authorization, receipt } });
    }
    async releaseAuthorization(authorization: ProductionAuthorizationBundle, reasonCode: string) {
        await this.request("/generation-production/authorization-release", { method: "POST", body: { authorization, reasonCode } });
    }
    async markReconciliationRequired(authorization: ProductionAuthorizationBundle, reasonCode: string) {
        await this.request("/generation-production/authorization-reconciliation", { method: "POST", body: { authorization, reasonCode } });
    }
    async loadCandidateByAttempt(attemptId: string) {
        return this.optional<ProductionCandidate>(`/generation-production/candidates/by-attempt/${encodeURIComponent(attemptId)}`);
    }

    private async optional<T>(path: string): Promise<T | undefined> {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { credentials: "omit", cache: "no-store" });
        if (response.status === 404) {
            await response.body?.cancel().catch(() => undefined);
            return undefined;
        }
        return this.read<T>(response);
    }

    private async request<T>(path: string, options: { method: "POST"; body: unknown }): Promise<T> {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: options.method, credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) });
        return this.read<T>(response);
    }

    private async read<T>(response: Response): Promise<T> {
        const payload = await response.json().catch(() => undefined);
        if (!response.ok) {
            const code = typeof payload?.detail?.code === "string" ? payload.detail.code : `FILM_CORE_PRODUCTION_HTTP_${response.status}`;
            const explanations: Record<string, string> = {
                generation_production_field_invalid: "生成配置字段不完整或格式不正确，未保存",
                generation_authority_connection_mismatch: "生成路线、连接与预算绑定不一致，未保存",
                generation_authority_budget_invalid: "预算任务数、额度或单位不正确，未保存",
                generation_authority_budget_conflict: "预算绑定已变化、已关闭或额度低于已用及预留量，未保存；请重新读取配置",
                generation_authority_project_mismatch: "生成配置不属于当前项目，未保存",
            };
            // Show only a field path from the known validator, never arbitrary
            // response text that might contain a private path or credential.
            const field = code === "generation_production_field_invalid" && typeof payload?.detail?.message === "string"
                ? /^(bindings(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)+) must be /.exec(payload.detail.message)?.[1]
                : undefined;
            throw Object.assign(new Error(explanations[code] ? `${explanations[code]}${field ? `：${field}` : ""}（${code}）` : code), { code });
        }
        return payload as T;
    }
}

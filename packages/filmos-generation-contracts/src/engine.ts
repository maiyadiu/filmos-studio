import { hashEnvelope } from "./canonical.js";
import type { GenerationCatalogSnapshot, GenerationEngineConnection, GenerationEngineDescriptor } from "./types.js";
import { assertConnectionBinding } from "./identity.js";

export const GENERATION_ENGINES: readonly GenerationEngineDescriptor[] = Object.freeze([
    { engineId: "dreamina_cli", displayName: "Dreamina CLI", transport: "cli", capabilities: ["image", "video"], catalogSourceCapabilities: ["runtime_discovery", "verified_static_version_bound"], externalProjectRequired: false, supportsCostEstimate: true, supportsCancellation: true, supportsResume: true },
    { engineId: "flova_cli", displayName: "Flova CLI", transport: "project_cli", capabilities: ["image", "video"], catalogSourceCapabilities: ["runtime_discovery"], externalProjectRequired: true, supportsCostEstimate: false, supportsCancellation: false, supportsResume: false },
    { engineId: "runninghub", displayName: "RunningHub", transport: "workflow_api", capabilities: ["image", "video", "audio", "workflow"], catalogSourceCapabilities: ["remote_catalog"], externalProjectRequired: false, supportsCostEstimate: false, supportsCancellation: true, supportsResume: true },
    { engineId: "comfyui", displayName: "ComfyUI", transport: "bridge", capabilities: ["image", "video", "audio", "workflow"], catalogSourceCapabilities: ["runtime_discovery"], externalProjectRequired: false, supportsCostEstimate: false, supportsCancellation: true, supportsResume: true },
    { engineId: "manual_web", displayName: "Manual Web", transport: "manual", capabilities: ["image", "video", "audio", "workflow"], catalogSourceCapabilities: ["manual_unverified"], externalProjectRequired: false, supportsCostEstimate: false, supportsCancellation: false, supportsResume: false },
    { engineId: "filmos_mock_generation", displayName: "FilmOS Acceptance Mock", transport: "local_mock", capabilities: ["image"], catalogSourceCapabilities: ["runtime_discovery"], externalProjectRequired: false, supportsCostEstimate: true, supportsCancellation: false, supportsResume: true },
]);

export function assertGenerationEngineConnectionInvariant(connection: GenerationEngineConnection): void {
    assertConnectionBinding(connection);
    if (connection.authScope === "account" && !connection.accountBindingRef && connection.status === "ready") throw new Error("GENERATION_CONNECTION_ACCOUNT_BINDING_REQUIRED");
}

export function assertGenerationEngineConnectionRoutable(connection: GenerationEngineConnection): void {
    assertGenerationEngineConnectionInvariant(connection);
    if (!connection.enabled || connection.status !== "ready") throw new Error("GENERATION_CONNECTION_NOT_ROUTABLE");
}

export class AccountScopedCatalogCache {
    private readonly entries = new Map<string, GenerationCatalogSnapshot>();
    constructor(private readonly maxEntries = 16) { if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("CATALOG_CACHE_BOUND_INVALID"); }
    private key(input: Pick<GenerationCatalogSnapshot, "engineId" | "connectionId" | "accountBindingRef" | "connectionInstanceRef">) { return `${input.engineId}\0${input.connectionId}\0${input.accountBindingRef ?? "anonymous"}\0${input.connectionInstanceRef}`; }
    put(snapshot: GenerationCatalogSnapshot): void { const key = this.key(snapshot); this.entries.delete(key); this.entries.set(key, snapshot); while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string); }
    get(scope: Pick<GenerationCatalogSnapshot, "engineId" | "connectionId" | "accountBindingRef" | "connectionInstanceRef">, now: string): GenerationCatalogSnapshot | undefined { const key = this.key(scope); const hit = this.entries.get(key); if (!hit || Date.parse(now) > Date.parse(hit.catalogValidUntil)) { this.entries.delete(key); return undefined; } this.entries.delete(key); this.entries.set(key, hit); return hit; }
    purgeConnection(connectionId: string): void { for (const [key, value] of this.entries) if (value.connectionId === connectionId) this.entries.delete(key); }
    get size(): number { return this.entries.size; }
}

export async function hashGenerationEngineConnection(connection: Omit<GenerationEngineConnection, "contentHash">): Promise<string> { return hashEnvelope("generation-engine-connection", connection as unknown as Record<string, unknown>); }

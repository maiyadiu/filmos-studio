import type {
    GenerationCatalogSnapshot,
    GenerationEngineConnection,
} from "@filmos/generation-contracts";

import type {
    AuthorizedProviderSubmission,
    ProductionGenerationProviderAdapter,
    ProviderCostPreview,
    ProviderOutputReceipt,
    ProviderReadiness,
    ProviderTaskLookup,
    ProviderTaskReceipt,
    ProviderTaskStatus,
} from "./production-composition";

export const PRODUCTION_PROVIDER_ENGINE_IDS = [
    "filmos_mock_generation",
    "dreamina_cli",
    "runninghub",
    "comfyui",
    "flova_cli",
    "manual_web",
] as const;

export type ProductionProviderEngineId = (typeof PRODUCTION_PROVIDER_ENGINE_IDS)[number];

export type ProductionProviderExecutionPort = {
    submit(input: AuthorizedProviderSubmission): Promise<ProviderTaskReceipt>;
    getStatus(input: ProviderTaskLookup): Promise<ProviderTaskStatus>;
    reconcile(input: ProviderTaskLookup): Promise<ProviderTaskStatus>;
    downloadOutputs(input: ProviderTaskReceipt): Promise<ProviderOutputReceipt[]>;
};

export type ProductionProviderAdapterBinding = {
    engineId: Exclude<ProductionProviderEngineId, "filmos_mock_generation">;
    connection: GenerationEngineConnection;
    catalog?: GenerationCatalogSnapshot;
    readiness?: ProviderReadiness;
    supportsHardLockedReferences: boolean;
    costPreview?: ProviderCostPreview;
    execution?: ProductionProviderExecutionPort;
};

/**
 * Common production adapter. It only accepts an immutable authorization bundle;
 * exact descriptor, workflow, external project and references are never resolved here.
 */
export class BoundProductionGenerationProviderAdapter implements ProductionGenerationProviderAdapter {
    readonly engineId: string;
    readonly supportsHardLockedReferences: boolean;

    constructor(private readonly binding: ProductionProviderAdapterBinding) {
        this.engineId = binding.engineId;
        this.supportsHardLockedReferences = binding.supportsHardLockedReferences;
        if (binding.connection.engineId !== binding.engineId) throw new Error("PROVIDER_ADAPTER_CONNECTION_ENGINE_MISMATCH");
        if (binding.catalog && (binding.catalog.engineId !== binding.engineId || binding.catalog.connectionId !== binding.connection.connectionId)) {
            throw new Error("PROVIDER_ADAPTER_CATALOG_SCOPE_MISMATCH");
        }
    }

    async doctor(): Promise<ProviderReadiness> {
        if (this.binding.readiness) return structuredClone(this.binding.readiness);
        return {
            state: this.binding.connection.status === "ready" ? "ready" : this.binding.connection.status,
            code: `ENGINE_${this.binding.connection.status.toUpperCase()}`,
            checkedAt: this.binding.connection.lastCheckedAt || this.binding.connection.updatedAt,
        };
    }

    async getConnectionScope(): Promise<GenerationEngineConnection> {
        return structuredClone(this.binding.connection);
    }

    async refreshCatalog(): Promise<GenerationCatalogSnapshot> {
        if (!this.binding.catalog) {
            if (this.engineId === "flova_cli") throw new Error("READY_FOR_USER_SELECTION");
            if (this.engineId === "manual_web") throw new Error("MANUAL_GENERATION_PACKAGE_ONLY");
            throw new Error("GENERATION_CATALOG_NOT_CONFIGURED");
        }
        return structuredClone(this.binding.catalog);
    }

    async preview(): Promise<ProviderCostPreview> {
        return structuredClone(this.binding.costPreview || {
            costUnit: this.binding.catalog?.models[0]?.billing.currencyOrUnit || "unknown",
            estimatedCostMicrounits: "0",
            estimateAvailable: false,
            externalWritePerformed: false,
        });
    }

    async submit(input: AuthorizedProviderSubmission): Promise<ProviderTaskReceipt> {
        this.assertFrozenScope(input);
        if (!this.binding.execution) {
            if (this.engineId === "flova_cli") throw new Error("READY_FOR_USER_SELECTION");
            if (this.engineId === "manual_web") throw new Error("MANUAL_GENERATION_PACKAGE_AWAITING_IMPORT");
            throw new Error("READY_FOR_USER_AUTHORIZATION");
        }
        return this.binding.execution.submit(input);
    }

    async getStatus(input: ProviderTaskLookup): Promise<ProviderTaskStatus> {
        if (!this.binding.execution) throw new Error("PROVIDER_TASK_RECEIPT_REQUIRED");
        return this.binding.execution.getStatus(input);
    }

    async reconcile(input: ProviderTaskLookup): Promise<ProviderTaskStatus> {
        if (!this.binding.execution) throw new Error("PROVIDER_RECONCILIATION_SOURCE_REQUIRED");
        return this.binding.execution.reconcile(input);
    }

    async downloadOutputs(input: ProviderTaskReceipt): Promise<ProviderOutputReceipt[]> {
        if (!this.binding.execution) throw new Error("PROVIDER_OUTPUT_RECEIPT_REQUIRED");
        return this.binding.execution.downloadOutputs(input);
    }

    private assertFrozenScope(input: AuthorizedProviderSubmission) {
        const { preview, authorizedSubmission } = input.authorization;
        if (preview.routeSnapshot.engineId !== this.engineId) throw new Error("PROVIDER_ADAPTER_AUTHORIZED_ENGINE_MISMATCH");
        if (preview.routeSnapshot.connectionId !== this.binding.connection.connectionId) throw new Error("PROVIDER_ADAPTER_AUTHORIZED_CONNECTION_MISMATCH");
        if (authorizedSubmission.routeContentHash !== preview.routeSnapshot.routeContentHash) throw new Error("PROVIDER_ADAPTER_AUTHORIZED_ROUTE_TAMPERED");
        if (authorizedSubmission.descriptorReceiptContentHash !== preview.descriptorReceipt.contentHash) throw new Error("PROVIDER_ADAPTER_AUTHORIZED_DESCRIPTOR_TAMPERED");
        if (authorizedSubmission.providerInputAuthorizationContentHash !== input.authorization.inputAuthorization.contentHash) throw new Error("PROVIDER_ADAPTER_AUTHORIZED_INPUT_TAMPERED");
    }
}

export class ProductionProviderAdapterRegistry {
    private readonly adapters = new Map<string, ProductionGenerationProviderAdapter>();

    register(adapter: ProductionGenerationProviderAdapter): this {
        if (!PRODUCTION_PROVIDER_ENGINE_IDS.includes(adapter.engineId as ProductionProviderEngineId)) throw new Error("PROVIDER_ADAPTER_ENGINE_UNREGISTERED");
        if (this.adapters.has(adapter.engineId)) throw new Error("PROVIDER_ADAPTER_DUPLICATE");
        this.adapters.set(adapter.engineId, adapter);
        return this;
    }

    require(engineId: string): ProductionGenerationProviderAdapter {
        const adapter = this.adapters.get(engineId);
        if (!adapter) throw new Error("GENERATION_PROVIDER_ADAPTER_NOT_FOUND");
        return adapter;
    }

    asMap(): ReadonlyMap<string, ProductionGenerationProviderAdapter> {
        return new Map(this.adapters);
    }

    engineIds(): string[] {
        return [...this.adapters.keys()];
    }
}

export function createBoundProductionProviderRegistry(bindings: readonly ProductionProviderAdapterBinding[]): ProductionProviderAdapterRegistry {
    const registry = new ProductionProviderAdapterRegistry();
    for (const binding of bindings) registry.register(new BoundProductionGenerationProviderAdapter(binding));
    return registry;
}

import { canonicalize } from "./canonical.js";
import { hashProjectGenerationPolicy, assertProjectGenerationPolicyV2 } from "./policy.js";
import type {
    LocalConfigMigrationResult,
    ProjectGenerationLock,
    ProjectGenerationPolicy,
    ProjectGenerationPolicyV1,
    ProjectGenerationPolicyV2,
} from "./types.js";

export type LocalConfigMigrationDecision = { result: LocalConfigMigrationResult; writeTarget: boolean; preserveLegacyReadOnly: boolean; userConfirmationRequired: boolean; reason: string };

export function decideLocalConfigMigration(input: { sourceExists: boolean; targetExists: boolean; uniqueMapping: boolean; equivalent?: boolean; requiresDeletion?: boolean; changesSecretOwner?: boolean; irreversible?: boolean }): LocalConfigMigrationDecision {
    if (!input.sourceExists) return { result: "NO_OP_EQUIVALENT", writeTarget: false, preserveLegacyReadOnly: false, userConfirmationRequired: false, reason: "legacy source absent" };
    if (!input.uniqueMapping) return { result: "SKIPPED_NEEDS_CONFIGURATION", writeTarget: false, preserveLegacyReadOnly: true, userConfirmationRequired: false, reason: "mapping is ambiguous" };
    if (input.requiresDeletion || input.changesSecretOwner || input.irreversible || (input.targetExists && input.equivalent === false)) {
        return { result: "BLOCKED_MIGRATION_CONFLICT", writeTarget: false, preserveLegacyReadOnly: true, userConfirmationRequired: true, reason: "non-equivalent or irreversible conflict" };
    }
    if (input.targetExists && input.equivalent) return { result: "NO_OP_EQUIVALENT", writeTarget: false, preserveLegacyReadOnly: true, userConfirmationRequired: false, reason: "target is equivalent" };
    return { result: "MIGRATED_AUTOMATICALLY", writeTarget: true, preserveLegacyReadOnly: true, userConfirmationRequired: false, reason: "unique reversible mapping" };
}

export function semanticallyEquivalentLocalConfig(left: unknown, right: unknown): boolean {
    return canonicalize(left) === canonicalize(right);
}

export type ProjectGenerationPolicyV1MigrationOptions = {
    budgetGrantIdsByConnection: Record<string, string>;
    projectLock?: ProjectGenerationLock;
    connectionIdByEngine?: Record<string, string>;
    now?: string;
};

export async function migrateProjectGenerationPolicyV1ToV2(
    legacy: ProjectGenerationPolicyV1,
    options: ProjectGenerationPolicyV1MigrationOptions,
): Promise<ProjectGenerationPolicyV2> {
    const connections = new Map<string, { engineId: string; connectionId: string }>();
    const remember = (engineId: string, connectionId: string) => connections.set(`${engineId}\0${connectionId}`, { engineId, connectionId });
    for (const route of Object.values(legacy.defaultRoutes)) if (route) remember(route.engineId, route.connectionId);
    for (const [engineId, binding] of Object.entries(legacy.externalProjectBindings)) remember(engineId, binding.connectionId);
    for (const engineId of legacy.allowedEngineIds) {
        if ([...connections.values()].some((item) => item.engineId === engineId)) continue;
        const connectionId = options.connectionIdByEngine?.[engineId];
        if (!connectionId) throw new Error("PROJECT_POLICY_V1_MIGRATION_CONNECTION_REQUIRED");
        remember(engineId, connectionId);
    }
    const externalProjectBindings = Object.fromEntries(Object.entries(legacy.externalProjectBindings).map(([engineId, binding]) => [engineId, [structuredClone(binding)]]));
    const updatedAt = options.now ?? legacy.updatedAt;
    const base: Omit<ProjectGenerationPolicyV2, "contentHash"> = {
        schemaVersion: 2,
        entityVersion: legacy.entityVersion + 1,
        projectId: legacy.projectId,
        allowedConnections: [...connections.values()].sort((left, right) => left.engineId.localeCompare(right.engineId) || left.connectionId.localeCompare(right.connectionId)),
        defaultRoutes: structuredClone(legacy.defaultRoutes),
        externalProjectBindings,
        budgetGrantIdsByConnection: structuredClone(options.budgetGrantIdsByConnection),
        modelLocksByTask: structuredClone(options.projectLock?.taskLocks ?? {}),
        uploadPolicy: structuredClone(legacy.uploadPolicy),
        createdAt: legacy.createdAt,
        updatedAt,
    };
    const migrated = { ...base, contentHash: await hashProjectGenerationPolicy(base) };
    assertProjectGenerationPolicyV2(migrated);
    return migrated;
}

export async function readProjectGenerationPolicyV2(input: {
    current?: ProjectGenerationPolicy;
    legacy?: ProjectGenerationPolicyV1;
    migration: ProjectGenerationPolicyV1MigrationOptions;
}): Promise<{ policy: ProjectGenerationPolicyV2; source: "v2" | "v1_migrated" }> {
    const source = input.current ?? input.legacy;
    if (!source) throw new Error("PROJECT_GENERATION_POLICY_NOT_FOUND");
    if (source.schemaVersion === 2) {
        assertProjectGenerationPolicyV2(source);
        return { policy: structuredClone(source), source: "v2" };
    }
    return { policy: await migrateProjectGenerationPolicyV1ToV2(source, input.migration), source: "v1_migrated" };
}

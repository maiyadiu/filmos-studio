import { canonicalize } from "./canonical.js";
import type { LocalConfigMigrationResult } from "./types.js";

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

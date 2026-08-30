# Local Config Migration Plan

1. Desktop exposes a same-origin bridge to its Application Support user-config repository.
2. Read scoped legacy `open_ai_canvas:ai_config_store` once; create backup and append migration journal before mutation.
3. Unique, non-conflicting mappings migrate atomically and get a marker (`MIGRATED_AUTOMATICALLY` or `NO_OP_EQUIVALENT`).
4. Ambiguous channel/model/engine mappings stay read-only and become `SKIPPED_NEEDS_CONFIGURATION`; never guess.
5. Non-equivalent overwrite, deletion, secret-owner change or irreversible conversion becomes `BLOCKED_MIGRATION_CONFLICT` until user confirmation.
6. On failure restore backup and emit `FAILED_ROLLED_BACK`.
7. New versions write only the local repository; legacy localStorage is read-only for one compatibility cycle.

The migration is offline, no-login, idempotent, crash-recoverable and never moves secrets into ordinary configuration.

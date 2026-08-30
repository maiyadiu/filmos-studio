# ADR-014 Local Config No-login Migration

Status: Accepted. Scoped localStorage is migrated offline into the current OS user's Application Support repository. Deterministic mappings auto-migrate; ambiguous mappings are skipped; only destructive or non-equivalent conflicts prompt.

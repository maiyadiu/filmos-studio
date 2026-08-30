# Redaction Evidence Contract

Formal controlled artifacts retain the original pseudonymous reference/object/hash. Convenience ZIPs retain only a redacted projection, package alias, `redactedContentHash` and the same immutable RedactionReceipt. The receipt binds source type/hash, redacted type/hash, alias scope, policy version and redacted field paths using separate semantic/envelope hashes. Alias mappings remain controlled and are excluded from both ordinary project exports and convenience ZIPs.

An auditor with controlled sources can verify both sides; a ZIP-only auditor can verify the redacted side and Release Manifest receipt binding, but cannot recompute the source hash.

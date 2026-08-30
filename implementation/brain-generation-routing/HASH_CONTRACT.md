# Hash Contract

- Canonicalization: `filmos-jcs-v1`, UTF-8 canonical JSON, SHA-256.
- Domain: `filmos:<entity-type>:<semantic|envelope>:v1\0`.
- Canonical values reject non-finite numbers, negative zero, unstable collection order, secrets and machine paths.
- Semantic projection excludes IDs/timestamps/transient URLs/audit metadata and all hash fields unless the entity contract says an ID is semantic.
- Envelope projection excludes only its own `contentHash`; it includes semantic hash, ownership, snapshot ID and immutable timestamps.
- Redacted projections use `filmos:redacted-evidence:projection:v1\0` and `redactedContentHash`; original hashes do not directly verify redacted JSON.
- Canonical unsigned microunits are ASCII integer strings matching `^(0|[1-9][0-9]*)$`. Signed ledger deltas match `^(0|[1-9][0-9]*|-[1-9][0-9]*)$`; no decimal point, exponent, plus sign, grouping, whitespace, leading zero or negative zero is accepted.

Every immutable type tests semantic stability and envelope metadata tamper detection.

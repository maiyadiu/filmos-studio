# Upstream Compatibility Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/receipt.json`
- Receipt SHA-256: `c921d3fe3119831bad66cf85926ee7b3a6776b9fb19fe21f70a1a83e20f763d8`
- Started from Commit: `e62af357dc6e8b1aefb0eee8fa23cd06acead92a`
- Source snapshot SHA-256: `751b9775f896600514b1a502f7c87105b43a90af539b4b25194d482e72e090d1`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/upstream-compatibility.log` | `8bd984e565f24d406d56a0e4b105860f3ed2c635eb3a3e07ea80f537fdefe9bf` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/rc-recovery.log` | `79f140a22090d3313bc95eb3acea2e724e6e518bf35a092eec9b528a0728ec74` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

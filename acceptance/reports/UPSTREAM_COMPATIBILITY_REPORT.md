# Upstream Compatibility Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/receipt.json`
- Receipt SHA-256: `f5b3e9b24e8088f9529d8e2205c92a5f2eefbab7bf4757eda4e9007a675dc1b7`
- Started from Commit: `bdec33ced224ea3aedc984aad426d1c20c9fc4f7`
- Source snapshot SHA-256: `64a65f6fda5367ae874c6d6323f12e0c89efa2e33bb5566aa7d56b7bc8a547fa`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/upstream-compatibility.log` | `85e9095b179355411bc2452550aa21e755d1f197e9f2a75102a0e3a26a4a5e4a` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/rc-recovery.log` | `524c96e5a3d12817980e67538878c8b254346bdf29fdef5bd99dcc2d148bc77e` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

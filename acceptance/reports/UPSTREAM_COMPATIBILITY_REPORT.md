# Upstream Compatibility Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260829T235731Z-e2ed10924c7f-rc-local/receipt.json`
- Receipt SHA-256: `7393946765b2f60348e8ae687f29b9c9f74793fa243b12bbf816df7387b99360`
- Started from Commit: `e2ed10924c7fb7679ac80bc78281c6d3d9e3083e`
- Source snapshot SHA-256: `8c93725a8ecffb63617df0e1c07fcdfb62e8aa6207156a3b42e67f82b81c7f08`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/upstream-compatibility.log` | `66e7c49bfb4ae161a4fdb8b7730098139e872387ca3e392bacbb206725bdb866` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/rc-recovery.log` | `13e4a617c04e77ea548a9cb1e5e0a93f8a03551594195a3fd4617564dc7fca76` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

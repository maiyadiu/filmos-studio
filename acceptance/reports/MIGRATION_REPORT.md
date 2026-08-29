# Migration Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260829T235731Z-e2ed10924c7f-rc-local/receipt.json`
- Receipt SHA-256: `7393946765b2f60348e8ae687f29b9c9f74793fa243b12bbf816df7387b99360`
- Started from Commit: `e2ed10924c7fb7679ac80bc78281c6d3d9e3083e`
- Source snapshot SHA-256: `8c93725a8ecffb63617df0e1c07fcdfb62e8aa6207156a3b42e67f82b81c7f08`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/rc-recovery.log` | `13e4a617c04e77ea548a9cb1e5e0a93f8a03551594195a3fd4617564dc7fca76` |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/upstream-compatibility.log` | `66e7c49bfb4ae161a4fdb8b7730098139e872387ca3e392bacbb206725bdb866` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |

## Scope and boundary

Synthetic migration, exact recovery and backup restoration are automated. The recovery runner creates an isolated bare repository by fetching the exact frozen Yingce Stable and Candidate objects and verifies both trees before the drill. No real user database is opened by this report. Upstream remains `C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback receipt exists.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

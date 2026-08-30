# Migration Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/receipt.json`
- Receipt SHA-256: `169785e02d0eaac6595dd57dd453de2444b87d5adb5ac0c25bc595ff3d6fbbc2`
- Started from Commit: `2cbabd8156ee65e614459e8d43bc665ee525e501`
- Source snapshot SHA-256: `02fdb0f8690312907e10fde757f53e77b68904c2deda16b8161b2c147df40942`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/rc-recovery.log` | `03f3b762b340af7378404b88390313f4e940625ef054d29c6b402e78c6ff7b03` |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/upstream-compatibility.log` | `f806181a136b2c243c8e81e11b7b8ae163d677183533c7f893eac3c8fcd7b25c` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |

## Scope and boundary

Synthetic migration, exact recovery and backup restoration are automated. The recovery runner creates an isolated bare repository by fetching the exact frozen Yingce Stable and Candidate objects and verifies both trees before the drill. No real user database is opened by this report. Upstream remains `C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback receipt exists.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

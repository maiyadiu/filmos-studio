# Upstream Compatibility Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/receipt.json`
- Receipt SHA-256: `169785e02d0eaac6595dd57dd453de2444b87d5adb5ac0c25bc595ff3d6fbbc2`
- Started from Commit: `2cbabd8156ee65e614459e8d43bc665ee525e501`
- Source snapshot SHA-256: `02fdb0f8690312907e10fde757f53e77b68904c2deda16b8161b2c147df40942`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/upstream-compatibility.log` | `f806181a136b2c243c8e81e11b7b8ae163d677183533c7f893eac3c8fcd7b25c` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/rc-recovery.log` | `03f3b762b340af7378404b88390313f4e940625ef054d29c6b402e78c6ff7b03` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

# Migration Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/receipt.json`
- Receipt SHA-256: `858fc68c380dc3d1bcc2d6e02e017d8034c0d840a0c85c60c427c31aa74ac4ca`
- Started from Commit: `0b6a11cfbe92e84b901e62fcec24ff79d3b6a158`
- Source snapshot SHA-256: `6151f72e376995a57410835d7ca5c0e7336ae0f3c3b4d18366ba5c78d1f7fdd0`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/rc-recovery.log` | `349268e5ab4a336b35afb4957cac5efc5500da832d09938efc1edf554a072745` |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/upstream-compatibility.log` | `558abe9067fad7b4945e326dabcb8fa78d982702baabadf272d69a60a3af5976` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |

## Scope and boundary

Synthetic migration, exact recovery and backup restoration are automated. The recovery runner creates an isolated bare repository by fetching the exact frozen Yingce Stable and Candidate objects and verifies both trees before the drill. No real user database is opened by this report. Upstream remains `C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback receipt exists.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

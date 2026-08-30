# Migration Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260830T164746Z-b12b1ba108a9-rc-local/receipt.json`
- Receipt SHA-256: `0de021df68ebb75e42c702771480aeddd49566bc6f454bdd4356d295a2a50b43`
- Started from Commit: `b12b1ba108a926470614b2e6a231d333d1a1d00f`
- Source snapshot SHA-256: `d0888cb19b878a71e66299c50abb50c94303be14c4fa42720d754bf832338050`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/rc-recovery.log` | `d2b445a31a9e4ce0eaf8c4d43d02ba1f73a0ecbd07b80f024037d82977a02923` |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/upstream-compatibility.log` | `e79751f67e0885e12abc15002b662fd3a2d675f834e3af415e1bd82ecb3634cc` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-backup-restore.log` | `5df89621fe6106650eecd0c57ddcf0b1810e89d387f4c5fe4a5ee6823bb0070b` |

## Scope and boundary

Synthetic migration, exact recovery and backup restoration are automated. The recovery runner creates an isolated bare repository by fetching the exact frozen Yingce Stable and Candidate objects and verifies both trees before the drill. No real user database is opened by this report. Upstream remains `C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback receipt exists.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

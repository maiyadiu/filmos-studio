# Migration Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/receipt.json`
- Receipt SHA-256: `5981dc29ba5859699790a97890d1de40fdeb58572b44b239a0b5585789f15cb1`
- Started from Commit: `a45effee4fe282db80f444cb18500533e270178f`
- Source snapshot SHA-256: `4c45dfa7bf9e23947df9dd5136b0dcc038ec43bdea07e83e4720dc4c1f26b30b`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `rc-recovery` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/rc-recovery.log` | `4d10195df20c559b23c2725dfd976a3fa4e5199a4ea499ae6a36de02b37c60ec` |
| `upstream-compatibility` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/upstream-compatibility.log` | `aa8c50a0ec59c1cfe7726b1c84ccf449342dc965f30a0ac517bf009444cf128d` |
| `desktop-backup-restore` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/desktop-backup-restore.log` | `5df89621fe6106650eecd0c57ddcf0b1810e89d387f4c5fe4a5ee6823bb0070b` |
| `generation-routing-contracts` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/generation-routing-contracts.log` | `14d228543fa9f6ce3c1ae648f197432e335efb3e2c3875abbb243c87c3557f24` |
| `pilot-project-copy` | `NOT_IN_LOCAL_SUITE` | `-` | `-` |
| `use-driven-dual-expert` | `NOT_IN_LOCAL_SUITE` | `-` | `-` |

## Scope and boundary

Synthetic migration, exact recovery and backup restoration are automated. The recovery runner creates an isolated bare repository by fetching the exact frozen Yingce Stable and Candidate objects and verifies both trees before the drill. No real user database is opened by this report. Upstream remains `C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback receipt exists. ProjectGenerationPolicy V1 is deterministically mapped to V2 one-element connection, route, budget, binding and lock collections; the V1 reader remains available for rollback. Pilot uses a project-scoped copy and never mutates the only formal database.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

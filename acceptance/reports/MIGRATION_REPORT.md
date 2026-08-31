# Migration Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260831T064657Z-6ea93bfa0838-rc-local/receipt.json`
- Receipt SHA-256: `99ca3581eb9e142ad23bef5a964e903688ebb18c5dd95e5f70f0bcbdfa6fd066`
- Started from Commit: `6ea93bfa08381264a1379fe938ade3a7513c7bba`
- Source snapshot SHA-256: `4cb0029a8826ddbb70698198808de5f094dea9adce3deb2001a35d72f16849e6`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/rc-recovery.log` | `906b70a63c741f49df212094efbbefe5a32c7f1d61a6375965a5252eb0be4ee2` |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/upstream-compatibility.log` | `4bc16c109a13cf141f74ebc9a58cc364959a3d9e9b74071dddbe602f37ef6107` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/desktop-backup-restore.log` | `5df89621fe6106650eecd0c57ddcf0b1810e89d387f4c5fe4a5ee6823bb0070b` |
| `generation-routing-contracts` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/generation-routing-contracts.log` | `64a494a6101563e0dd04a76576e51caecb38d91aef87917cd05a38a7795edcde` |
| `pilot-project-copy` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/pilot-project-copy.log` | `6ece9c4c80ae82ba1bc770fd157126a3fc48e691fa4c4cddfdfe272bd283e1cf` |
| `use-driven-dual-expert` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/use-driven-dual-expert.log` | `6fabd368c86321198038f7dbb7aaf3691ee6beec7e0619baf3cd2e286f377e10` |

## Scope and boundary

Synthetic migration, exact recovery and backup restoration are automated. The recovery runner creates an isolated bare repository by fetching the exact frozen Yingce Stable and Candidate objects and verifies both trees before the drill. No real user database is opened by this report. Upstream remains `C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback receipt exists. ProjectGenerationPolicy V1 is deterministically mapped to V2 one-element connection, route, budget, binding and lock collections; the V1 reader remains available for rollback. Pilot uses a project-scoped copy and never mutates the only formal database.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

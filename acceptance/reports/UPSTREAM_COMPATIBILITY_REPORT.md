# Upstream Compatibility Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/receipt.json`
- Receipt SHA-256: `d3c787598a832a0ba5d0363daae1433ceb8ddb067e76e038c14f46b02c0e575c`
- Started from Commit: `40b5c0d7e0aee902767dc23cc51538c9ce8538db`
- Source snapshot SHA-256: `25b617719005c8f0ccbfb4110c3dea6c85f280c66557a749ca549f061453a028`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/upstream-compatibility.log` | `74826c6aaaedc898caa35f329b5ed1ebe180ca0a8da11088b0a9ff7ed5e9eca2` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/rc-recovery.log` | `a3a547ab5f1932e184418357f13502bc66a0d9d271613a56807394edc074ef64` |

## Scope and boundary

Pinned upstream compatibility and rollback tests are reproducible. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

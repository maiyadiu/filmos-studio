# Golden Test Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/receipt.json`
- Receipt SHA-256: `d3c787598a832a0ba5d0363daae1433ceb8ddb067e76e038c14f46b02c0e575c`
- Started from Commit: `40b5c0d7e0aee902767dc23cc51538c9ce8538db`
- Source snapshot SHA-256: `25b617719005c8f0ccbfb4110c3dea6c85f280c66557a749ca549f061453a028`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `golden-abc-real-http` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/golden-abc-real-http.log` | `87021467ae0b5e1fb319a6890e1775757d5657016370fe4dd00367ad762a6f10` |
| `acceptance-full-chain` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/acceptance-full-chain.log` | `b1b499387790184d890cbb07e227df8ace5e2df147cbea2524a0510c536cf71f` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/chatgpt-golden-real.log` | `c486acfb1ed9d652c3c60630a2d69e1d081df073551e79e5fc267adcae65d0d6` |

## Scope and boundary

Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance Project, desktop backup/restore and real local ChatGPT handoff. Local Provider import is never relabeled as real CLI generation.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

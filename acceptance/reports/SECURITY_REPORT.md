# Security Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/receipt.json`
- Receipt SHA-256: `d3c787598a832a0ba5d0363daae1433ceb8ddb067e76e038c14f46b02c0e575c`
- Started from Commit: `40b5c0d7e0aee902767dc23cc51538c9ce8538db`
- Source snapshot SHA-256: `25b617719005c8f0ccbfb4110c3dea6c85f280c66557a749ca549f061453a028`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/canvas-agent.log` | `f5c1b13d8d0dd500a49bb216eba89000079561d3fd36d010895445c639554ccc` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/chatgpt-handoff-local.log` | `b4ecdf76da853ad9fdf21b6739468eaedfcc3b7b6823cd432dfe4dc7589277dd` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/chatgpt-golden-real.log` | `c486acfb1ed9d652c3c60630a2d69e1d081df073551e79e5fc267adcae65d0d6` |
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/acceptance-privacy.log` | `1995add1795a61e4422f1a294339345118e8b0ab4da8aa2b7d8a9b73d422c7d5` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, ChatGPT preview boundaries and a redacted evidence package. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

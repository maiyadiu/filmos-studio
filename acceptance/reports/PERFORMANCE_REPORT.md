# Performance Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/receipt.json`
- Receipt SHA-256: `d3c787598a832a0ba5d0363daae1433ceb8ddb067e76e038c14f46b02c0e575c`
- Started from Commit: `40b5c0d7e0aee902767dc23cc51538c9ce8538db`
- Source snapshot SHA-256: `25b617719005c8f0ccbfb4110c3dea6c85f280c66557a749ca549f061453a028`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/web-production-build.log` | `5e406d8b1ff4a00a890b575fcabd69e59d7f1b43df734656b58b44ac35ad59d3` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/performance-local.log` | `b2881194cf2a40d1f184cea6f84261ac6be0f8f8f25b66fbf3602fb54ceae68b` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `16.865 ms`, project context `2.885 ms`, entity read `0.871 ms`, command preview `0.639 ms`, Remote preview `2.887 ms`, Agent read/preview/deny `0.163 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

# Performance Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260830T164746Z-b12b1ba108a9-rc-local/receipt.json`
- Receipt SHA-256: `0de021df68ebb75e42c702771480aeddd49566bc6f454bdd4356d295a2a50b43`
- Started from Commit: `b12b1ba108a926470614b2e6a231d333d1a1d00f`
- Source snapshot SHA-256: `d0888cb19b878a71e66299c50abb50c94303be14c4fa42720d754bf832338050`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/web-production-build.log` | `4a41378436a0fe9f2b231af32a90f4960662a75d8a6c5054d207207c33652ee7` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/performance-local.log` | `2f4e821eccc17affc2f831bfea58ec1762a16df46886bd833ac4db27b6c87efd` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `19.527 ms`, project context `3.948 ms`, entity read `0.816 ms`, command preview `0.793 ms`, Remote preview `3.446 ms`, Agent read/preview/deny `0.183 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

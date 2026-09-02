# Performance Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/receipt.json`
- Receipt SHA-256: `5981dc29ba5859699790a97890d1de40fdeb58572b44b239a0b5585789f15cb1`
- Started from Commit: `a45effee4fe282db80f444cb18500533e270178f`
- Source snapshot SHA-256: `4c45dfa7bf9e23947df9dd5136b0dcc038ec43bdea07e83e4720dc4c1f26b30b`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/web-production-build.log` | `1773b85b4ac3b5104a1a93c888ed37a161711f94eca93ab99a59d4c633282709` |
| `performance-local` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/performance-local.log` | `656fff37bc89914bfb9b29a477c3cd0a2b21d88fd528d3e9cdb8d33fd96b5263` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `19.53 ms`, project context `8.816 ms`, entity read `0.774 ms`, command preview `0.885 ms`, Remote preview `3.662 ms`, Agent read/preview/deny `0.318 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

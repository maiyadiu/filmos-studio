# Performance Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/receipt.json`
- Receipt SHA-256: `c921d3fe3119831bad66cf85926ee7b3a6776b9fb19fe21f70a1a83e20f763d8`
- Started from Commit: `e62af357dc6e8b1aefb0eee8fa23cd06acead92a`
- Source snapshot SHA-256: `751b9775f896600514b1a502f7c87105b43a90af539b4b25194d482e72e090d1`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/web-production-build.log` | `3f597890e907c527364985ba22d1eb3bf1fc39b955c293d4fad9e9c9cac516ba` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/performance-local.log` | `92e9f081d749f111ad12d0ef1522db1a6246670a0825d7479817a82edbc0883d` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `17.511 ms`, project context `2.861 ms`, entity read `0.589 ms`, command preview `0.55 ms`, Remote preview `3.002 ms`, Agent read/preview/deny `0.152 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

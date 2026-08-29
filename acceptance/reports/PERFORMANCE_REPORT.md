# Performance Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260829T235731Z-e2ed10924c7f-rc-local/receipt.json`
- Receipt SHA-256: `7393946765b2f60348e8ae687f29b9c9f74793fa243b12bbf816df7387b99360`
- Started from Commit: `e2ed10924c7fb7679ac80bc78281c6d3d9e3083e`
- Source snapshot SHA-256: `8c93725a8ecffb63617df0e1c07fcdfb62e8aa6207156a3b42e67f82b81c7f08`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/web-production-build.log` | `5ade225321c9b8e3e0f7d83b190fbf76c87a5ddec907e17259d125005d2a7723` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/performance-local.log` | `2af744368b16d424ddfe72546cd134d4e553f62294da74b92cec088bfc68d39c` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `16.654 ms`, project context `2.811 ms`, entity read `0.557 ms`, command preview `0.555 ms`, Remote preview `2.985 ms`, Agent read/preview/deny `0.161 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

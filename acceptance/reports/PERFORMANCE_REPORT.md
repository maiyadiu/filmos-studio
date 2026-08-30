# Performance Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/receipt.json`
- Receipt SHA-256: `169785e02d0eaac6595dd57dd453de2444b87d5adb5ac0c25bc595ff3d6fbbc2`
- Started from Commit: `2cbabd8156ee65e614459e8d43bc665ee525e501`
- Source snapshot SHA-256: `02fdb0f8690312907e10fde757f53e77b68904c2deda16b8161b2c147df40942`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/web-production-build.log` | `0880e17f5dab2c0aaee98e95afc378afa131197854dcbeccc5e0e35e58c34361` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/performance-local.log` | `ac4251cba6667d9373ae1dbc2932edac69f3bf4b08407887cef1b4ff149ebacf` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `23.747 ms`, project context `3.456 ms`, entity read `0.671 ms`, command preview `0.665 ms`, Remote preview `3.056 ms`, Agent read/preview/deny `0.155 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

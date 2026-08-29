# Performance Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/receipt.json`
- Receipt SHA-256: `858fc68c380dc3d1bcc2d6e02e017d8034c0d840a0c85c60c427c31aa74ac4ca`
- Started from Commit: `0b6a11cfbe92e84b901e62fcec24ff79d3b6a158`
- Source snapshot SHA-256: `6151f72e376995a57410835d7ca5c0e7336ae0f3c3b4d18366ba5c78d1f7fdd0`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/web-production-build.log` | `085d3dba1972e5b5c301bc1463cff76f4f2cf4bc60aa055a084e347e8d15f3eb` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/performance-local.log` | `ad27c283967d3e60852932a0ac923bb3ba627ca3ab7ae162b2e93b0e519f586a` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `16.524 ms`, project context `2.733 ms`, entity read `0.559 ms`, command preview `0.564 ms`, Remote preview `2.754 ms`, Agent read/preview/deny `0.369 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

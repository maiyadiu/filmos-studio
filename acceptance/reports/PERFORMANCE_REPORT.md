# Performance Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/receipt.json`
- Receipt SHA-256: `f5b3e9b24e8088f9529d8e2205c92a5f2eefbab7bf4757eda4e9007a675dc1b7`
- Started from Commit: `bdec33ced224ea3aedc984aad426d1c20c9fc4f7`
- Source snapshot SHA-256: `64a65f6fda5367ae874c6d6323f12e0c89efa2e33bb5566aa7d56b7bc8a547fa`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/web-production-build.log` | `65ff19586b5ef574c2fbdec994d5ea2b5ae0eab422c8fae4f7d09715256270b4` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/performance-local.log` | `ea29a142426f8fa2d48ed11f007f3c5863c86ef267b90274d26b88cb72de4955` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `19.626 ms`, project context `3.346 ms`, entity read `0.682 ms`, command preview `0.724 ms`, Remote preview `3.46 ms`, Agent read/preview/deny `0.163 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

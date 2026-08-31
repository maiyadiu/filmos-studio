# Performance Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260831T064657Z-6ea93bfa0838-rc-local/receipt.json`
- Receipt SHA-256: `99ca3581eb9e142ad23bef5a964e903688ebb18c5dd95e5f70f0bcbdfa6fd066`
- Started from Commit: `6ea93bfa08381264a1379fe938ade3a7513c7bba`
- Source snapshot SHA-256: `4cb0029a8826ddbb70698198808de5f094dea9adce3deb2001a35d72f16849e6`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `web-production-build` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/web-production-build.log` | `2ad7a4ef9ac359073026b2046def8dad6a1ec4bbe17acbd456a1b6f6c5ac7a18` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/performance-local.log` | `d8ce6792bd9520bf026d257b9e34e00b08fddb65d4c6fde58a14d3fe8fa2926e` |

## Scope and boundary

Performance is measured against the checked-in 80-unit/80-shot and 60-sample budgets. Network actions, uploads, external Provider calls and Agent Apply remain zero. Bundle warning and blocking thresholds are reported separately.

Measured p95: app init `27.999 ms`, project context `4.003 ms`, entity read `0.902 ms`, command preview `1.0 ms`, Remote preview `3.654 ms`, Agent read/preview/deny `0.239 ms`. Largest JavaScript is `1821047` bytes; warning chunks `10`, blocking `false`.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

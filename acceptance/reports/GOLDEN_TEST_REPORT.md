# Golden Test Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/receipt.json`
- Receipt SHA-256: `f5b3e9b24e8088f9529d8e2205c92a5f2eefbab7bf4757eda4e9007a675dc1b7`
- Started from Commit: `bdec33ced224ea3aedc984aad426d1c20c9fc4f7`
- Source snapshot SHA-256: `64a65f6fda5367ae874c6d6323f12e0c89efa2e33bb5566aa7d56b7bc8a547fa`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `golden-abc-real-http` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/golden-abc-real-http.log` | `5f9a3de333e129853d97da136d05dcb9523ea307732423869228ae751b67bf29` |
| `acceptance-full-chain` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/acceptance-full-chain.log` | `1b048bbaa77c884fb2a2a98908ebd6e17200db5b28db59f57df9eac554dcdf04` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/chatgpt-golden-real.log` | `b858fd3a20ca4b634506c8d12120e4c0a908800ea36b82dfd957f922f3e78227` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-chatgpt-connection.log` | `380d6d7ee57e015f65e5bbb65b7459bd95c2a93ea09631e58a932c7efafe70f4` |

## Scope and boundary

Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance Project, desktop backup/restore and real local ChatGPT handoff. Local Provider import is never relabeled as real CLI generation.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

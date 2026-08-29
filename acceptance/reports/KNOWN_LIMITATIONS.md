# Known Limitations

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/receipt.json`
- Receipt SHA-256: `f5b3e9b24e8088f9529d8e2205c92a5f2eefbab7bf4757eda4e9007a675dc1b7`
- Started from Commit: `bdec33ced224ea3aedc984aad426d1c20c9fc4f7`
- Source snapshot SHA-256: `64a65f6fda5367ae874c6d6323f12e0c89efa2e33bb5566aa7d56b7bc8a547fa`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-release-build.log` | `2cb7befeb77c95145fcc77697761537aa99694a2e30b5bd7f68367140748576c` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-chatgpt-connection.log` | `380d6d7ee57e015f65e5bbb65b7459bd95c2a93ea09631e58a932c7efafe70f4` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/no-openai-model-api-billing.log` | `fdf14aa2cda0a10642df9d6b61bac61d1e821f67da2a5eb070e1b8ccf30fb256` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/performance-local.log` | `ea29a142426f8fa2d48ed11f007f3c5863c86ef267b90274d26b88cb72de4955` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/remote-acceptance-contract.log` | `153a86f8d976d712547c59ad7d9e0980986683010ffffe64b5cb2bb59f189663` |

## Scope and boundary

- Current evidence is development-only because the source worktree was dirty at run start.
- Real Provider CLI generation remains a separate authorized external drill; the Local-first chain uses `LOCAL_MANUAL_CANDIDATE_IMPORT`.
- External ChatGPT account acknowledgement and secure tunnel proof are not in the Local suite.
- `NO-OPENAI-MODEL-API-001` proves the checked-in runtime has no model API endpoint path; the final external Live Gate must add its own time-bounded receipt.
- Real user database migration and real rollback remain outside the synthetic recovery drill.
- The app is an internal unsigned macOS build; signing, notarization and public distribution are not claimed.
- Web JavaScript may exceed the warning budget, but must remain below the blocking budget.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

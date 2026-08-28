# Known Limitations

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/receipt.json`
- Receipt SHA-256: `d3c787598a832a0ba5d0363daae1433ceb8ddb067e76e038c14f46b02c0e575c`
- Started from Commit: `40b5c0d7e0aee902767dc23cc51538c9ce8538db`
- Source snapshot SHA-256: `25b617719005c8f0ccbfb4110c3dea6c85f280c66557a749ca549f061453a028`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/desktop-release-build.log` | `f7988f8f9007f3beda9bc246235bdca2bbdc1cd1b53fe732380b632be8a7b218` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/performance-local.log` | `b2881194cf2a40d1f184cea6f84261ac6be0f8f8f25b66fbf3602fb54ceae68b` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260828T152423Z-40b5c0d7e0ae-rc-local/remote-acceptance-contract.log` | `5043258895aa9a6ded6bbc33ab9114df25aa4dbc4fbbaed186ee211584933a54` |

## Scope and boundary

- Current evidence is development-only because the source worktree was dirty at run start.
- Real Provider CLI generation remains a separate authorized external drill; the Local-first chain uses `LOCAL_MANUAL_CANDIDATE_IMPORT`.
- External ChatGPT account acknowledgement and secure tunnel proof are not in the Local suite.
- Real user database migration and real rollback remain outside the synthetic recovery drill.
- The app is an internal unsigned macOS build; signing, notarization and public distribution are not claimed.
- Web JavaScript may exceed the warning budget, but must remain below the blocking budget.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

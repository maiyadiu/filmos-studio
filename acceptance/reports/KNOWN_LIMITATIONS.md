# Known Limitations

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/receipt.json`
- Receipt SHA-256: `858fc68c380dc3d1bcc2d6e02e017d8034c0d840a0c85c60c427c31aa74ac4ca`
- Started from Commit: `0b6a11cfbe92e84b901e62fcec24ff79d3b6a158`
- Source snapshot SHA-256: `6151f72e376995a57410835d7ca5c0e7336ae0f3c3b4d18366ba5c78d1f7fdd0`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-release-build.log` | `5cd9f0f313f3e10582bf86f2cac34593d8eb510d83e0641998112554f737d724` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-chatgpt-connection.log` | `73545f98e80242efa713fde6c3f247daccc2664549ab8329c2b74083b2d579a9` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/no-openai-model-api-billing.log` | `d21231d5523ed06fe363b1a69ab21c22ed942f73bc3a39f8ea2e87ffba3f938f` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/agent-native-multibrain.log` | `fd7476a01b54523c78f56b6d6f3d8027a2a8e2327e1e454cbbf6d3db4ac92e03` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/mcp-actual-tool-count.log` | `bfd86953bd3ce3c78ac55d0cb58cf9216ff40921c9bc4c89b6aac2babe23ed5c` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/performance-local.log` | `ad27c283967d3e60852932a0ac923bb3ba627ca3ab7ae162b2e93b0e519f586a` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/remote-acceptance-contract.log` | `153a86f8d976d712547c59ad7d9e0980986683010ffffe64b5cb2bb59f189663` |

## Scope and boundary

- Current evidence was generated from a clean fixed-commit source worktree.
- Real Codex Subscription evidence is a separate receipt because it requires managed account authorization; the report index hashes that raw receipt as a source.
- Real Provider CLI generation remains a separate authorized external drill; the Local-first chain uses `LOCAL_MANUAL_CANDIDATE_IMPORT`.
- External ChatGPT account acknowledgement and secure tunnel proof are not in the Local suite.
- `NO-OPENAI-MODEL-API-001` proves the checked-in runtime has no model API endpoint path; the final external Live Gate must add its own time-bounded receipt.
- Real user database migration and real rollback remain outside the synthetic recovery drill.
- The app is an internal unsigned macOS build; signing, notarization and public distribution are not claimed.
- Web JavaScript may exceed the warning budget, but must remain below the blocking budget.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

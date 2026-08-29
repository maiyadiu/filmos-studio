# Golden Test Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/receipt.json`
- Receipt SHA-256: `858fc68c380dc3d1bcc2d6e02e017d8034c0d840a0c85c60c427c31aa74ac4ca`
- Started from Commit: `0b6a11cfbe92e84b901e62fcec24ff79d3b6a158`
- Source snapshot SHA-256: `6151f72e376995a57410835d7ca5c0e7336ae0f3c3b4d18366ba5c78d1f7fdd0`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `golden-abc-real-http` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/golden-abc-real-http.log` | `2aff1f19525585ea9bf35bb28e3bc1149a5a074856dd01e3a9cb292eca7025de` |
| `acceptance-full-chain` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/acceptance-full-chain.log` | `84bc4f85900817f40209d5d62b0d66a2ba69d853108ac77cead4a194952baac8` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/chatgpt-golden-real.log` | `0c4b13825b9f8a9ceb56fba1b86d454e36c334ee3edbad978965b9b2eff28e22` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-chatgpt-connection.log` | `73545f98e80242efa713fde6c3f247daccc2664549ab8329c2b74083b2d579a9` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/agent-native-multibrain.log` | `fd7476a01b54523c78f56b6d6f3d8027a2a8e2327e1e454cbbf6d3db4ac92e03` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/mcp-actual-tool-count.log` | `bfd86953bd3ce3c78ac55d0cb58cf9216ff40921c9bc4c89b6aac2babe23ed5c` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/no-openai-model-api-billing.log` | `d21231d5523ed06fe363b1a69ab21c22ed942f73bc3a39f8ea2e87ffba3f938f` |

## Scope and boundary

Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance Project, desktop backup/restore and real local ChatGPT handoff. Local Provider import is never relabeled as real CLI generation.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

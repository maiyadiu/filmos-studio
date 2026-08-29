# Security Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/receipt.json`
- Receipt SHA-256: `858fc68c380dc3d1bcc2d6e02e017d8034c0d840a0c85c60c427c31aa74ac4ca`
- Started from Commit: `0b6a11cfbe92e84b901e62fcec24ff79d3b6a158`
- Source snapshot SHA-256: `6151f72e376995a57410835d7ca5c0e7336ae0f3c3b4d18366ba5c78d1f7fdd0`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/canvas-agent.log` | `2b5b97145846fc411a1eacd82c60d7bda21f8a65895e6c767758ba12b1af111a` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/chatgpt-handoff-local.log` | `ec13cd53694a265584f7c5d07e51ddeb511459af088d3b941d9748c238493bf9` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/chatgpt-golden-real.log` | `0c4b13825b9f8a9ceb56fba1b86d454e36c334ee3edbad978965b9b2eff28e22` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/desktop-chatgpt-connection.log` | `73545f98e80242efa713fde6c3f247daccc2664549ab8329c2b74083b2d579a9` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/no-openai-model-api-billing.log` | `d21231d5523ed06fe363b1a69ab21c22ed942f73bc3a39f8ea2e87ffba3f938f` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/agent-native-multibrain.log` | `fd7476a01b54523c78f56b6d6f3d8027a2a8e2327e1e454cbbf6d3db4ac92e03` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/mcp-actual-tool-count.log` | `bfd86953bd3ce3c78ac55d0cb58cf9216ff40921c9bc4c89b6aac2babe23ed5c` |
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260829T174957Z-0b6a11cfbe92-rc-local/acceptance-privacy.log` | `4af2532d1175b3ed5cc29ad37d6997003af881b6edb49bd1595c001286400e17` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, ChatGPT preview boundaries and a redacted evidence package. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

# Golden Test Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/receipt.json`
- Receipt SHA-256: `c921d3fe3119831bad66cf85926ee7b3a6776b9fb19fe21f70a1a83e20f763d8`
- Started from Commit: `e62af357dc6e8b1aefb0eee8fa23cd06acead92a`
- Source snapshot SHA-256: `751b9775f896600514b1a502f7c87105b43a90af539b4b25194d482e72e090d1`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `golden-abc-real-http` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/golden-abc-real-http.log` | `530e41d75ae96baf7dddf8fcfea3024687b042e8b771057aae9a9d5b0a428c33` |
| `acceptance-full-chain` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/acceptance-full-chain.log` | `38e87039d7f277691a7ca86ddddcc5ebfc417c250a5976ad1a00b17d2c03ddae` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/chatgpt-golden-real.log` | `432cecaebebae830805aabfcbde64e50ec813f7cf2577f3f2b0f7a95a44ca36c` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/desktop-chatgpt-connection.log` | `dfb8f1e03449329bfddc67a368832db8cdc6c1dbc0460c97ef4e5498d667f606` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-native-multibrain.log` | `59a78653e9092a07ad384960cca5c685dcf458b5a2dd9b35dd8a5c869ad05f0e` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-tool-contract-single-source.log` | `01e2564063133a2ca06a8b81ec06e7c7352f2efe1c138fc9146b9f8d7ab386ec` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/no-openai-model-api-billing.log` | `10abec4d2cf0d4256ae85df08f5d8dfb2d8acbcd3dd0b95ad3d0dc01cc3c1941` |

## Scope and boundary

Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance Project, desktop backup/restore, production multi-brain composition, Candidate App activation, a real Codex Subscription reject/approve/restart drill and real local ChatGPT handoff. Local Provider import is never relabeled as real CLI generation.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

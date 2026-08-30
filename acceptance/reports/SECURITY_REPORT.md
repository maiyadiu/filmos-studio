# Security Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/receipt.json`
- Receipt SHA-256: `c921d3fe3119831bad66cf85926ee7b3a6776b9fb19fe21f70a1a83e20f763d8`
- Started from Commit: `e62af357dc6e8b1aefb0eee8fa23cd06acead92a`
- Source snapshot SHA-256: `751b9775f896600514b1a502f7c87105b43a90af539b4b25194d482e72e090d1`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/canvas-agent.log` | `821d936e7e48a1c0f9ea923cb69a940d28be7774a31c00a7c2262653e7434d11` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/chatgpt-handoff-local.log` | `02847a015bf2e368d6d975bdd8f7f6eb274ccad872c62742eb88f864f7fb0cef` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/chatgpt-golden-real.log` | `432cecaebebae830805aabfcbde64e50ec813f7cf2577f3f2b0f7a95a44ca36c` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/desktop-chatgpt-connection.log` | `dfb8f1e03449329bfddc67a368832db8cdc6c1dbc0460c97ef4e5498d667f606` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/no-openai-model-api-billing.log` | `10abec4d2cf0d4256ae85df08f5d8dfb2d8acbcd3dd0b95ad3d0dc01cc3c1941` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-native-multibrain.log` | `59a78653e9092a07ad384960cca5c685dcf458b5a2dd9b35dd8a5c869ad05f0e` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-tool-contract-single-source.log` | `01e2564063133a2ca06a8b81ec06e7c7352f2efe1c138fc9146b9f8d7ab386ec` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260830T000008Z-e62af357dc6e-rc-local/acceptance-privacy.log` | `f95182aae0631c0c5b40f8784f09d572a188c78120abe50daffd892ad85a79f6` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, signed project scopes, replay-safe controlled writes, generated tool-risk schemas, ChatGPT preview boundaries and a redacted evidence package. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

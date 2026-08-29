# Security Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260829T235731Z-e2ed10924c7f-rc-local/receipt.json`
- Receipt SHA-256: `7393946765b2f60348e8ae687f29b9c9f74793fa243b12bbf816df7387b99360`
- Started from Commit: `e2ed10924c7fb7679ac80bc78281c6d3d9e3083e`
- Source snapshot SHA-256: `8c93725a8ecffb63617df0e1c07fcdfb62e8aa6207156a3b42e67f82b81c7f08`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/canvas-agent.log` | `5a0f022be77af33196058bca968a96f5c085897182f50814c91ff447fa525dd6` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/chatgpt-handoff-local.log` | `9eca2f01dc1dfa9448ee0a6502942e90901252a73348b438dd2c8edb52b9c798` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/chatgpt-golden-real.log` | `b1698486af4943679d151110065591918e5f5f4ef5a2ce85b35b88298abc4b35` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/desktop-chatgpt-connection.log` | `b875263064980e24913dcb795dc049c0bd911eafcd6f3d2f30a09a24ae0f113d` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/no-openai-model-api-billing.log` | `d965660a5e8fb935bbbc3e78096d0019e97c9b50c1f3bf58368b63caab7107c7` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-native-multibrain.log` | `59a78653e9092a07ad384960cca5c685dcf458b5a2dd9b35dd8a5c869ad05f0e` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-tool-contract-single-source.log` | `01e2564063133a2ca06a8b81ec06e7c7352f2efe1c138fc9146b9f8d7ab386ec` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/acceptance-privacy.log` | `f95182aae0631c0c5b40f8784f09d572a188c78120abe50daffd892ad85a79f6` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, signed project scopes, replay-safe controlled writes, generated tool-risk schemas, ChatGPT preview boundaries and a redacted evidence package. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

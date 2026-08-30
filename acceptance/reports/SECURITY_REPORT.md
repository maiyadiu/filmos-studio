# Security Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/receipt.json`
- Receipt SHA-256: `169785e02d0eaac6595dd57dd453de2444b87d5adb5ac0c25bc595ff3d6fbbc2`
- Started from Commit: `2cbabd8156ee65e614459e8d43bc665ee525e501`
- Source snapshot SHA-256: `02fdb0f8690312907e10fde757f53e77b68904c2deda16b8161b2c147df40942`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/canvas-agent.log` | `79c68b7da4d2c7d8e1e23c938c7a9a727cafa3c86a64382434eb0dd3df15ac79` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-handoff-local.log` | `ded94b3d59fb31b4d6a1e88fcaafb8b32cc3e9a5c57be0658431f37a84864e8c` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-golden-real.log` | `1112846213a04ced2eb31826d609a1a884e0ee4db107109e0bc8ff6d51acda7b` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-chatgpt-connection.log` | `96c95c795bd15647d7617f3c397d51d3403c8a462a8e60884ddccd3dc5f9a74e` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/no-openai-model-api-billing.log` | `540af8691e5e9a3ea3ffd2673b553c1a30bfd5b38be35e9d29b3b48d12848ccd` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-native-multibrain.log` | `5f349b93b9d6a417757032b31f5201c45755978aeed616e06fb6d5c1eb3ec8a9` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-tool-contract-single-source.log` | `01e2564063133a2ca06a8b81ec06e7c7352f2efe1c138fc9146b9f8d7ab386ec` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `agent-browser-lifecycle` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-browser-lifecycle.log` | `041995d43e5a443dda192996a5259b996c6967c2880fc943d6ec8a151e546074` |
| `agent-connection-probe-isolation` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-connection-probe-isolation.log` | `dead8a017e412af5af878da9c673ef497039e0a3cc2d33cbd0af4293a1f42789` |
| `chatgpt-host-restart-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-host-restart-recovery.log` | `7c205b8738a0d9eeef94ed1290589c8d221a0e19c1d47dbfcd9c1e588cb6e5d7` |
| `chatgpt-handoff-state` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-handoff-state.log` | `25271324c10cfbae4c603c6311101b4909e18ef12f91e2b2e42c515e5409ff36` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/acceptance-privacy.log` | `f3d6721831e4cf8539a32a0e6c2049c93f396aa8b44476ed16facccc7c4d391d` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, signed project scopes, replay-safe controlled writes, generated tool-risk schemas, ChatGPT preview boundaries and a redacted evidence package. Browser sessions bind create/cancel/close to one Profile; connection probes are non-networking and fail-soft. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

# Golden Test Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/receipt.json`
- Receipt SHA-256: `169785e02d0eaac6595dd57dd453de2444b87d5adb5ac0c25bc595ff3d6fbbc2`
- Started from Commit: `2cbabd8156ee65e614459e8d43bc665ee525e501`
- Source snapshot SHA-256: `02fdb0f8690312907e10fde757f53e77b68904c2deda16b8161b2c147df40942`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `golden-abc-real-http` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/golden-abc-real-http.log` | `bb790c1843bb1941b0d8723407651bffa2f8750a86faa76bf4b9b6e54d04a4c6` |
| `acceptance-full-chain` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/acceptance-full-chain.log` | `e2a056eb9f4e05953aa19cbd29b5b575023817166f46ab10080872a06043383d` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-golden-real.log` | `1112846213a04ced2eb31826d609a1a884e0ee4db107109e0bc8ff6d51acda7b` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-chatgpt-connection.log` | `96c95c795bd15647d7617f3c397d51d3403c8a462a8e60884ddccd3dc5f9a74e` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-native-multibrain.log` | `5f349b93b9d6a417757032b31f5201c45755978aeed616e06fb6d5c1eb3ec8a9` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-tool-contract-single-source.log` | `01e2564063133a2ca06a8b81ec06e7c7352f2efe1c138fc9146b9f8d7ab386ec` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `agent-browser-lifecycle` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-browser-lifecycle.log` | `041995d43e5a443dda192996a5259b996c6967c2880fc943d6ec8a151e546074` |
| `agent-connection-probe-isolation` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/agent-connection-probe-isolation.log` | `dead8a017e412af5af878da9c673ef497039e0a3cc2d33cbd0af4293a1f42789` |
| `chatgpt-host-restart-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-host-restart-recovery.log` | `7c205b8738a0d9eeef94ed1290589c8d221a0e19c1d47dbfcd9c1e588cb6e5d7` |
| `chatgpt-handoff-state` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/chatgpt-handoff-state.log` | `25271324c10cfbae4c603c6311101b4909e18ef12f91e2b2e42c515e5409ff36` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/no-openai-model-api-billing.log` | `540af8691e5e9a3ea3ffd2673b553c1a30bfd5b38be35e9d29b3b48d12848ccd` |

## Scope and boundary

Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance Project, desktop backup/restore, production multi-brain composition, Candidate App activation, a real Codex Subscription reject/approve/restart drill and real local ChatGPT handoff. The final lifecycle gates add process-level Host restart, scoped Grant rotation, formal waiting_host receipts and Handoff expiry recovery. Local Provider import is never relabeled as real CLI generation.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

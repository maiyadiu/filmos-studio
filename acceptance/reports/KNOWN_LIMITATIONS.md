# Known Limitations

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/receipt.json`
- Receipt SHA-256: `169785e02d0eaac6595dd57dd453de2444b87d5adb5ac0c25bc595ff3d6fbbc2`
- Started from Commit: `2cbabd8156ee65e614459e8d43bc665ee525e501`
- Source snapshot SHA-256: `02fdb0f8690312907e10fde757f53e77b68904c2deda16b8161b2c147df40942`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/desktop-release-build.log` | `570ef12fb336b8bd37f33a8bbbd1f2f2150dd575373f46c77631cde7a9350128` |
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
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/performance-local.log` | `ac4251cba6667d9373ae1dbc2932edac69f3bf4b08407887cef1b4ff149ebacf` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260830T044029Z-2cbabd8156ee-rc-local/remote-acceptance-contract.log` | `eb059821e814ed8d32c31bfdad2eda8752290693e63ee61e916e14f24fc131e6` |

## Scope and boundary

- Current evidence was generated from a clean fixed-commit source worktree.
- Real Codex Subscription evidence is a separate receipt because it requires managed account authorization; the report index hashes both the controlled-write receipt and its append-only audit trace as raw sources.
- No paid Provider or model API generation was performed for this P0 correction; the Local-first chain uses `LOCAL_MANUAL_CANDIDATE_IMPORT`.
- ChatGPT External Live Gate remains `BLOCKED_EXTERNAL_ACCOUNT`; local MCP, Widget and handoff checks do not replace independent account-side acknowledgement.
- `NO-OPENAI-MODEL-API-001` proves the checked-in runtime has no model API endpoint path; the final external Live Gate must add its own time-bounded receipt.
- Resume history is provider-specific: Codex is rebuilt from `thread/read`; ChatGPT shows the persisted Handoff timeline only; API and Local profiles currently state that Provider conversation history is not persisted instead of showing invented history.
- Real user database migration and real rollback remain outside the synthetic recovery drill.
- The app is an internal unsigned macOS build; signing, notarization and public distribution are not claimed.
- The controlled-write operator entered one shortened expected node ID during the restart readback; the receipt preserves that typo and binds the recovered object to the complete DOM node ID instead of rewriting the historical trace.
- Web JavaScript may exceed the warning budget, but must remain below the blocking budget.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

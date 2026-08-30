# Known Limitations

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/receipt.json`
- Receipt SHA-256: `5981dc29ba5859699790a97890d1de40fdeb58572b44b239a0b5585789f15cb1`
- Started from Commit: `a45effee4fe282db80f444cb18500533e270178f`
- Source snapshot SHA-256: `4c45dfa7bf9e23947df9dd5136b0dcc038ec43bdea07e83e4720dc4c1f26b30b`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/desktop-release-build.log` | `7e6a76778521f4a108bd608c785a8f98aede372628050529657abefd6fe167a6` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/desktop-chatgpt-connection.log` | `fd5d9f8b04b3c2f4025e47c232f9b912cd51d168fcdeed304cc006b7678a4074` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/no-openai-model-api-billing.log` | `132391a9cc1127520141a7a9fc09b0b7db0e4d6050d3e6f119afcc1ee0a34ec6` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/agent-native-multibrain.log` | `5f349b93b9d6a417757032b31f5201c45755978aeed616e06fb6d5c1eb3ec8a9` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/agent-tool-contract-single-source.log` | `090ef46bc8ee5a3433bdc80e5722facf038428488f4da31b81da8cb74fc1fd77` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `agent-browser-lifecycle` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/agent-browser-lifecycle.log` | `5fb4dc644c982e74aba7bccebddff471ab023d01e8e928dbb340544ff32b2889` |
| `agent-connection-probe-isolation` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/agent-connection-probe-isolation.log` | `8caf87d1fa67c78439bbf71c9e83e7466e8fc4058c748f7013fa263f257f2f7f` |
| `chatgpt-host-restart-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/chatgpt-host-restart-recovery.log` | `8355ef4352ec48701ae441b73587a3abbdc6bb838522a915cc59112be11c9ed2` |
| `chatgpt-handoff-state` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/chatgpt-handoff-state.log` | `e6e3ec188175e2fb2d6c14a6326a32289b8bd359ce73fad8c7158f44c6672543` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/performance-local.log` | `656fff37bc89914bfb9b29a477c3cd0a2b21d88fd528d3e9cdb8d33fd96b5263` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/remote-acceptance-contract.log` | `eb059821e814ed8d32c31bfdad2eda8752290693e63ee61e916e14f24fc131e6` |

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

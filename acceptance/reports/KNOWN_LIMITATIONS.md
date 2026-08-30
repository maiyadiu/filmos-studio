# Known Limitations

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260830T164746Z-b12b1ba108a9-rc-local/receipt.json`
- Receipt SHA-256: `0de021df68ebb75e42c702771480aeddd49566bc6f454bdd4356d295a2a50b43`
- Started from Commit: `b12b1ba108a926470614b2e6a231d333d1a1d00f`
- Source snapshot SHA-256: `d0888cb19b878a71e66299c50abb50c94303be14c4fa42720d754bf832338050`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-release-build.log` | `5cd9f0f313f3e10582bf86f2cac34593d8eb510d83e0641998112554f737d724` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-chatgpt-connection.log` | `b2fd87689dcd83fb5fc0e21dbcbe6a47ff345453664d975344b401ba3a0d703c` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/no-openai-model-api-billing.log` | `128a4d5fac5179ce27facc70ce250cee6670f0edaca210dc2035ed49c503408b` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-native-multibrain.log` | `5f349b93b9d6a417757032b31f5201c45755978aeed616e06fb6d5c1eb3ec8a9` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-tool-contract-single-source.log` | `090ef46bc8ee5a3433bdc80e5722facf038428488f4da31b81da8cb74fc1fd77` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `agent-browser-lifecycle` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-browser-lifecycle.log` | `d7290de638c0918813e376c761f160018b7e7de229afd63f048fa61367aaa7f9` |
| `agent-connection-probe-isolation` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-connection-probe-isolation.log` | `9e9bbc51e4412a4682a0b53075f3b4418897abf6d99cf5de6cedbb76cfc2632f` |
| `chatgpt-host-restart-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-host-restart-recovery.log` | `00bfc41184b41368473e3e0792edeb256f99ec63bd87316125b3f5d90fd7d8e1` |
| `chatgpt-handoff-state` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-handoff-state.log` | `a4d28da76505b112cf9ec20eb45bf95995a9503dc5af2adb0cc8e2adcd9d9461` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/performance-local.log` | `2f4e821eccc17affc2f831bfea58ec1762a16df46886bd833ac4db27b6c87efd` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/remote-acceptance-contract.log` | `eb059821e814ed8d32c31bfdad2eda8752290693e63ee61e916e14f24fc131e6` |

## Scope and boundary

- Current evidence was generated from a dirty development source worktree.
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

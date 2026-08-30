# Golden Test Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260830T164746Z-b12b1ba108a9-rc-local/receipt.json`
- Receipt SHA-256: `0de021df68ebb75e42c702771480aeddd49566bc6f454bdd4356d295a2a50b43`
- Started from Commit: `b12b1ba108a926470614b2e6a231d333d1a1d00f`
- Source snapshot SHA-256: `d0888cb19b878a71e66299c50abb50c94303be14c4fa42720d754bf832338050`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-backup-restore.log` | `5df89621fe6106650eecd0c57ddcf0b1810e89d387f4c5fe4a5ee6823bb0070b` |
| `golden-abc-real-http` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/golden-abc-real-http.log` | `035e66185beeef2c076af1812b3f7f3ce429343523aa971bf9ee2db4b4b16d4c` |
| `acceptance-full-chain` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/acceptance-full-chain.log` | `d27d72afb15dbc273ea000b3e435f25188c9ed318459f081a8d886ed9385b69a` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-golden-real.log` | `32f4c349247154bee7863567c18991c68ccc8e9ce38c7bbcc18a3abf3b0956f2` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-chatgpt-connection.log` | `b2fd87689dcd83fb5fc0e21dbcbe6a47ff345453664d975344b401ba3a0d703c` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-native-multibrain.log` | `5f349b93b9d6a417757032b31f5201c45755978aeed616e06fb6d5c1eb3ec8a9` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-tool-contract-single-source.log` | `090ef46bc8ee5a3433bdc80e5722facf038428488f4da31b81da8cb74fc1fd77` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `agent-browser-lifecycle` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-browser-lifecycle.log` | `d7290de638c0918813e376c761f160018b7e7de229afd63f048fa61367aaa7f9` |
| `agent-connection-probe-isolation` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/agent-connection-probe-isolation.log` | `9e9bbc51e4412a4682a0b53075f3b4418897abf6d99cf5de6cedbb76cfc2632f` |
| `chatgpt-host-restart-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-host-restart-recovery.log` | `00bfc41184b41368473e3e0792edeb256f99ec63bd87316125b3f5d90fd7d8e1` |
| `chatgpt-handoff-state` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-handoff-state.log` | `a4d28da76505b112cf9ec20eb45bf95995a9503dc5af2adb0cc8e2adcd9d9461` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/no-openai-model-api-billing.log` | `128a4d5fac5179ce27facc70ce250cee6670f0edaca210dc2035ed49c503408b` |

## Scope and boundary

Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance Project, desktop backup/restore, production multi-brain composition, Candidate App activation, a real Codex Subscription reject/approve/restart drill and real local ChatGPT handoff. The final lifecycle gates add process-level Host restart, scoped Grant rotation, formal waiting_host receipts and Handoff expiry recovery. Local Provider import is never relabeled as real CLI generation.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

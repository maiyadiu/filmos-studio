# Security Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260830T164746Z-b12b1ba108a9-rc-local/receipt.json`
- Receipt SHA-256: `0de021df68ebb75e42c702771480aeddd49566bc6f454bdd4356d295a2a50b43`
- Started from Commit: `b12b1ba108a926470614b2e6a231d333d1a1d00f`
- Source snapshot SHA-256: `d0888cb19b878a71e66299c50abb50c94303be14c4fa42720d754bf832338050`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/desktop-backup-restore.log` | `5df89621fe6106650eecd0c57ddcf0b1810e89d387f4c5fe4a5ee6823bb0070b` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/canvas-agent.log` | `86375b7dfb6f6e42bc3ff3e4d02633e44aebb6a2cc0e2513857c4906c3134b28` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-handoff-local.log` | `fc3462e6e5b64b13d74fab440e6ca476f7910f376e1d908f1a058c95fdd3b6c8` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/chatgpt-golden-real.log` | `32f4c349247154bee7863567c18991c68ccc8e9ce38c7bbcc18a3abf3b0956f2` |
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
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/acceptance-privacy.log` | `88d07fbc689badaf45af2e093c9d966bb0e747916462dc9af7ff23b126ada240` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, signed project scopes, replay-safe controlled writes, generated tool-risk schemas, ChatGPT preview boundaries and a redacted evidence package. Browser sessions bind create/cancel/close to one Profile; connection probes are non-networking and fail-soft. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

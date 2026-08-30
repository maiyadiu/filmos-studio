# Security Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/receipt.json`
- Receipt SHA-256: `5981dc29ba5859699790a97890d1de40fdeb58572b44b239a0b5585789f15cb1`
- Started from Commit: `a45effee4fe282db80f444cb18500533e270178f`
- Source snapshot SHA-256: `4c45dfa7bf9e23947df9dd5136b0dcc038ec43bdea07e83e4720dc4c1f26b30b`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/desktop-backup-restore.log` | `5df89621fe6106650eecd0c57ddcf0b1810e89d387f4c5fe4a5ee6823bb0070b` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/canvas-agent.log` | `b847646d87bcd2e9f1974f38cf8ac3c157c5bbfb83f15ee3411bd42db3384f14` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/chatgpt-handoff-local.log` | `57ebd3a68a426d6b265dff5149fde3292602f417b99b6cd01c708a51bc438d4c` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/chatgpt-golden-real.log` | `3ef71f47a134dde824909a6678184204e04af4cec17e6cd014df874fc423eb88` |
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
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260830T165124Z-a45effee4fe2-rc-local/acceptance-privacy.log` | `88d07fbc689badaf45af2e093c9d966bb0e747916462dc9af7ff23b126ada240` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, signed project scopes, replay-safe controlled writes, generated tool-risk schemas, ChatGPT preview boundaries and a redacted evidence package. Browser sessions bind create/cancel/close to one Profile; connection probes are non-networking and fail-soft. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

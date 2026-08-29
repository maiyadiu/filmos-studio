# Known Limitations

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260829T235731Z-e2ed10924c7f-rc-local/receipt.json`
- Receipt SHA-256: `7393946765b2f60348e8ae687f29b9c9f74793fa243b12bbf816df7387b99360`
- Started from Commit: `e2ed10924c7fb7679ac80bc78281c6d3d9e3083e`
- Source snapshot SHA-256: `8c93725a8ecffb63617df0e1c07fcdfb62e8aa6207156a3b42e67f82b81c7f08`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-release-build` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/desktop-release-build.log` | `5cd9f0f313f3e10582bf86f2cac34593d8eb510d83e0641998112554f737d724` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/desktop-chatgpt-connection.log` | `b875263064980e24913dcb795dc049c0bd911eafcd6f3d2f30a09a24ae0f113d` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/no-openai-model-api-billing.log` | `d965660a5e8fb935bbbc3e78096d0019e97c9b50c1f3bf58368b63caab7107c7` |
| `agent-native-multibrain` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-native-multibrain.log` | `59a78653e9092a07ad384960cca5c685dcf458b5a2dd9b35dd8a5c869ad05f0e` |
| `agent-codex-controlled-write` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-codex-controlled-write.log` | `cf9eb32bf39f458a0b160f875c6699cf7a561a1b80e35dd4c467db7d216dcafc` |
| `agent-tool-contract-single-source` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-tool-contract-single-source.log` | `01e2564063133a2ca06a8b81ec06e7c7352f2efe1c138fc9146b9f8d7ab386ec` |
| `agent-candidate-activation` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/agent-candidate-activation.log` | `979b4b147308bb28f3f21ceefb743686879515d7c62e765e394e1cc0e02fa574` |
| `mcp-actual-tool-count` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/mcp-actual-tool-count.log` | `16ff02ce1f68e336e6401fdca7d6c50410d7f9435749bde6f73074227b1536f3` |
| `performance-local` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/performance-local.log` | `2af744368b16d424ddfe72546cd134d4e553f62294da74b92cec088bfc68d39c` |
| `remote-acceptance-contract` | `PASSED` | `acceptance/evidence/runs/20260829T235731Z-e2ed10924c7f-rc-local/remote-acceptance-contract.log` | `153a86f8d976d712547c59ad7d9e0980986683010ffffe64b5cb2bb59f189663` |

## Scope and boundary

- Current evidence was generated from a clean fixed-commit source worktree.
- Real Codex Subscription evidence is a separate receipt because it requires managed account authorization; the report index hashes both the controlled-write receipt and its append-only audit trace as raw sources.
- No paid Provider or model API generation was performed for this P0 correction; the Local-first chain uses `LOCAL_MANUAL_CANDIDATE_IMPORT`.
- ChatGPT External Live Gate remains `BLOCKED_EXTERNAL_ACCOUNT`; local MCP, Widget and handoff checks do not replace independent account-side acknowledgement.
- `NO-OPENAI-MODEL-API-001` proves the checked-in runtime has no model API endpoint path; the final external Live Gate must add its own time-bounded receipt.
- Real user database migration and real rollback remain outside the synthetic recovery drill.
- The app is an internal unsigned macOS build; signing, notarization and public distribution are not claimed.
- The controlled-write operator entered one shortened expected node ID during the restart readback; the receipt preserves that typo and binds the recovered object to the complete DOM node ID instead of rewriting the historical trace.
- Web JavaScript may exceed the warning budget, but must remain below the blocking budget.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.

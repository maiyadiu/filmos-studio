# Evidence

- Base commit：`9267a5f198182bfa16403723e865cf815983ef13`
- Baseline GitHub Acceptance：Run `33247094026`，23/23 PASS
- Task contract SHA-256：`1e6f835e3d24855796231aa856c53a2b6dd262c3b04178c805e127b6ce908f83`
- Codex schema probe：`codex-cli 0.150.0-alpha.12.2`，已在项目外临时目录生成 TS/JSON Schema
- Gap audit：`../../agent-native-multibrain/BASELINE_9267_AUDIT.md`
- Reuse matrix：`../../agent-native-multibrain/REUSE_EXTEND_BUILD_MATRIX.csv`

后续每个 WP 的源码、自动测试、运行日志和 Golden receipt 将登记到 `acceptance/EVIDENCE_INDEX.json`；本页不替代机器证据。

## WP-01

- Shared contract：`packages/filmos-agent-contracts/src/index.ts`
- Registry / Session：`canvas-agent/src/brains/registry.ts`、`session-manager.ts`、`session-store.ts`
- Context / Grant / Confirmation：`context-broker.ts`、`permission-grants.ts`、`confirmations.ts`
- 自动测试：`brain-registry.test.ts`、`agent-session-manager.test.ts`、`agent-context-pack.test.ts`、`agent-permission-grant.test.ts`、`agent-confirmation.test.ts`
- 机器收据：`../../agent-native-multibrain/evidence/WP-01.json`
- 结论：Mock Codex/API/Hosted 在同一 Registry 建立三份隔离 Session；订阅探测失败不会触发 API Adapter；收据、Grant 和 Confirmation 均按 Session fail closed。

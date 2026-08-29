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

## WP-02

- Web Context：`web/src/film/agent/workbench-context.ts`
- Runtime Context：`canvas-agent/src/canvas-session.ts`、`modules/canvas-agent-http.ts`
- Desktop Bridge：`desktop/macos/Sources/FilmOSStudioDesktop/main.swift`
- 自动测试：`workbench-context.test.mjs`、`workbench-context.test.ts`、`canvas-agent-module.test.ts`
- 机器收据：`../../agent-native-multibrain/evidence/WP-02.json`
- 结论：Host Project、Film Project、Unit/Scene/DirectorUnit/Shot、选区、可视节点、资产版本和 Canvas revision/hash 使用同一显式上下文；`host-project-1` 已从正式桌面连接路径移除，缺少 Film Project 时不猜测。

## WP-03

- Codex app-server：`canvas-agent/src/brains/adapters/codex-app-server-client.ts`、`codex-app-server-process-manager.ts`
- Subscription Adapter：`canvas-agent/src/brains/adapters/codex-app-server-adapter.ts`
- FilmOS Confirmation：`canvas-agent/src/brains/codex-approval-coordinator.ts`
- Workbench Surface：`canvas-agent/src/mcp-server.ts`、`modules/canvas-agent-http.ts`
- 自动测试：`codex-app-server-adapter.test.ts`、`codex-app-server-process-manager.test.ts`、`codex-approval-coordinator.test.ts`、`internal-canvas-mcp-mode.test.ts`
- 机器收据：`../../agent-native-multibrain/evidence/WP-03.json`
- 结论：Codex 订阅使用 app-server 的 ChatGPT managed auth 和实际 account/rate-limit RPC，不需要 `OPENAI_API_KEY`；同一 Thread 串行、跨 Session 并行；工具面为 Canvas + Film Core 且不暴露 direct provider；高风险 app-server 请求未确认、超时或 Session 不匹配时默认拒绝。

## WP-04

- API Compatibility Adapter：`canvas-agent/src/brains/adapters/model-api-brain-adapter.ts`
- Local Model Adapter：`canvas-agent/src/brains/adapters/local-model-adapter.ts`
- 自动测试：`model-api-brain-adapter.test.ts`、`agent-session-manager.test.ts`
- 机器收据：`../../agent-native-multibrain/evidence/WP-04.json`
- 结论：现有浏览器/后端模型与自定义 Channel 保留为 Compatibility Port；OpenAI、Claude、DeepSeek 和自定义 API Profile 只能在该 Profile 显式启用且被选中时进入按量计费端口；图片路径保留；本地模型为独立 Adapter。

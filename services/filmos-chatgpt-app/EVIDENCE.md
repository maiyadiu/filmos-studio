# Track 14 本地证据

状态：`PASSED_LOCAL_DAY1_5_WITH_EXTERNAL_ACCOUNT_BLOCKED`。这不是 ChatGPT 端连接、Tunnel 建立、公开部署、审核或发布证据。

## 实现证据

- 单一合同：`packages/filmos-tool-contracts/contract.v1.json` 生成 TypeScript、MCP 和 OpenAPI components；8组计划对象（Proposal Package/Item 合并计一组）及工具字段一致性由测试锁定。
- 公开工具：2个标准工具、10个 FilmOS 数据工具、7个独立 render 工具、1个 Proposal artifact 工具；7个写工具只保留名称，不注册。
- 注解：`filmos_prepare_proposal_export` 的 `readOnlyHint=true` 表示它只在 MCP 响应中生成签名 artifact，不持久化且不修改 FilmOS；`idempotentHint=false` 因每次未指定 proposal id 时会生成新的本地 artifact。其他读工具使用只读、非破坏、闭世界、幂等注解。
- UI：`@modelcontextprotocol/ext-apps@1.7.5` 的 `App` bridge、`ontoolresult` 和 `connect()`；`window.openai` 仅为兼容 fallback。Project、ContentUnit、Shot 有语义渲染断言，另有 Asset、SceneTwin、Review Queue、Proposal 共7个版本化资源。
- 安全：短期 Project Grant、撤销/过期/项目隔离、1MiB JSON、loopback/Origin、审计 `event_id/result_size`、路径/密钥清洗、Prompt Injection警告、代理媒体限制、断线失败。
- Proposal：HMAC签名、内容哈希、过期、project/state/version、严格字段、非法命令/脚本/路径/URL、幂等冲突检查；Python CLI只返回 Proposal/Candidate/Review Draft Preview，不 Formal Apply。
- 插件：官方 `plugin-creator` scaffold 后已替换成真实本机 HTTP MCP配置和只读 skill；未保留空 `.app.json`，README明确 Codex plugin 与 ChatGPT Developer Mode 安装边界。

## 运行验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix packages/filmos-tool-contracts test` | 5 passed |
| `npm --prefix services/filmos-chatgpt-app test` | 21 passed |
| `npm --prefix services/filmos-chatgpt-app run build` | passed |
| `FILMOS_TEST_PYTHON=... npm --prefix services/filmos-chatgpt-app run test:golden-real` | 1 passed；真实 SQLite/HTTP/MCP/Widget/文件/CLI |
| `PYTHONPATH=film-core/app ... -m pytest -q film-core/app/external_brains/chatgpt/tests` | 21 passed |
| `plugin-creator/scripts/validate_plugin.py plugins/filmos-chatgpt` | passed |
| `npm --prefix services/filmos-chatgpt-app run doctor` | `BLOCKED_EXTERNAL_ACCOUNT`，listener/tunnel均false |

真实 Golden receipt 位于 `evidence/real-golden-receipt.json`；Tunnel阻断 receipt 位于 `evidence/external-account-blocked.json`。外部调用、上传、额度、发布、公开 listener、真实 API key 和真实 ChatGPT账号使用均为0。

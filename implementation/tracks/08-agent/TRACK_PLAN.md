# Track 08｜Agent Brain Gateway 与 MCP

TRACK: `08-agent`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：Codex/DeepSeek/Claude/本地模型/Human Only 共享同一 Film 工具面和权限。
2. 已核查：`canvas-agent/README.md`、`src/schemas.ts`、`src/mcp-server.ts`、`src/canvas-session.ts`、`src/canvas-context.ts`、相邻 MCP/Canvas 测试、Film Contracts V0 与 Track 02 当前 OpenAPI/运行实现。
3. 已有能力：Canvas/Project MCP Broker、画布 `expectedRevision/stateHash`、Web 写入确认；Film Core 提供项目/实体读取、Command Preview/Apply 和追加式审计。
4. Fit-Gap：
   - `REUSE`：MCP SDK、Canvas Agent 本机 Broker、Canvas revision/stateHash、Film Core Command/Audit。
   - `EXTEND`：独立 Film MCP 工具合同、先读后写收据、Preview/Apply 收据、Film/Canvas 双并发守卫。
   - `BUILD`：Agent 权限策略、Agent 审计字段、受限本机 HTTP Adapter、默认关闭的注册函数。
   - `DEFER`：新增 Core operation 的 MCP 投影、Production/Director/Prompt/Provider 全工具面、外部生成、Agent 直接 Approved/Script Lock。
5. 已实现首切片：`canvas-agent/src/film/`；只读项目/实体/审计，Command Preview/Apply，正式写入前强制读取、Preview、`expected_version/content_hash`、Canvas revision/stateHash，Apply 前重新读取 Film 事实。
6. 权限：非人类 Agent 在传输前拒绝 Approved、Locked、Script Lock；Provider/Generation Command 不进入本轨；Human Only 的批准/锁定需显式人工确认。
7. 审计：读、Preview、Apply 派发、Apply 成功、拒绝/失败均有完整 AgentAudit；默认实现为仅追加 JSONL，正式 Apply 同时校验 Film Core 返回的持久 AuditEvent。
8. 第二阶段接入：共享 `src/mcp-server.ts` 已调用默认关闭的 Film 注册函数；默认和 `canvasOnly` 工具集合不变，外部 MCP 仅在 `FILMOS_AGENT_GATEWAY_ENABLED=true` 时新增既定 5 个 Film 工具。
9. 合同门：`scripts/sync-film-openapi.mjs` 只抽取既有 5 个映射并生成 `src/film/generated/openapi-contract.ts`；严格校验 operationId、路径/方法、参数、两个 Command type 与 ActorKind，允许其他 Core operation 存在但不自动暴露。
10. 第五阶段扩展：增加供应商中立 `FilmAgentProfile` / capability 合同。`codex_app_server`、`deepseek_compatible`、`claude_code`、`local_model`、`system`、`human_only` 复用同一 MCP 工具面；未知或冲突声明失败关闭，不读取模型端点/密钥，不在声明或注册时发网络。
11. 第五阶段权限：非人工 Profile 只允许 Read → Preview，正式 Apply 由 `human_only` 携带新鲜、身份匹配的人工确认执行；Agent 即使伪造 `human_confirmation` 也会在 Core transport 前以 `human_apply_required` 拒绝并审计，且继续禁止 Approval/Locked/Script Lock。
12. Dreamina 顺序诊断：指定长驻 CLI 查询测试在隔离、相邻进程/Runtime 套件和完整串行套件均通过；现有实现已在首个合法状态 JSON 后终止精确进程树并等待 child close。当前唯一可复现的全量前置失败是未指定含 FastAPI/Pydantic/Uvicorn 的 Python，补 `FILMOS_CORE_PYTHON` 后全量通过，因此没有证据修改 Dreamina 运行时代码。
13. 验证：真实 MCP SDK `listTools/callTool`；生产 FastAPI + 临时 SQLite 的真实 HTTP Read → Preview → Apply；Profile 离线/密钥隔离/DeepSeek Actor/人工 Apply/Approval 拒绝；过期 version/hash/Canvas revision/stateHash 均 fail closed。Canvas Agent 全量为 `354 tests / 349 pass / 0 fail / 5 Windows skip`，构建与 OpenAPI 同步门通过。
14. 回滚：保持 `film.agent_gateway=false` / `FILMOS_AGENT_GATEWAY_ENABLED!=true`，或移除共享入口注册调用；影策原 MCP 不受影响。
15. 依赖：真实 HTTP 测试需要 `film-core[test]` Python 环境，可通过 `FILMOS_CORE_PYTHON` 指定；当前只兼容已实现 `entity.create` / `entity.set_states`。

STATUS: `STAGE5_PROVIDER_NEUTRAL_PROFILE_DEEPSEEK_OFFLINE_VERIFIED`

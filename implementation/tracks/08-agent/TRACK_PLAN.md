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
   - `DEFER`：Production/Director/Prompt/Provider 全工具面、外部生成、Agent 直接 Approved/Script Lock、共享 MCP 启动入口接线。
5. 已实现首切片：`canvas-agent/src/film/`；只读项目/实体/审计，Command Preview/Apply，正式写入前强制读取、Preview、`expected_version/content_hash`、Canvas revision/stateHash，Apply 前重新读取 Film 事实。
6. 权限：非人类 Agent 在传输前拒绝 Approved、Locked、Script Lock；Provider/Generation Command 不进入本轨；Human Only 的批准/锁定需显式人工确认。
7. 审计：读、Preview、Apply 派发、Apply 成功、拒绝/失败均有完整 AgentAudit；默认实现为仅追加 JSONL，正式 Apply 同时校验 Film Core 返回的持久 AuditEvent。
8. 当前接入状态：`registerFilmAgentMcp` 默认关闭，且尚未由现有 `src/mcp-server.ts` 调用；因此能力处于离线可测、未暴露状态。共享接线见 `CR-08-001-Agent注册.md`。
9. 验证：`bun test test/film-agent-gateway.test.ts` 10/10；`npm test` 326/326（另有 5 个 Windows 专项跳过）；`bun run build` 通过；无 dev server、Provider、上传或积分调用。
10. 回滚：不接入注册函数，或保持 `film.agent_gateway=false` / `FILMOS_AGENT_GATEWAY_ENABLED!=true`；影策原 MCP 不受影响。
11. 依赖：Track 02 的含 `actor_kind` Command 合同必须先合入 integration；Track 13 在接线后补原生 MCP/Golden。

STATUS: `OFFLINE_SLICE_IMPLEMENTED_NOT_REGISTERED`

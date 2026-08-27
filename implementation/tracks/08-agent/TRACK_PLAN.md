# Track 08｜Agent Brain Gateway 与 MCP

TRACK: `08-agent`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：Codex/DeepSeek/Claude/本地模型/Human Only 共享同一 Film 工具面和权限。
2. 已初核查：`canvas-agent/src/schemas.ts`、`canvas-session.ts`、Web 画布 Agent 面板写入确认调用点；本轨仍需读 `canvas-agent/README.md` 和相邻测试。
3. 已有能力：Canvas/Project 读写工具、expectedRevision/stateHash、Web 写入确认。
4. Fit-Gap：`REUSE` MCP/Tool Broker；`EXTEND` Production/Director/Prompt tools；`BUILD` Agent Adapter/Audit；`DEFER` 任意 Agent 越权写 Approved/Locked。
5. 最小修改：先做只读 Film Context 和 Command Preview，共享 Schema 生成。
6. 不做：不把 Codex 写死为唯一 Agent，不直改 Approved/Locked。
7. 影响：见 `FILE_OWNERSHIP.yaml#agent`。
8. 测试：工具 Schema、只读/写入分类、expected_version、权限拒绝、审计。
9. 回滚：关闭 `film.agent_gateway`。
10. 依赖：Track 02、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


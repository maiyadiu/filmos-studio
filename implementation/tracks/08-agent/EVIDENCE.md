# Track 08 证据

## 状态

- 分支：`track/agent`
- 首切片：`OFFLINE_SLICE_IMPLEMENTED_NOT_REGISTERED`
- 默认开关：`film.agent_gateway=false`；运行时仅精确环境值 `FILMOS_AGENT_GATEWAY_ENABLED=true` 才允许注册。
- 外部副作用：未启动 dev server，未调用 Provider，未生成、上传或消费积分。

## 源码核查

| 对象 | 证据 | 结论 |
| --- | --- | --- |
| Canvas MCP | `canvas-agent/src/mcp-server.ts`、`src/schemas.ts` | 已有统一 MCP 注册与 Canvas/Project 工具；Film 工具尚无入口。 |
| Canvas 并发 | `canvas-agent/src/canvas-session.ts:206` | `canvas_apply_ops` 已支持 `expectedRevision`、`expectedStateHash`，可复用画布事实。 |
| Canvas 状态哈希 | `canvas-agent/src/canvas-context.ts` | `canvas_get_context` 返回 revision/stateHash，可作为 Film 正式写入的画布守卫。 |
| Film 身份与并发 | `film-contracts/稳定ID.md` | Film ID 为 Core 生成 UUIDv4；正式写入要求 `expected_version`；`content_hash` 为小写 SHA-256。 |
| Film API | Track 02 当前 `film-contracts/openapi.json` 与 `film-core/.../api.py` | 已实现项目/实体读取、Command Preview/Apply、审计读取；Impact/Review/Prompt/Continuity 仍 planned。 |
| 权限差距 | 全库检索 | 原 Agent 没有禁止自批 Approved/Locked 的 Film 权限策略，也没有 Film AgentAudit。 |

## 实施

- `canvas-agent/src/film/contracts.ts`：5 个独立 Film MCP 工具、严格 Zod 输入、读/Preview/Apply 注释。
- `canvas-agent/src/film/gateway.ts`：短期读取收据、Preview 单次收据、Film 与 Canvas 双并发校验、Agent 权限、Core Audit 校验。
- `canvas-agent/src/film/http.ts`：仅允许精确 `http://127.0.0.1:<port>/film`，限制响应体、超时、禁止重定向。
- `canvas-agent/src/film/audit.ts`：完整 AgentAudit 字段与仅追加 JSONL/内存测试 Sink。
- `canvas-agent/src/film/mcp.ts`：默认关闭的注册函数；未改现有共享 MCP 入口。
- `canvas-agent/test/film-agent-gateway.test.ts`：覆盖默认关闭、先读后写、Preview/Apply 分离、版本/哈希、画布冲突、权限拒绝、Provider 边界和本机 URL。

## 验证

```text
bun test test/film-agent-gateway.test.ts
10 pass / 0 fail

npm test
326 pass / 0 fail / 5 skipped (Windows-specific)

bun run build
tsc -p tsconfig.json
exit 0

git diff --check
exit 0
```

## 未完成与门禁

1. 现有 `canvas-agent/src/mcp-server.ts` 尚未调用 `registerFilmAgentMcp`，当前工具不会出现在实际 MCP 列表。
2. Track 02 的新版 Command 合同包含 `actor_kind`；旧 V0 OpenAPI 未列该字段。integration 必须先含 Track 02 后再接线。
3. 接线后需由 Track 13 运行真实 MCP 注册、Film Core Sidecar、冲突与恢复 Golden；本轨离线测试不能替代生产可用性证明。

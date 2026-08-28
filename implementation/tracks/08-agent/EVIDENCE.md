# Track 08 证据

## 状态

- 分支：`stage/agent-mcp`
- 第五阶段：`STAGE5_PROVIDER_NEUTRAL_PROFILE_DEEPSEEK_OFFLINE_VERIFIED`
- 默认开关：`film.agent_gateway=false`；运行时仅精确环境值 `FILMOS_AGENT_GATEWAY_ENABLED=true` 才允许注册。
- 外部副作用：未启动 dev server，未调用 Provider，未生成、上传或消费积分。

## 源码核查

| 对象 | 证据 | 结论 |
| --- | --- | --- |
| Canvas MCP | `canvas-agent/src/mcp-server.ts`、`src/schemas.ts` | 复用统一 MCP 注册；默认与 `canvasOnly` 集合不变，只有显式 Film Flag 才新增工具。 |
| Canvas 并发 | `canvas-agent/src/canvas-session.ts:206` | `canvas_apply_ops` 已支持 `expectedRevision`、`expectedStateHash`，可复用画布事实。 |
| Canvas 状态哈希 | `canvas-agent/src/canvas-context.ts` | `canvas_get_context` 返回 revision/stateHash，可作为 Film 正式写入的画布守卫。 |
| Film 身份与并发 | `film-contracts/稳定ID.md` | Film ID 为 Core 生成 UUIDv4；正式写入要求 `expected_version`；`content_hash` 为小写 SHA-256。 |
| Film API | Track 02 当前 `film-contracts/openapi.json` 与 `film-core/.../api.py` | 已实现项目/实体读取、Command Preview/Apply、审计读取；Impact/Review/Prompt/Continuity 仍 planned。 |
| 权限差距 | 全库检索 | 原 Agent 没有禁止自批 Approved/Locked 的 Film 权限策略，也没有 Film AgentAudit。 |

## 实施

- `canvas-agent/src/film/contracts.ts`：5 个独立 Film MCP 工具；工具名、ActorKind 与 Command type 来自生成式 OpenAPI 投影。
- `canvas-agent/src/film/gateway.ts`：短期读取收据、Preview 单次收据、Film 与 Canvas 双并发校验、Agent 权限、Core Audit 校验。
- `canvas-agent/src/film/http.ts`：仅允许精确 `http://127.0.0.1:<port>/film`，限制响应体、超时、禁止重定向。
- `canvas-agent/src/film/audit.ts`：完整 AgentAudit 字段与仅追加 JSONL/内存测试 Sink。
- `canvas-agent/src/film/mcp.ts`、`src/mcp-server.ts`：共享入口实际调用默认关闭的 Film 注册；`canvasOnly` 永不注册 Film。
- `canvas-agent/scripts/sync-film-openapi.mjs`：可重复生成/`--check` 的 OpenAPI → MCP 门禁，只校验既有 5 个 operation；额外 Core operation 不会自动进入 MCP。
- `canvas-agent/src/film/generated/openapi-contract.ts`：生成的 operationId、参数、ActorKind 与两个已实现 Command type 投影。
- `canvas-agent/test/film-agent-gateway.test.ts`：离线 Gateway 单元测试。
- `canvas-agent/test/film-mcp-registration.test.ts`：共享入口差集测试及真实 MCP SDK in-memory `listTools/callTool`。
- `canvas-agent/test/film-openapi-contract.test.ts`：生成物新鲜度、Zod 严格性和 operationId 漂移失败测试。
- `canvas-agent/test/film-agent-http-integration.test.ts`：生产 FastAPI `create_app()`、临时 SQLite、真实 loopback HTTP 的 Read → Preview → Apply 与冲突/权限测试。
- `canvas-agent/src/film/profile.ts`：供应商中立 Profile/Capability 合同；DeepSeek-compatible 只声明本地 MCP 身份，不携带客户端端点或密钥，也不执行网络。
- `canvas-agent/test/film-agent-profile.test.ts`：六类 Adapter 共用工具面、未知/冲突配置失败关闭、DeepSeek 离线零网络零密钥、Agent Apply 拒绝审计、Human Only 确认 Apply、默认关闭注册。

## 第五阶段 Dreamina 顺序诊断

1. 隔离运行 `Dreamina production query consumes one JSON status before a long-lived CLI exits`：`1 pass / 0 fail`。
2. 与 `dreamina-cli-process.test.ts`、完整 `dreamina-cli-runtime.test.ts`、Film Profile/MCP 测试按串行顺序运行：`101 tests / 99 pass / 0 fail / 2 Windows skip`；指定测试通过。
3. 未指定 Film Core Python 时，全量中可复现的仅是 2 个 HTTP Sidecar 测试因缺少 FastAPI/Pydantic/Uvicorn 而失败，指定 `/tmp/filmos-core-venv-02/bin/python` 后 `354 tests / 349 pass / 0 fail / 5 Windows skip`；指定 Dreamina 测试仍通过。
4. 代码证据：非下载查询设置 `completeOnJsonOutput=isCompleteQueryOutput`；只接受含 `status/state/genStatus/code/completed` 的受限 JSON；`runDreaminaProcess` 接受后终止精确进程树，并以 child close 作为清理屏障。相邻 process tests 已覆盖“早期 JSON → 等待 close”和“长驻 child → 清理”。
5. 裁决：没有证据表明当前代码存在 Dreamina 测试顺序依赖，不修改、不跳过、不删除 Dreamina 源码或测试；保留现有门禁。

## 验证

```text
npm run check:film-openapi
exit 0

npm run sync:film-openapi
exit 0

FILMOS_CORE_PYTHON=/tmp/filmos-core-venv-02/bin/python npm test
354 tests / 349 pass / 0 fail / 5 skipped (Windows-specific)

npm run build
tsc -p tsconfig.json
exit 0

git diff --check
exit 0
```

## 未完成与门禁

1. 本阶段只暴露既有 5 个工具和 `/commands/*`；`formal-records`、Prompt compile、Manual Import、Review、Approval、Continuity 等新增 Core operation 不自动变成 MCP 工具。
2. 真实 HTTP 测试需要含 FastAPI/Pydantic/Uvicorn 的 `film-core[test]` Python；通过 `FILMOS_CORE_PYTHON` 或 `film-core/.venv/bin/python` 指定。
3. Gateway 读取/Preview 收据仍是 MCP 进程内短期状态；进程重启后必须重新 Read/Preview，这是 fail closed，不是恢复实现。
4. 当前只接受 Film Core 已实现的 `entity.create` 与 `entity.set_states`；新增正式写命令必须先扩展 OpenAPI 门与权限测试。
5. 没有执行 Provider、外部生成、上传、远端发布或积分消费；没有声明新 Core operation 已具备 Agent 面。
6. `deepseek_compatible` 当前是离线 Profile/Capability 和 MCP 身份适配，不包含 DeepSeek HTTP 客户端、Tool Call 循环或凭据管理；接入真实客户端前仍需独立网络/密钥授权与安全实现。

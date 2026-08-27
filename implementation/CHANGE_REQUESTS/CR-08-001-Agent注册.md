# CR-08-001｜Film Agent 注册

## 原因

Track 08 只拥有 `canvas-agent/src/film/**`。首切片已提供默认关闭的 `registerFilmAgentMcp`，但现有共享入口 `canvas-agent/src/mcp-server.ts` 尚未调用它，工具目前不可见。

## 请求变更

由 Program Integrator / Canvas Agent Owner 在 Track 02 合入后：

1. 在 `canvas-agent/src/mcp-server.ts` 调用 `registerFilmAgentMcp(server, config)`；注册函数自身仅在 `FILMOS_AGENT_GATEWAY_ENABLED=true` 时暴露工具。
2. 保持现有 `canvasOnly` 与 Dreamina 行为不变；默认环境下 Film 工具数量必须为 0。
3. 注册前由 Track 02/08 将 Film Core OpenAPI 生成为 MCP/Zod Schema，或增加严格合同同步门禁；不得长期保留 API、Agent 和 UI 三套手写定义。
4. 若发布独立 `plugins/film-agent/`，再由 marketplace Owner 增加插件登记；本 CR 不要求提前发布。

## 依赖

- integration 已包含 Track 02 含 `actor_kind` 的 Command/OpenAPI。
- `implementation/FEATURE_FLAGS.yaml` 继续保持 `film.agent_gateway=false`，直到原生 MCP/Golden 通过。

## 测试

- 默认环境：现有 Canvas MCP 工具集合不变。
- 开关启用：仅新增 5 个 `film_*` 工具，不新增 Provider 工具。
- 真实 Sidecar：Read → Preview → Apply；过期 version/hash/revision 任一冲突均拒绝。
- 非人类 Agent 的 Approved/Locked/Script Lock 在 Film Core 调用前拒绝并留审计。

## 回滚

移除共享入口的一行注册调用，或关闭 `FILMOS_AGENT_GATEWAY_ENABLED`；不涉及 Host 表、Film 数据迁移或用户素材。

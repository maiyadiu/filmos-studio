# FilmOS Agent Contracts

FilmOS 原生多脑运行时的共享 TypeScript 合同。该包定义 Brain、Connection、Session、Context、Tool、Confirmation 和 Hosted Handoff 协议，并提供浏览器/Runtime 共用的工具 HTTP 错误安全分类；ChatGPT 公共 MCP 工具合同继续由 `@filmos/tool-contracts` 维护。错误分类只允许 400–599 整数状态并使用固定消息，不携带业务响应正文或凭据。

真实项目页面的 `BrainSession.canvasId` / `AgentContextReceipt.canvasId` / Context Pack `canvas.id` 为 `null`；其 `projectId` 必须等于 `domainProjectId`，不是伪画布。共享 scope 策略只过滤 Canonical 工具清单，不定义第二套工具协议；无画布依赖的已审核工具才可用于项目页，未知工具默认拒绝。原画布会话继续使用真实画布 ID。

`BrainSession`、`AgentConversation`及创建输入的`accountScopeId`用于保存经Runtime验证的账号归属，只能由受信服务端赋值。历史记录没有该字段时保持未认领，不把当前登录账号写回旧记录。它不替代项目、上下文或Grant权限；字段与存储校验存在不代表HTTP/UI已全部实施隔离。

```bash
npm run build
npm test
```

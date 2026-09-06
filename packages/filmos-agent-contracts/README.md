# FilmOS Agent Contracts

FilmOS 原生多脑运行时的共享 TypeScript 合同。该包定义 Brain、Connection、Session、Context、Tool、Confirmation 和 Hosted Handoff 协议，并提供浏览器/Runtime 共用的工具 HTTP 错误安全分类；ChatGPT 公共 MCP 工具合同继续由 `@filmos/tool-contracts` 维护。错误分类只允许 400–599 整数状态并使用固定消息，不携带业务响应正文或凭据。

```bash
npm run build
npm test
```

# OpenAI 产品边界核验

核验日期：2026-08-31

## 官方事实

- OpenAI Secure MCP Tunnel 以本机/私网侧 `tunnel-client` 主动发起出站 HTTPS 的方式，把受支持 OpenAI 产品的 MCP 请求转发到私有 MCP Server；私有服务无需开放公网入站端口。
- 创建/编辑 Tunnel、运行 Tunnel Client、在 ChatGPT 中选择 Tunnel，以及 ChatGPT Developer Mode 是分离的权限域。
- Tunnel 必须关联目标 ChatGPT Workspace 才会在该 Workspace 的应用创建界面中出现；仅关联 Platform Organization 不等于已经关联 ChatGPT Workspace。
- Tunnel Client 需要 Runtime API Key，但该凭据只属于 Tunnel Control Plane；不得进入 Review Pack、日志、仓库或浏览器扩展。
- 官方说明把 Tunnel 定义为传输层。应用级工具权限、认证、审计、只读/写入边界仍由 FilmOS MCP 与 Review Bus 自己执行。

## FilmOS V1.1 裁决

1. ChatGPT Review MCP 只注册读取、校验和 Decision Template 工具，不注册写工具。
2. Assessment/Decision 写回不复用模型 API，也不从网页读取 Cookie 或 Token；仅由用户在 Chrome 中点击后，通过 `127.0.0.1` 的配对 Challenge 写入 Review Bus。
3. OpenAI 模型 API 调用计数固定为 0；ChatGPT 订阅会话与 OpenAI API 计费保持分离。
4. 未来如果官方 Workspace 提供受控 Write MCP，替换的是 Writeback Adapter，不改变 Review Bus、Candidate Binding、Nonce、Replay Protection 或 Dual Signoff 合同。

## 官方来源

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp


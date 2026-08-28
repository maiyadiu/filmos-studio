# FilmOS 本机只读桥插件

本目录是由官方 `plugin-creator` scaffold 建立、并通过其 validator 校验的 Codex 本机插件。它让 Codex 连接已经运行的 FilmOS loopback MCP；它不是 ChatGPT Apps 安装包，也不代表 ChatGPT Developer Mode、Secure MCP Tunnel 或外部账号已经连接。

## 本机使用边界

1. 在仓库根目录构建服务：`npm --prefix services/filmos-chatgpt-app run build`。
2. 保持所有 `film.chatgpt_*` 仓库默认开关为 `false`。只在隔离的本机测试进程中按需设置 `FILMOS_CHATGPT_APP_ENABLED=true`、`FILMOS_CHATGPT_READ_TOOLS_ENABLED=true` 和 `FILMOS_CHATGPT_WIDGETS_ENABLED=true`。
3. 使用 `services/filmos-chatgpt-app` 的 grant CLI 为一个明确项目签发短期 Project Grant；原始 token 只放在当前进程环境变量 `FILMOS_CHATGPT_PROJECT_GRANT_TOKEN`，不写入仓库、URL、日志或插件文件。
4. 在 `127.0.0.1:17840` 启动本机 MCP 服务后加载本插件。服务拒绝非 loopback Host、未允许 Origin、跨项目对象和过期/撤销 Grant。

本插件只配置到 `http://127.0.0.1:17840/mcp`。审批、Lock、Formal Apply、删除、Provider 任务、上传和发布工具不会注册。

## 与 ChatGPT Apps 的边界

ChatGPT 端通过 Developer Mode 连接远程 MCP，需要 OpenAI 平台权限、Secure MCP Tunnel runtime key 和用户外部操作。当前仓库只实现本机 MCP、MCP Apps widgets、Tunnel doctor 与 fail-closed 配置；没有创建公开监听、没有使用真实账号或 API key，也没有伪造“ChatGPT 已连接”。缺少外部权限时准确状态为 `BLOCKED_EXTERNAL_ACCOUNT`。

ChatGPT App 的 MCP/Widget 实现位于 `services/filmos-chatgpt-app`，并不通过 Codex 插件 `.app.json` 冒充安装。

## 验证

```bash
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/filmos-chatgpt
```

安装后应先使用 `filmos-read-context` skill 读取 Project Grant 范围与工具清单；任何写入诉求都必须停在 Proposal/Preview 和人工批准边界。

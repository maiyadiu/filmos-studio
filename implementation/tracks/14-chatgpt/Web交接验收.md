# Track 14 Web 交接验收

## 实施结论

- `VITE_FILM_CHATGPT_APP` 默认关闭；关闭时 `FilmChatGPTHandoffEntry` 返回 `null`，不读取 ProjectDetail，不调用 client。
- 开启后只允许带显式端口的 loopback HTTP 地址，且 `fetch` 固定 `credentials: omit` / `cache: no-store`。
- Project Grant 只能由内存注入的 provider 提供；Web 不写入 localStorage、sessionStorage、URL 或持久化 store。
- 连接回执显式分开 `local_mcp_ready=true` 与 `external_account_connected=false`，当前本地候选保持 `BLOCKED_EXTERNAL_ACCOUNT`。
- `.filmosproposal` 在 Web 仅做 1 MiB 上限与 JSON object 预检，内容全部保持 untrusted；签名、hash、project、time、base state、version 与禁止命令只信任 Film Core 返回的 `FILMOS_PROPOSAL_IMPORT_PREVIEW / PREVIEW_REQUIRES_HUMAN_APPROVAL` 回执。
- UI 仅在权威回执同时声明 `formal_write_executed=false`、`provider_task_created=false`、`deletion_executed=false` 后显示 Preview 成功。
- 打开 ChatGPT 只发生在用户打开指引弹窗并再次点击确认后；不自动导航，不模拟 ChatGPT Pro 订阅。

## 自动验证

| Gate | 结果 | 证据 |
| --- | --- | --- |
| Handoff 专项 | PASS | `bun test test/film-chatgpt-handoff.test.tsx` → 7 pass / 34 assertions |
| Web package 测试 | PASS | `bun run test` → 当前 worktree 基线清单 477 pass，跨 Runtime 1 pass；无 fail |
| TypeScript | PASS | `bun run typecheck` |
| Production build | PASS | `bun run build`；12,711 modules transformed，最大 project chunk 873.60 kB，现有 chunk warning 1 |
| Flag rollback | PASS | 专项测试使用 Proxy ProjectDetail 与抛错 client，确认 flag-off 为 0 DOM / 0 读取 / 0 请求 |

`bun run test` 计数是分支创建时 `integration@35d5f88b` 的 `web/package.json` 显式清单；与后续 integration 中新增测试数不同时，应以合入后的最终全量 Gate 为准。

## 真实浏览器复核

Playwright CLI + headed Chromium 短时打开本地 Vite fixture，复核：

1. 面板同时显示“本机 MCP 已就绪”与“ChatGPT 外部未连接”，未把本地健康写成外部连接。
2. 当前授权项目、最近读取、Context Snapshot URI/version/state hash 均来自 fixture 回执。
3. “导出与打开指引”弹窗显示 Developer Mode、Secure Tunnel、不上传整项目与签名 Proposal 边界。
4. “导入 ChatGPT Proposal”弹窗有 `.filmosproposal` 文件选择、1 MiB 上限、untrusted 说明；未选文件时权威 Preview 按钮不可用。
5. 390×844 窄屏下四项状态与操作按钮仍可访问。
6. 修正 Ant Design 6 Alert 用法后重开页面，没有浏览器 console error。

浏览器 fixture、Vite 进程、Playwright session、新生 snapshot/log 和临时 `node_modules` symlink 均已关闭或删除。此复核是本地 UI 候选证据，不是真实 ChatGPT/Secure Tunnel 连接证据。

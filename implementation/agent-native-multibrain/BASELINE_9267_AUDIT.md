# Agent 原生多脑基线审计

## 固定身份

- Repository：`maiyadiu/filmos-studio`
- Base branch：`integration`
- Base commit：`9267a5f198182bfa16403723e865cf815983ef13`
- Base tree：`962386145e28810f794bdc2e3e926dc3520b0cd9`
- Parent implementation：`47aabe8032c4fc3aae97c403d6cb1767b79aa682`
- Worktree：`../wt-agent-native-multibrain-v11-final`
- Branch：`fix/agent-native-multibrain-v11-final`
- Task contract SHA-256：`1e6f835e3d24855796231aa856c53a2b6dd262c3b04178c805e127b6ce908f83`
- Baseline Acceptance：GitHub Run `33247094026`，23/23 PASS
- `main` baseline：`73f3ae5381fd7c48cd9ad262164c05c435dd6385`
- RC1：不存在，本任务禁止创建

审计在固定 commit 上完成。`upstream-yingce/main` 在审计期间已经继续前进，但本任务的兼容与回滚基线继续使用 `acceptance/MANIFEST.json` 冻结的 candidate commit `19ebfbb3c1dd0227d6a194cd6067d5e06e27e521`，不跟随漂移远端。

## 已接受的 Host Foundation

以下实现判定为 REUSE/EXTEND，不重写：

- `ServiceSupervisor.swift`：受控子进程与运行时 secret 注入。
- `SecureTokenStore.swift`：Runtime Key Keychain 边界。
- `ChatGPTConnectionManager.swift`：Tunnel 状态机、doctor、重连和 Live Gate。
- `DesktopChatGPTRuntime.swift`：Film Core、MCP、Tunnel 子进程编排。
- `ChatGPTConnectionWindow.swift`：连接设置与诊断窗口。
- Track 14 的 Project Grant、Secure Proof、Challenge、只读 MCP、Widget、Proposal 签名与 Preview。
- `packages/filmos-tool-contracts`：ChatGPT 公共工具合同。
- 现有 Acceptance、外部 Live Gate 和 NO API Billing 基础检查。

这些能力属于 `chatgpt.subscription.host` Transport Foundation，不是原生 Agent Shell，也不能被复制为第二套聊天产品。

## V1.0 七项缺口复核

| ID | 结论 | 真实证据 | 实施裁决 |
|---|---|---|---|
| A | PRESENT | `canvas-agent/src/agents.ts` 的内部 MCP 命令仍固定 `mcp --canvas-only`；`mcp-server.ts` 用布尔 `canvasOnly` 控制 Film Gateway | EXTEND：显式 `AgentToolSurfaceId`，Codex 使用 `workbench_operator` |
| B | PRESENT | `canvas-agent/src/modules/canvas-agent-http.ts` 和 Web 本机面板仍直接依赖 `/agent/codex/*` 特例 | MIGRATE：通用 Connection/Session/Turn/Confirmation API，旧路由保留兼容 |
| C | PRESENT | Web store 与 Agent chrome 仍使用 `CanvasAgentMode = online | local` | MIGRATE：Brain Profile + Connection + Session，保留旧偏好兼容读取 |
| D | PRESENT | `canvas-agent/src/film/profile.ts` 仍是进程环境身份/能力声明，不是 Runtime Adapter | BUILD：Registry、Adapter、Session Principal；env 仅留测试回退 |
| E | PRESENT | `services/filmos-chatgpt-app` 未进入原生 Agent Registry/Session UI | EXTEND：作为 Hosted Adapter 纳入同一原生 Panel，不伪造内嵌流式对话 |
| F | PRESENT | `agents.ts` 同时设置 `approvalPolicy: never`、MCP `approve`，并对 `mcpServer/elicitation/request` 自动 `accept` | REMOVE_AFTER_MIGRATION：统一 pending confirmation，超时/断连拒绝 |
| G | PRESENT | `agents.ts` 仍有全局 `codexQueue`、`codexApp`、`codexThreadId` | MIGRATE：单一受控 app-server owner + per-session queue/thread 路由 |

## V1.1 Host Foundation 缺口复核

| ID | 结论 | 真实证据 | 实施裁决 |
|---|---|---|---|
| H1 | PRESENT | `StoredChatGPTConnection` 同时保存 Tunnel 与 project，层级混合 | 全局 Host Connection 与 per-project Host Session 解耦、兼容迁移 |
| H2 | PRESENT | `DesktopChatGPTRuntime.runtimeHealth()` 写死 `mcpToolCount: 20`、`mcpWriteToolCount: 0` | MCP `/manifest` 返回实际注册工具及风险；Desktop 动态解析 |
| H3 | PRESENT | MCP `externalObservation` 是进程级单值 | `Map<grantId, observation>`，绑定 session/project/challenge 并带 TTL |
| H4 | PRESENT | `main.swift` 在项目未知时回退 `host-project-1` | 删除测试兜底；无真实项目时 fail closed |
| H5 | PRESENT | NO API Billing 只有静态路径扫描 | 保留静态 Gate，新增 profile/transport/billing/fallback 的 per-turn 审计与 Adapter 选择测试 |

## Codex 协议事实

审计机器上的官方 Codex CLI 为 `codex-cli 0.150.0-alpha.12.2`。使用以下命令在项目外临时目录生成真实合同：

```bash
codex app-server generate-ts --experimental --out <temp>/ts
codex app-server generate-json-schema --experimental --out <temp>/json
```

生成合同确认：

- `AskForApproval` 支持 `untrusted | on-request | granular | never`；
- granular 策略含 `mcp_elicitations`；
- Server Request 有 `mcpServer/elicitation/request`、命令/文件/权限审批；
- Client Request 有 `account/read`、`account/rateLimits/read`、登录起止、Thread/Turn、MCP status/tool call；
- Thread/Turn 支持 `approvalPolicy` 和 reviewer；
- 当前任务必须以生成合同和仓库锁定依赖为准，不复制登录 token。

## 当前真值源与边界

- Film Core 是正式业务事实源；聊天消息不是事实源。
- 原生右侧 Agent Panel 是唯一产品入口。
- ChatGPT Connection Window 是设置页。
- ChatGPT Subscription 是 `host_handoff`，Codex Subscription 是 `native_stream`。
- API Profile 仅在用户显式选择后实例化；订阅失败不得创建 API Adapter。
- 所有正式写入继续遵守 Read → Preview → Human Confirmation → Apply → Postcondition → Audit。

## WP-00 出口条件

- [x] 固定 commit 远程存在且 `integration` 包含。
- [x] `main` 未改变。
- [x] RC1 Tag 不存在。
- [x] 指定 worktree/branch 已创建且初始干净。
- [x] V1.0 七项缺口逐项复核。
- [x] V1.1 Foundation 五项缺口逐项复核。
- [x] Codex 实际 Schema 已生成并核对。
- [x] REUSE/EXTEND/BUILD/REMOVE_AFTER_MIGRATION 矩阵已冻结。


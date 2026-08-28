# 第五阶段 Beta 验收报告

## 总结论

第五阶段状态为 `PASSED_LOCAL_WITH_KNOWN_BLOCKERS`。Remote/Hybrid 本地接线、通用 Agent Adapter、性能基线、合成迁移与恢复、上游候选演练、unsigned macOS App 和真实浏览器回退均完成本地验收；所有新增 Feature Flag 保持默认关闭。

该结论不包含真实 PostgreSQL/用户数据迁移、Remote 执行与上传、外部 Provider、Apple 签名/公证、DMG/PKG、生产发布或业务 Approval。上述动作均未获授权，也未执行。

## 验收矩阵

| 验收面 | 状态 | 当前证据 |
| --- | --- | --- |
| Remote/Hybrid 本地接线 | `PASSED_LOCAL` | 15 tests / 84 assertions；浏览器 Preview、Human 本地回执、恢复和 Flag 回退通过 |
| 网络与上传边界 | `PASSED_ZERO_EXTERNAL` | Remote/Agent/Browser 的 network、upload、provider 均为 0；确认链无新增请求 |
| Agent Adapter | `PASSED_LOCAL` | Codex/DeepSeek/Claude/Local/System/Human Only 共用同一 5-tool 合同；DeepSeek-compatible 离线无密钥/端点 |
| Agent Approval 拒绝 | `PASSED_LOCAL` | Agent Read → Preview 后 Apply 拒绝并留审计；只有 Human Only + 新鲜确认可 Apply；Agent 不能 Approval/Lock |
| Dreamina 顺序门禁 | `PASSED` | Canvas Agent 全量 354 tests：349 pass、0 fail、5 Windows skip；原先疑似顺序项在全量中通过 |
| 合成迁移包 | `PASSED_LOCAL_EQUIVALENT` | 10 tests；6 表/14 行；manifest/hash/row/FK/Stable ID/receipt/幂等/故障回滚/备份恢复通过 |
| 真实 PostgreSQL / 用户迁移 | `BLOCKED_REAL_PG / NOT_AUTHORIZED` | 未提供临时 PG；未读取或修改用户数据库 |
| 性能基线 | `PASSED_WITH_WARNING` | Core、Remote、Agent、Browser p95 均过预算；Web 10 个 JS 超 500 KB warning，最大 1,821,047 bytes，未超过 2.5 MB 本地阻断线 |
| 上游兼容演练 | `C_MIGRATION_REQUIRED` | Candidate `19ebfbb3...` 原生 gate 通过；Models/Migrations 为 C，未合并；rollback dry-run 通过 |
| unsigned macOS App | `PASSED_LOCAL_UNSIGNED` | Swift 14/14；release `.app` 结构和 smoke 通过；bundle hash `ea400550...` |
| 签名、公证与发布包 | `NOT_AUTHORIZED` | 未使用 Apple 凭据，未签名、公证或构建发行包 |
| 恢复与回滚 | `PASSED_LOCAL` | Remote receipt 恢复/STALE、迁移事务与备份恢复、Flag off、上游 rollback dry-run 全部通过 |
| 外部执行 | `NOT_AUTHORIZED / NOT_EXECUTED` | Provider、上传、额度、远端发布、生产同步均为 0 |

## 完整门禁

| 层 | 结果 |
| --- | --- |
| Film Contracts | `FILM_CONTRACTS_OK schema=0.4.0 paths=23 implemented=23 planned=0 axes=6` |
| Film Core | 50 pass；仅 1 个 Starlette TestClient 弃用告警 |
| Golden A/B/C Python | 26 pass |
| Golden TypeScript | 6 pass / 37 assertions |
| Backend | `GOPROXY=https://goproxy.cn,direct go test ./...` 全部通过 |
| Web | 610 pass / 0 fail / 2583 assertions / 84 files；typecheck 和 production build 通过 |
| Canvas Agent | 354 tests / 349 pass / 0 fail / 5 skip；OpenAPI check 与 build 通过 |
| Migration/Recovery | 10 pass；`PASSED_LOCAL_EQUIVALENT`；真实 PG 为 `BLOCKED_REAL_PG` |
| Performance | Python 1 pass；Surface 1 pass / 8 assertions；所有硬预算通过 |
| Desktop | Swift 14 pass / 3 suites；unsigned `.app` verify 通过 |
| Browser | 本地 Preview/Human receipt/reload/flag-off 通过；最终 Console 0 error / 0 warning |

## 性能结果

固定数据为 80 ContentUnits、80 Shots、80 Remote Assets、80 Candidate results；Core/Remote/Agent 各采样 60 次，浏览器读取 40 次。

| 路径 | p50 | p95 | 预算 | 结果 |
| --- | ---: | ---: | ---: | --- |
| App init | 13.700 ms | 16.977 ms | 2000 ms | PASS |
| Project Context | 2.420 ms | 2.801 ms | 250 ms | PASS |
| Entity Read | 0.537 ms | 0.657 ms | 100 ms | PASS |
| Command Preview | 0.544 ms | 0.699 ms | 100 ms | PASS |
| Remote Preview | 1.305 ms | 3.136 ms | 100 ms | PASS |
| DeepSeek Read→Preview→Apply denied | 0.046 ms | 0.120 ms | 100 ms | PASS |
| Browser Host Project Read | 6.500 ms | 8.900 ms | 100 ms | PASS |

全部采样错误为 0；Agent Preview 60 次、Apply dispatch 0 次；网络、上传与外部 Provider 均为 0。Web 构建含 834 个 JavaScript 文件，其中 10 个超过 500 KB warning；最大 chunk `chunk-EIO257PC-CSbDGS6Q.js` 为 1,821,047 bytes。该风险已显式保留，不能写成无告警通过。

## 上游与发行边界

- Stable 仍锁定 `v1.2.1` / `61b332583c4fcbf71890ae67e3f0f104d67706b9`。
- Candidate 为 `19ebfbb3c1dd0227d6a194cd6067d5e06e27e521`；原生 Backend/Agent/Web gate 已通过。
- API `B`、Models `C`、Migrations `C`、Canvas `B`、MCP `A`，总体仍为 `C_MIGRATION_REQUIRED`；没有迁移批准，不合并 Candidate。
- unsigned `.app` 只证明本地 bundle 可构建、可核验和受控启动；`_CodeSignature` 不存在，服务没有自动启动。

## 已知阻断与下一阶段输入

1. Remote 当前只有本地 Preview/receipt；真实执行器、权限二次校验、部分失败/重试、上传与 publication receipt 仍未实现，且需单独授权。
2. 真实 PostgreSQL 迁移未运行；解除 `BLOCKED_REAL_PG` 需要明确的临时 PG 环境与独立授权，用户数据迁移仍禁止。
3. Web 大 chunk warning 未消除；后续性能阶段需做路由/编辑器/媒体运行时拆包，不可通过提高 warning 阈值掩盖。
4. 上游 Candidate 的持久模型和 migration 差异仍为 C；必须先完成可回滚迁移与 Golden，再决定吸收。
5. Apple 签名、公证、DMG/PKG、自动更新和外部发布均未授权。

## 证据入口

- 浏览器：`implementation/test-reports/浏览器Beta.md`
- 性能：`tests/film-beta/README.md`
- 迁移：`implementation/tracks/11-migration/EVIDENCE.md`
- Remote：`implementation/tracks/12-remote/EVIDENCE.md`
- Agent：`implementation/tracks/08-agent/EVIDENCE.md`
- 上游：`implementation/tracks/00-upstream/EVIDENCE.md`

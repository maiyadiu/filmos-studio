# Track 00｜上游基线与持续兼容

TRACK: `00-upstream`
MODEL: `GPT-5.6 Sol`
REASONING: `XHigh`
STATUS: `IMPLEMENTED`
CANDIDATE_GATE: `D_BLOCKED`

## 1. 本轨目标

把 Yingce Upstream 的稳定基线固定为 `v1.2.1`，提供只读 Release 发现、Stable/Candidate/Dev 三态解析、API/GORM Model/Migration/Canvas Schema/MCP 差异分析、A/B/C/D 判级、候选验证报告、Thin Patch Manifest 与可恢复回滚入口。

## 2. 实际核查

- GitHub Release API：`ddcat-ai/open-ai-canvas` 当前最新非 prerelease 为 `v1.2.1`，发布时间 `2026-08-26T08:29:49Z`。
- Stable：本地 annotated tag `v1.2.1` 与别名 `filmos-upstream-v1.2.1` 均 peel 到 commit `61b332583c4fcbf71890ae67e3f0f104d67706b9`；tree 为 `87c68a9da95ef4f5914b7fc5d662dc0aac452264`。
- Candidate：`upstream-yingce/main` 为 `4ee5b630edfbd6da1e41b98ef1d2f3b1184c345a`，且是 Stable 的后代。
- Dev：本轨开工 HEAD 为 `f3a1bc925aca081816d1771f451b5d4cfcec6b76`，且是 Stable 的后代。
- Reference：`reference-tigerowo/main=57b13aa1a2d7439955b0e65abe742bc7144df32f`；`reference-basket/main=ed013e8e5ce8ccab47cf2fc779f8e94555eb4c23`。
- API：读取 `backend/cmd/server/main.go`、`backend/internal/handler/*.go`、`web/src/services/api/*`。Candidate 新增插件状态、管理员可用性和用户激活接口，并改变插件响应/权限语义。
- GORM Model/Migration：读取 `backend/internal/model/*.go`、`backend/internal/database/schema.go`、`backend/cmd/migrate-*`。Candidate 新增 `PluginPlatformState`、`UserPluginState`、`StorageLocation`，并给 `ChannelModel` 增加 `Icon`，`Models()` 同步新增三张表。
- Canvas Schema：读取 `web/src/lib/canvas/canvas-document.ts`、`canvas-project-domain.ts`、`web/src/types/director.ts`、`web/src/stores/canvas/**`。Candidate 增加 Director 关键帧类型并调整画布项目域实现。
- MCP：读取 `canvas-agent/src/mcp-server.ts`、`schemas.ts`、`modules/*-mcp.ts`、`plugins/yingce/.mcp.json`。Stable 到 Candidate 当前无 MCP 文件差异。
- 现状：仓库没有 `scripts/upstream/` 或上游兼容工作流；`implementation/UPSTREAM_COMPATIBILITY.md` 仅记录未分类静态状态。

## 3. 已存在能力

- `REUSE`：Git annotated tag、远端跟踪 ref、GitHub Release API、原生 backend/web/canvas-agent 测试入口。
- `REUSE`：`upstream-yingce` 作为唯一候选上游；两个 reference remote 仅供只读检索。
- `EXTEND`：现有 `implementation/UPSTREAM_COMPATIBILITY.md` 作为固定策略与当前判定入口。

## 4. Fit-Gap

- `REUSE`：Git ref/merge-base/diff/worktree；Release API；现有构建与测试命令。
- `EXTEND`：兼容说明、GitHub Actions 只读扫描与候选构建。
- `BUILD`：`check-release`、五类 diff、`run-compat`、固定基线配置、内部解析器、夹具测试、Thin Patch Manifest、安全回滚入口。
- `DEFER`：任何自动 merge/rebase/cherry-pick、自动推送、自动发版；D 级裁决后的数据迁移实施由对应 Owner 和 Program Integrator 处理。

## 5. 本次最小修改范围

- `scripts/upstream/**`
- `.github/workflows/film-upstream-compat.yml`
- `implementation/UPSTREAM_COMPATIBILITY.md`
- `implementation/tracks/00-upstream/TRACK_PLAN.md`
- `implementation/tracks/00-upstream/EVIDENCE.md`

## 6. 明确不做

- 不 fetch 后自动合并，不修改任何远端，不整仓合并 reference 仓。
- 不修改 Yingce 核心源码、Film Contracts、其他 Track 文件、`PROGRAM_BOARD.yaml` 或共享合同。
- 不把健康检查、静态 diff 或报告生成冒充 Candidate 构建通过。
- 不在工作树不干净时执行回滚切换，不使用 reset/checkout 丢弃改动。

## 7. 状态与判级合同

- `Stable`：必须是 tag `v1.2.1` 且 peel commit 精确为 `61b332583c4fcbf71890ae67e3f0f104d67706b9`。
- `Candidate`：默认 `upstream-yingce/main`，必须可解析且是 Stable 后代；只读分析，不合并。
- `Dev`：默认当前 `HEAD`，用于生成 Stable 到 FilmOS 的 Thin Patch Manifest，不能冒充 Candidate。
- `A_AUTO_COMPATIBLE`：无相关差异，或仅明确向后兼容的新增表面。
- `B_ADAPTER_CHANGE`：API/Canvas/MCP/协议表面发生兼容性变化，需要 Adapter 或人工核查。
- `C_MIGRATION_REQUIRED`：持久模型或迁移路径变化，需要可回滚迁移和 Golden。
- `D_BLOCKED`：基线漂移、ref 不可解析、Candidate 非 Stable 后代、稳定表面删除或候选验证失败。

## 8. 测试计划

- Python 编译和 shell 语法检查。
- 夹具仓库覆盖：基线 hash 验证、三态解析、A/B/C/D、离线 Release 降级、Candidate 非后代阻断、只读报告与回滚 dry-run。
- 对真实 `v1.2.1..upstream-yingce/main` 运行 `run-compat`，记录真实分类和清单。
- 检查工作流 YAML 与脚本权限；候选原生构建由工作流隔离 worktree 执行，本轨本地若未运行则在证据中明确标记。

## 9. 回滚方式

- 脚本回滚：回退本 Track 单一提交即可，不涉及业务数据。
- 运行态回滚：`scripts/upstream/rollback --dry-run` 先验证目标；仅在干净工作树上显式执行，切到固定 Stable detached HEAD 或创建新分支，不移动现有分支指针。
- 报告输出默认写入被 `.gitignore` 排除的 `.local/upstream-compat/`，删除报告不影响源码。

## 10. 依赖与共享变更

- Program Integrator：决定 C/D 后是否建立迁移 RFC 或暂停升级。
- Track 13：消费 `run-compat` 结果进入 Golden/恢复测试。
- Shared contract requests：无。
- Feature flag：无；本轨只读检测和 CI 不进入产品运行时。

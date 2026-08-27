# Track 00 验证证据

## 结论

- Track 00 实现状态：`IMPLEMENTED`。
- 固定 Stable：`v1.2.1` → `61b332583c4fcbf71890ae67e3f0f104d67706b9`；tree `87c68a9da95ef4f5914b7fc5d662dc0aac452264`。
- 当前 Candidate：`upstream-yingce/main` → `4ee5b630edfbd6da1e41b98ef1d2f3b1184c345a`，是 Stable 后代。
- 静态兼容分类：`C_MIGRATION_REQUIRED`。
- Candidate 原生验证 gate：`D_BLOCKED`；上游 backend 原生测试有 1 个真实失败，未合并 Candidate。

验证日期：`2026-08-28`（Asia/Shanghai）。

## 实际源与只读边界

核查了 GitHub Release API、本地 annotated tag、`upstream-yingce/main`、`reference-tigerowo/main`、`reference-basket/main`，以及以下真实源码：

- API：`backend/cmd/server/main.go`、`backend/internal/handler/*.go`、`web/src/services/api/*`
- Model/Migration：`backend/internal/model/*.go`、`backend/internal/database/schema.go`、`backend/cmd/migrate-*`
- Canvas：`web/src/lib/canvas/**`、`web/src/stores/canvas/**`、`web/src/types/director.ts`
- MCP：`canvas-agent/src/mcp-server.ts`、`canvas-agent/src/schemas.ts`、`canvas-agent/src/modules/*-mcp.ts`、`plugins/yingce/.mcp.json`

两个 reference remote 只解析 commit，未执行 merge/rebase/cherry-pick。所有临时 Candidate worktree 在验证结束后已移除，`git worktree list --porcelain` 无残留临时目录。

## 命令与真实结果

### 1. 脚本语法与夹具回归

```bash
python3 -m py_compile scripts/upstream/_compat.py
for f in scripts/upstream/check-release scripts/upstream/diff-api scripts/upstream/diff-models scripts/upstream/diff-migrations scripts/upstream/diff-canvas-schema scripts/upstream/diff-mcp scripts/upstream/run-compat scripts/upstream/rollback; do bash -n "$f"; done
python3 -m unittest discover -s scripts/upstream/tests -p 'test_*.py' -v
```

结果：Python/shell 语法通过；`5` 个测试全部通过。测试覆盖固定 hash 漂移、A/B/C/D、Stable/Candidate/Dev、Release 离线降级、Candidate 非 Stable 后代、报告 manifest 和 rollback dry-run。

### 2. Release 与固定基线

```bash
scripts/upstream/check-release --json
```

结果：`A_AUTO_COMPATIBLE`；GitHub 最新稳定 Release 为 `v1.2.1`，`draft=false`、`prerelease=false`、`published_at=2026-08-26T08:29:49Z`。本机 Python CA 链不可用时，脚本使用不带 `-k` 的 curl 只读回退成功；完全无网络时返回 B，不声称远端已核验。

### 3. 五类真实 diff

```bash
scripts/upstream/diff-api
scripts/upstream/diff-models
scripts/upstream/diff-migrations
scripts/upstream/diff-canvas-schema
scripts/upstream/diff-mcp
```

结果：

| 检查 | 分类 | 结果 |
| --- | --- | --- |
| API | `B_ADAPTER_CHANGE` | 11 added / 0 removed / 18 source files touched |
| Models | `C_MIGRATION_REQUIRED` | 3 structs added / 1 changed / 0 removed |
| Migrations | `C_MIGRATION_REQUIRED` | 2 migration/schema source files modified |
| Canvas Schema | `B_ADAPTER_CHANGE` | 70 exports added / 0 removed / 27 source files touched |
| MCP | `A_AUTO_COMPATIBLE` | 0 tool/schema/file changes |

### 4. 汇总、上游清单与 Thin Patch

```bash
scripts/upstream/run-compat --output .local/upstream-compat --fail-on D_BLOCKED
```

结果：静态总体 `C_MIGRATION_REQUIRED`，退出码 `0`；生成 `summary.json`、`summary.md`、六类检查 JSON、`upstream-changes.tsv` 和 `thin-patch-manifest.tsv`。输出位于 Git 忽略的 `.local/`，没有把运行日志提交到仓库。

### 5. 隔离 Candidate 原生验证

```bash
scripts/upstream/run-compat --build-candidate --output .local/upstream-compat-build --fail-on D_BLOCKED
```

结果：退出码 `2`，总体 `D_BLOCKED`。backend 多个 package 已通过；`backend/internal/service` 中 `TestOSSSettingKeepsS3SecretsWhenLocationChanges` 失败，位置为上游 `backend/internal/service/storage_s3_test.go:142`，错误“外部服务域名解析失败”。完整本机日志：`.local/upstream-compat-build/candidate-build.log`（未提交）。

脚本按 fail-fast 停止，未继续执行 Canvas Agent/Web install/test/build，也未将 Candidate 合入任何 FilmOS 分支。

### 6. 回滚保护

```bash
scripts/upstream/rollback --dry-run
```

结果：只读解析固定 Stable；报告当前工作树若不干净，正式执行会拒绝。正式入口只允许 detached Stable 或新建分支，不移动现有分支、不 reset、不删除数据。

## Known gaps

1. Candidate 原生验证当前为 `D_BLOCKED`；必须先解决/确认上游 S3 测试的 DNS 依赖，再重新执行完整 backend、Canvas Agent 和 Web 验证。
2. 当前差异器是确定性的静态 inventory/diff gate，不替代 OpenAPI 语义兼容器、真实数据库迁移演练或 Track 13 Golden；C 级结果必须交由 Program Integrator 和相关 Owner 继续验证。
3. GitHub Actions 工作流已定义，但本轨未外部推送，因此没有远端 Actions run URL/receipt；本地证据不能冒充远端 CI 已通过。

## 回滚

- 代码：回退本 Track 单一提交；没有业务表或用户数据变更。
- Candidate：保持当前 FilmOS 分支不变；必要时先运行 `scripts/upstream/rollback --dry-run`，再在干净工作树显式切到固定 Stable。
- 报告：删除 `.local/upstream-compat*` 即可，不影响源码和 Git refs。

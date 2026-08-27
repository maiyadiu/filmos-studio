# 上游兼容状态

## 固定基线

| 状态 | Ref | Commit | 用途 |
| --- | --- | --- | --- |
| Stable | `v1.2.1` | `61b332583c4fcbf71890ae67e3f0f104d67706b9` | 唯一兼容基线和回滚锚点 |
| Candidate | `upstream-yingce/main` | `4ee5b630edfbd6da1e41b98ef1d2f3b1184c345a` | 只读上游候选，不自动合并 |
| Dev | `HEAD` | 随 FilmOS 分支推进 | FilmOS Thin Patch，不冒充上游候选 |
| Tigerowo reference | `reference-tigerowo/main` | `57b13aa1a2d7439955b0e65abe742bc7144df32f` | 只读模块检索 |
| Basket reference | `reference-basket/main` | `ed013e8e5ce8ccab47cf2fc779f8e94555eb4c23` | 只读模块检索 |

Stable tag 必须同时满足：

- tag：`v1.2.1`
- peeled commit：`61b332583c4fcbf71890ae67e3f0f104d67706b9`
- tree：`87c68a9da95ef4f5914b7fc5d662dc0aac452264`
- GitHub 最新非 draft、非 prerelease Release：`v1.2.1`

`VERSION` 文件在该 tag 内仍写着 `v1.2.0-preview.1`，因此不能把单个版本文件当 Release 真值；脚本以 GitHub Release、annotated tag、commit 和 tree 四项验证为准。

## 三态边界

- `Stable`：固定、可验证、可回滚，脚本不允许通过参数悄悄替换基线；测试只能显式传入另一份 fixture config。
- `Candidate`：默认 `upstream-yingce/main`，必须能解析且是 Stable 后代。若把 `reference-tigerowo/*` 或 `reference-basket/*` 作为 Candidate，直接判 `D_BLOCKED`。
- `Dev`：当前 FilmOS `HEAD`，仅用于生成 `thin-patch-manifest.tsv`。Candidate 与 Dev 始终分别显示 commit，避免把产品改动算成上游改动。

所有检查只使用 Release HTTP GET、`git rev-parse`、`merge-base`、`diff`、`show` 和临时 detached worktree。不会执行 merge、rebase、cherry-pick、push 或 release。

## 兼容分级

- `A_AUTO_COMPATIBLE`：固定基线有效，相关稳定表面无差异；Release 与基线一致。
- `B_ADAPTER_CHANGE`：API、Canvas Schema、MCP 或协议实现有增量/修改，需 Adapter 或人工复核；Release API 离线时也保守降级为 B，不声称已核验最新 Release。
- `C_MIGRATION_REQUIRED`：GORM 持久模型或 migration/schema 路径改变，必须有可回滚迁移和 Golden 验证。
- `D_BLOCKED`：tag/commit/tree 漂移、必要 remote 错配、ref 不可解析、Candidate 非 Stable 后代、稳定表面删除，或隔离 Candidate 原生验证失败。

总体分类取各检查最严重级别。默认 `run-compat` 只在 D 返回非零；可通过 `--fail-on` 提高 CI 门槛。

## 命令

```bash
scripts/upstream/check-release
scripts/upstream/diff-api
scripts/upstream/diff-models
scripts/upstream/diff-migrations
scripts/upstream/diff-canvas-schema
scripts/upstream/diff-mcp
scripts/upstream/run-compat --output .local/upstream-compat
```

每个 diff 默认比较 Stable → Candidate；使用 `--target dev` 可诊断 Stable → Dev。`--json` 提供机器可读结果。

完整报告包含：

- `summary.json` / `summary.md`
- `release.json`、`api.json`、`models.json`、`migrations.json`、`canvas-schema.json`、`mcp.json`
- `upstream-changes.tsv`：Stable → Candidate 上游修改清单，含前后 blob ID
- `thin-patch-manifest.tsv`：Stable → Dev FilmOS Thin Patch，含前后 blob ID
- `candidate-build.log`：仅在 `--build-candidate` 时生成

候选原生验证在隔离 detached worktree内运行 backend tests、Canvas Agent install/test/build、Web install/build；验证失败判 D。CI 工作流 `.github/workflows/film-upstream-compat.yml` 定时、手动或在兼容脚本变更的 PR 上执行该路径，并只上传报告 artifact。

无网络时使用：

```bash
scripts/upstream/run-compat --offline --output .local/upstream-compat
```

这只证明本地固定基线和已有 refs 可分析，不证明 GitHub 当前 Release 未变化。

## 当前真实判定

对 `v1.2.1..upstream-yingce/main` 的本轨扫描结果：

| 检查 | 分类 | 证据摘要 |
| --- | --- | --- |
| Release | `A_AUTO_COMPATIBLE` | GitHub 最新稳定 Release 仍为 `v1.2.1` |
| API | `B_ADAPTER_CHANGE` | 新增 11 个后端/前端端点表面，且 18 个 API 源文件有改动；无端点删除 |
| GORM Models | `C_MIGRATION_REQUIRED` | 新增 3 个持久 struct，`ChannelModel` 增加 `Icon` |
| Migrations | `C_MIGRATION_REQUIRED` | `schema.go` 与 SQLite→PostgreSQL 迁移实现均修改 |
| Canvas Schema | `B_ADAPTER_CHANGE` | 新增 Director 类型与运行语义；无已导出类型删除 |
| MCP | `A_AUTO_COMPATIBLE` | Candidate 当前无 MCP 文件/工具 Schema 差异 |

静态总体分类为 `C_MIGRATION_REQUIRED`。加入隔离 Candidate 原生验证后，当前 gate 为 `D_BLOCKED`：`go test ./...` 在上游 `backend/internal/service/storage_s3_test.go` 的 `TestOSSSettingKeepsS3SecretsWhenLocationChanges` 失败，真实错误为“外部服务域名解析失败”。验证按 fail-fast 停止，因此 Canvas Agent/Web 构建尚未执行。

这不等于 Track 00 实现失败；它证明 D 级门禁能阻止一个原生测试未通过且包含数据迁移的 Candidate 被自动吸收。上游测试环境/实现修复后必须重新运行完整 Candidate build，不能跳过该测试来降级判定。

## 回滚

先做只读检查：

```bash
scripts/upstream/rollback --dry-run
```

显式执行时，脚本仅允许干净工作树，并切到固定 Stable detached HEAD；也可用 `--branch <新分支名>` 在 Stable 创建新分支。脚本不移动既有分支指针，不使用 reset，不删除文件。

若需要撤销 Track 00 本身，回退本 Track 单一提交即可；本轨没有业务数据迁移。

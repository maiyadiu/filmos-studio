# RC 恢复与 Candidate 迁移裁定

## 结论

Stage 6 统一本地恢复演练为 `PASSED_LOCAL_RC_RECOVERY`。Stable→Candidate 仍为 `C_MIGRATION_REQUIRED`；本轮没有合并 Candidate，没有打开用户真实 SQLite/PostgreSQL，没有远程发布、Provider 调用或正式 Apply。

## 单一恢复链

`scripts/recovery/RC恢复演练 --synthetic` 在新的临时标记 sandbox 内统一执行：

- Remote：重算 manifest hash，写入合成 Human 本地回执，幂等重放并恢复同一 receipt；状态始终是 `NOT_EXECUTED` / `CANDIDATE_ONLY`。
- Feature Flag：检查 13 个 Film flag 全部默认 `false`，默认 Remote Preview 返回 `FEATURE_DISABLED`，回退规则仍在。
- Agent：DeepSeek-compatible 可 Read/Preview，Apply 以 `human_apply_required` 拒绝；Human-only 会话重建后旧 Read/Preview receipt 以 `read_required` 失效，两路均为零 Apply 且有 denial audit。
- Stage 5 迁移：原有 6 表/14 行合成包继续验证源 hash、Stable ID、FK、行 hash、receipt、故障原子回滚、备份恢复和幂等。
- Film Core：新建 schema v4 合成库，固定 Film/Audit ID 和 receipt；备份后验证逻辑行 hash/FK/ID/receipt，故障注入后无部分事实，恢复库与源逻辑 hash 相同。
- Candidate adapter：校验固定 Git diff，在合成 Stable 投影副本上完成 DDL、探针行、故障回滚、幂等重放与精确备份回退。

统一 receipt 在 `tests/film-rc/rc-recovery-receipt.json`。逻辑 replay key 绑定各子链 receipt/manifest/state hash；每次新建 SQLite 的物理文件 hash 仍独立保留为当次证据。

## 实际 Candidate diff

固定比较为：

- Stable `v1.2.1` / `61b332583c4fcbf71890ae67e3f0f104d67706b9`
- Candidate `upstream-yingce/main` / `19ebfbb3c1dd0227d6a194cd6067d5e06e27e521`
- Model diff SHA-256 `170d973619b711c4ecac5e01fb572841fc66165acc44f83ffa2dc0692856686d`
- Migration diff SHA-256 `f851083e3b5646b944297ce7dddeea11536cde205fabe7edc6090e7d869cdf63`

Models 的实际增量为：

- 新增 `PluginPlatformState`：平台可用性、更新人和时间，`plugin_id` 为主键。
- 新增 `UserPluginState`：`id` 为主键，`user_id + plugin_id` 唯一，记录用户启用状态。
- 新增 `StorageLocation`：`scope + owner_id + provider + location_digest` 唯一，存储位置和测试摘要。
- `ChannelModel` 新增 `Icon string` / `json:"icon"` / `gorm:"size:80"`。

Candidate 还将 14 张已纳入 `database.Models()` 的表补入 SQLite→PostgreSQL migration list：`channel_model_price_tiers`、`id_sequences`、`logical_models`、`logical_model_revisions`、`logical_model_routes`、`route_attempts`、`plugin_platform_states`、`user_plugin_states`、`ark_private_asset_bindings`、`storage_locations`、`resource_deletion_jobs`、`project_asset_folders`、`comfy_bridges`、`comfy_bridge_requests`。

## 迁移与回退计划

1. 开始前固定 Stable/Candidate commit、model/migration diff hash、数据库文件 hash、表/行/索引盘点和可恢复备份。
2. `ChannelModel.Icon` 先作 nullable 增量字段；不猜测旧模型图标，不做自动回填。应用层只将无值视为空图标。
3. 创建 3 张新表及 GORM tag 对应索引；初始保持空表，不从用户设置或 OSS 凭证推断/复制 Plugin 或 Storage 状态。
4. SQLite 只在已复制的演练库上 AutoMigrate/投影验证；PostgreSQL 正式方案必须单事务建表/建索引，然后重做 schema、行数、ID 和 hash 验证。
5. 回退默认使用 receipt 绑定的迁移前备份，不在有未盘点新数据时盲目 `DROP`。如新表已有合法新事实，回退前须先停写并导出。

## 为何仍是 C

合成 dry-run 已证明字段/新表投影、Stable ID、故障原子性和备份回退可行，但它没有消除持久模型和 migration path 的实际变更。在获得明确真实库授权并完成 SQLite/PostgreSQL 双引擎备份、迁移、恢复和 Golden 验证前，不得降为 B/A，也不得合并 Candidate。

## 验证命令

```bash
scripts/upstream/候选迁移演练 --synthetic
scripts/recovery/RC恢复演练 --synthetic
cd web && bun test ../tests/film-rc/test_rc_surface.test.ts
python3 -m unittest tests/film-rc/test_rc_recovery.py -v
python3 -W error::ResourceWarning -m unittest discover -s tests/recovery-or-migration -v
```

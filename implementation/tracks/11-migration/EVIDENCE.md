# Track 11 证据

## Yingce 当前能力核查

- Backend 默认数据目录来自 `CANVAS_BACKEND_DATA_DIR`，SQLite 默认文件为 `open_ai_canvas.db`；开发规则要求显式使用忽略目录，不能把真实 `backend/data` 当测试库。
- `database.MigrateSchema`/启动期 `MigrateLegacyStorage` 会真实修改 schema/记录、写 marker、清理重复 payload 并 vacuum；虽有 SQLite backup，但不适合作为本轨只读 Preview。
- `migrate-sqlite-postgres` 以 SQLite 只读模式打开源、执行 `quick_check`、校验完整表清单、在 PostgreSQL 事务中逐表复制并逐字段核对，可复用验证思路，不能用于 fixture dry-run。
- Asset ZIP 支持结构和媒体打包，但没有逐文件 SHA-256/稳定 Film ID/版本/回滚计划，导入会直接写浏览器存储。
- Remote user-data sync 以服务端实体为真相并会上传/删除差异，不可用于只读迁移预演。
- LibTV/TapNow adapter 已有来源校验、跳过项和 warning，可复用 adapter 报告方式，但其节点 ID/批次不是 Film Core 正式身份。
- 真实系统 A/B 本轮未读取、未盘点，不能宣称已可迁移。

## 已实施

- `SandboxMigration` 默认关闭，运行根必须有 `.filmos-migration-sandbox`，source/output 必须位于该根内且拒绝 symlink。
- Inventory 逐文件记录相对路径、字节数、SHA-256 和 fixture 来源，并生成确定性 source hash。
- Dry-run manifest 要求 Film Core 预分配小写 UUIDv4、实体类型与版本；缺失、复用、空来源或未知 schema 会产生 blocker。
- Export 只复制到 sandbox package，写入不可覆盖；manifest 有独立 SHA-256 sidecar。
- Verify 核对 manifest hash、payload 文件集合、逐文件大小/SHA-256，并再次证明来源 hash 未变化。
- Manifest 内含 immutable-source backup 策略和恢复说明；工具不实现删除或 formal apply。

## 验证

- `cd film-core && python3 -m unittest discover -s app/imports/tests -v`：8 pass / 0 fail。
- `cd film-core && python3 -m compileall -q app/imports`：通过。
- `git diff --check`：通过。

## 边界

- 未打开 SQLite/PostgreSQL，未读取用户数据目录，未修改 Host、共享合同或真实项目。
- 未实现正式 apply/rollback 执行；共享要求见 `CR-11-001`。
- “fixture” 当前由默认关闭、无 CLI/注册入口、sandbox marker 与 origin allow-list 共同约束；它不是对任意目录内容的自动真实性判定。

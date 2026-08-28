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

## 首个 Dry-run 切片边界

- 该切片当时未打开 SQLite/PostgreSQL，未读取用户数据目录，未修改 Host、共享合同或真实项目。
- 未实现正式 apply/rollback 执行；共享要求见 `CR-11-001`。
- “fixture” 当前由默认关闭、无 CLI/注册入口、sandbox marker 与 origin allow-list 共同约束；它不是对任意目录内容的自动真实性判定。

## Beta 迁移/恢复切片（2026-08-28）

### 本地实施

- `scripts/migration/synthetic_migration.py` 只接受完整合成身份链：标记 sandbox、固定文件名 `synthetic.sqlite`、fixture sidecar、SQLite `application_id` 和库内 marker 必须同时匹配。源库用 `mode=ro&immutable=1` 打开，演练前后源文件 SHA-256 必须一致。
- 确定性迁移包包含每表 CSV、`load.psql`、SQLite 验证器 schema、`manifest.json` 和独立 manifest hash。`load.psql` 使用 `ON_ERROR_STOP`、单事务和 `\copy ... CSV HEADER NULL '\N'`，要求目标 schema 预先由 Backend `database.MigrateSchema` 创建。
- Manifest 记录表列/类型/PK/FK、拓扑加载顺序、精确行数、规范化行哈希与所有主键元组。当前 fixture 为 6 表/14 行，包含完整引用链和 `stable_film_id`，导入后逐项验证行数、FK、行哈希和稳定主键。
- 本地等价导入在 `BEGIN IMMEDIATE` 内运行；故障注入后所有业务表必须仍为 0 行。成功后写入确定性 receipt；同 key/同 manifest 只读重放且不重复导入，同 key/异 manifest 拒绝。
- 备份/恢复演练对目标和 receipt 重做行哈希/FK/稳定 ID 验证。回滚仅使用 receipt 绑定的导入前备份，备份哈希不符或目标已变更时拒绝，不删除源。
- `scripts/migration/迁移演练` 必须显式传入 `--synthetic`，每次仅在 `TemporaryDirectory` 中生成与演练，它不接受用户数据库路径。

### 验证证据

- `python3 -W error::ResourceWarning -m unittest discover -s tests/recovery-or-migration -v`：10 pass / 0 fail，包括默认关闭/路径隔离、确定性包、篡改、故障回滚、幂等、备份恢复、目标变更拒绝、成功回滚、异清单冲突和真实 PG 阻塞证明。
- `python3 scripts/migration/迁移演练 --synthetic`：`PASSED_LOCAL_EQUIVALENT`，包验证/故障原子回滚/幂等重放/备份恢复/导入前回滚全部通过，6 表/14 行，FK 和稳定主键保留。
- `python3 -m py_compile scripts/migration/synthetic_migration.py scripts/migration/迁移演练 tests/recovery-or-migration/test_synthetic_migration.py`：通过。

### 状态边界

- `PASSED_LOCAL_EQUIVALENT`：已证明合成 SQLite 盘点、PostgreSQL `psql` 兼容包、本地等价事务导入和恢复/回滚控制；这不等于已在真实 PostgreSQL 上执行。
- `BLOCKED_REAL_PG`：本机无 `psql`/`postgres` 可执行文件，Docker CLI 存在但 daemon socket 不可用，本轮严格未宣称真实 PG 通过。解除阻塞需要一个明确的临时 PostgreSQL DSN，在同一 schema 前置条件下执行 `load.psql` 并重做 row-count/FK/ID/hash/receipt 核对。
- 本轮所有数据库文件均在 `mktemp` 临时目录内合成；未查找、未打开、未复制、未迁移任何用户真实数据库。

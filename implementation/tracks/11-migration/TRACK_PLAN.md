# Track 11｜系统 A/B 迁移与知识抽取

TRACK: `11-migration`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：只读核查旧系统，以 Preview/DryRun/Hash/ID Mapping/回滚保留正式数据与知识。
2. 已核查：Yingce 数据目录、SQLite/PostgreSQL schema migration、storage migration、资产 ZIP、用户数据同步、LibTV/TapNow import 和测试边界；真实系统 A/B 未读取。
3. Fit-Gap：
   - REUSE：显式 `CANVAS_BACKEND_DATA_DIR`、SQLite 只读打开/quick_check、SQLite backup、全表覆盖核对、LibTV/TapNow adapter 的校验/跳过报告模式、fixture 使用 `t.TempDir` 的测试纪律。
   - EXTEND：稳定 ID Mapping、逐文件 SHA-256、来源/版本、dry-run manifest、sandbox export/verify、备份与恢复计划。
   - BUILD：系统 A/B 语义 Adapter、Film Core ImportPlan/Receipt、引用图核对、正式事务与恢复演练。
   - DEFER：任何真实项目/数据库读取与写入、垃圾清理、来源删除、正式 apply；见 `CR-11-001`。
4. 证据：见本轨 `EVIDENCE.md`。
5. 最小修改：默认关闭，只允许标记过的 fixture/临时 sandbox；不打开数据库。
6. 不做：不迁移历史垃圾/无引用中间件；不删原系统数据。
7. 影响：见 `FILE_OWNERSHIP.yaml#migration`。
8. 测试：sandbox containment、源哈希、幂等重放、ID Mapping、版本、篡改检测、回滚计划和来源不变。
9. 回滚：导入前备份 Sidecar；本阶段仅 DryRun无写入。
10. 依赖：Track 02、06、09、13。

STATUS: `FIRST_SLICE_IMPLEMENTED_PENDING_INTEGRATION`

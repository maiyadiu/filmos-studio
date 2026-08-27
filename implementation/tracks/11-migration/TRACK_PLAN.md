# Track 11｜系统 A/B 迁移与知识抽取

TRACK: `11-migration`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：只读核查旧系统，以 Preview/DryRun/Hash/ID Mapping/回滚保留正式数据与知识。
2. 待核查：系统 A/B 当前正式入口、状态、资产、规则、回执和哈希。
3. 已有能力：`UNVERIFIED`。
4. Fit-Gap：核查后记录。
5. 最小修改：只读 Adapter、MigrationPreview 和不写入 DryRun。
6. 不做：不迁移历史垃圾/无引用中间件；不删原系统数据。
7. 影响：见 `FILE_OWNERSHIP.yaml#migration`。
8. 测试：源哈希、幂等重放、ID Mapping、引用完整性、回滚计划。
9. 回滚：导入前备份 Sidecar；本阶段仅 DryRun无写入。
10. 依赖：Track 02、06、09、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


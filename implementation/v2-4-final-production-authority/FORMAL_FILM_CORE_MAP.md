# Film Core 正式权威图

```text
Preview
  → production trace（非 Candidate）
Broker authorization + Budget reservation
  → authorized submission
Provider completion
  → provider evidence
  → FormalService.import_production_result
  → GenerationPackage
  → GenerationAttemptEvidence
  → Candidate
Review / Approval（后续独立正式动作）
```

- API：`film-core/src/film_production_core/api.py` 的 `/generation-production/*`。
- 编排存储：`GenerationProductionStore`。
- 正式实体：`FormalService.import_production_result`。
- 数据迁移：schema 007 新增 production trace/authorization/provider evidence/formal binding 及 append-only 触发器。
- `generation_production_records` 只保留历史兼容读取；新 Generation/Candidate 权威写入被触发器拒绝。
- 生产实体 ID 为确定性 RFC UUIDv4 形态，兼顾幂等与正式数据库约束。
- Provider 完成只产生 Candidate，不会自动产生 Approval。

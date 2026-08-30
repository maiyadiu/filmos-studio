# 生产接线图

| 阶段 | 正式实现 | 权威证据 |
| --- | --- | --- |
| Brain 选择 | `selectEffectiveBrainProfile` + Browser Runtime 精确 Binding | Provider、Protocol、Model Capability Evidence；无内置 fallback |
| Reference | `GenerationReferenceBinding` + `hashGenerationReferences` | prepared representation、整数微单位权重、hard lock、连续 ordinal |
| 路线 | `selectEffectiveGenerationRoute` | explicit → node → project → global |
| Descriptor | Catalog exact selection | ID 精确命中、内容 Hash、Schema |
| Preview | `ProductionGenerationComposition.preview` | Descriptor Receipt、Prompt Receipt、Route Snapshot、Proposal/Preview Receipt |
| 持久化 | Film Core `generation_production_records` | SQLite 追加式表、禁止 UPDATE/DELETE、重启恢复 |
| 授权 | `approve` | Guard、Catalog Validation、Input Authorization、Budget Reservation、Broker Decision、Authorized Submission |
| 执行 | `generation_submit` → Production port → `FilmOSMockGenerationProvider` | Acceptance project only、同一 idempotency key、恰好一次、0 网络、0 费用 |
| 输出 | Candidate | `qc=pending`、`approval=not_approved`，Provider success 不越过 QC/Approved |
| 验收 | `production-generation-composition` | Reject、Approve、STALE、Restart、Trace 和 Film Core 实持久化 |

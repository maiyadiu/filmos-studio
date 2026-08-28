# Track 02 证据

## 核查证据

| 对象 | 真实位置 | 核查结论 |
| --- | --- | --- |
| Host 状态枚举 | `backend/internal/model/models.go` | Project/Unit/Asset/Workflow/Task 使用各自的单轴状态；Film 六轴不能塞回 Host `status`。 |
| Host 聚合 | `backend/internal/model/models_project.go` | Project/Unit/Shot/Asset/Workflow 已存在。Project 和 WorkflowInstance 有 revision；Unit/Shot/AssetVersion 无独立 revision。 |
| Host Task | `backend/internal/model/models_task.go` | 已有任务身份、Provider 回执、租约、状态、结果和审计所需时间；不应复制。 |
| Host schema | `backend/internal/database/schema.go` | `Models()` 是 Host 表唯一清单；Film Core 表不应加入该清单或 Host AutoMigrate。 |
| Project repository | `backend/internal/repository/repository.go` | Project revision 随 Unit/Canvas/Asset/Shot/Workflow 变更递增；项目删除会事务清理 Unit/Shot/Workflow 映射。 |
| Asset repository | `backend/internal/repository/repository.go` | Asset/Version/Representation/Shot reference 已有引用检查与事务；Film Core 只能引用 Host ID。 |
| Workflow repository | `backend/internal/repository/repository.go` | 步骤、下一步、Workflow revision、Project revision 和 Task 产物可原子提交。 |
| Project service | `backend/internal/service/project.go` | 所有权在 service 校验；ProjectUnit kind 当前只支持 chapter/episode，Film 扩展不能假装 Host 已支持其他 kind。 |
| Shot/Asset service | `backend/internal/service/project_shot.go`、`project_asset.go` | Shot 和 AssetVersion 的创建、映射、候选确认已是 Host 写路径。 |
| Workflow service | `backend/internal/service/project_workflow.go` | 只有成功 Host Task 能登记产物；Film Core V0 不跨过这一边界发起生成。 |
| Host tests | `backend/internal/service/project_delete_test.go`、`project_asset_folder_test.go`、`backend/internal/database/schema*_test.go` | 已验证删除事务、独立 Asset/Task 保留和 schema 约束；未见 Unit/Shot 乐观并发测试。 |
| Web API | `web/src/services/api/projects.ts` | 前端已消费 Host Project/Unit/Shot/Asset/Workflow DTO；Film Core 应使用独立生成 client，不改这些 DTO。 |
| Canvas Agent | `canvas-agent/src/schemas.ts` | `project_*` 工具复用 Host API；`canvas_apply_ops` 的 expectedRevision/stateHash 仅保护画布投影。 |

## 合同 V0 缺口与裁决（历史基线）

1. 原 `openapi.json` 没有 health 路径，且成功/冲突响应都是无约束 `object`，无法做跨 Track 合同测试。本轨改为由 FastAPI/Pydantic 实际导出。
2. 原 Command 强制客户端传 `target_id`，与“Film Core 生成 UUIDv4”冲突。V0 将创建命令限定为 `target_id=null` + `expected_version=0`，apply 时由 Core 生成 ID；更新命令必须传 UUIDv4 和当前版本。
3. 原合同声明 impacts/reviews/prompt/continuity，但本轨 V0 没有对应生产实现。V0 曾将这些 operation 标为 `planned`；阶段二已实际实现 reviews/prompt/continuity，仅 impacts 继续 planned，详见下方阶段二证据。
4. V0 只写 `FilmProjectExtension`、`ContentUnitExtension`、`ShotExtension` 的 Film 扩展字段；Host 标题、正文、媒体、任务与归属仍由 Yingce Host 权威提供。

## V0 实施证据（历史基线）

### 已实施

| 范围 | 文件 | 真实行为 |
| --- | --- | --- |
| Pydantic 合同 | `film-core/src/film_production_core/models.py` | UUID4、HostReferences、六状态轴、3 种扩展实体、创建/更新命令判别联合、精确响应。 |
| SQLite Sidecar | `database.py` | 独立路径、WAL、schema migration V1、Film UUIDv4/content hash/6 轴 CHECK、3 类 Host 映射部分唯一索引、Audit UPDATE/DELETE 禁止 trigger。 |
| 持久化 | `repository.py` | `BEGIN IMMEDIATE` 下的映射创建+审计、`WHERE version = expected_version` 更新+审计，冲突整事务回滚。 |
| 领域服务 | `service.py` | 由 Core 生成 UUIDv4；稳定 ID 不随版本变化；canonical JSON SHA-256；preview 零写入；apply 原子追加 AuditEvent。 |
| HTTP API | `api.py` | 真实实现 health、project context、Unit/Shot/Film entity read、command preview/apply、audit read；409 返回 expected/current version。 |
| 共享 OpenAPI | `film-contracts/openapi.json` | 从实际 FastAPI/Pydantic 导出；每个 operation 标记 `implemented` 或 `planned`，保留 V6.1 目标路径但不伪造可用性。 |

### 已实现的 HTTP 工具面

```text
GET  /health
GET  /projects/{hostProjectId}/context
GET  /units/{hostUnitId}
GET  /shots/{hostShotId}
GET  /entities/{filmEntityId}
POST /commands/preview
POST /commands/apply
GET  /audit-events
```

`POST /commands/apply` 支持：

- `entity.create`：`target_id` 必须显式为 `null`，`expected_version=0`，Core 生成 UUIDv4。
- `entity.set_states`：`target_id` 必须是已存在 UUIDv4，`expected_version` 必须与当前 Film version 一致。

### 数据库边界验证

使用临时 SQLite 文件实际初始化后查询 `sqlite_master` 和 WAL：

```json
{"host_table_overlap": [], "journal_mode": "wal", "tables": ["audit_events", "film_entities", "schema_migrations"], "triggers": ["audit_events_no_delete", "audit_events_no_update"]}
```

这证明 Sidecar 未创建/复制 `projects`、`project_units`、`shots`、`assets`、`tasks`、`workflow_instances` Host 表。

### 测试证据

执行：

```bash
cd film-core
/tmp/filmos-core-venv-02/bin/filmos-core-export-contracts
/tmp/filmos-core-venv-02/bin/pytest
/tmp/filmos-core-venv-02/bin/python -m compileall -q src tests
git diff --check
```

结果：

```text
10 passed
compileall: PASS
git diff --check: PASS
```

覆盖的核心不变量：health DB round-trip、preview 零写入、UUIDv4、Film ID 更新后不变、Host 映射唯一、六轴必填/枚举、content hash 随内容更改、过期 `expected_version` 409 且不覆盖/不增加审计、实体+审计原子写入、AuditEvent 数据库级禁止 update/delete、响应通过 `core.schema.json`、已提交 OpenAPI 与导出结果一致。

测试环境有 1 条 Starlette `TestClient` 对 httpx 的 deprecation warning，不影响测试结果，不在本轨扩大为测试客户端迁移。

### 合同/源码哈希

```text
openapi.json  aa526d9096be5b95b609ea1da5260270a84d7e979fe2499237cbfea2ef1815a0
core.schema   f2c0b99ef40db007be53c001b679a27445ef2cdfec898359bc2c2d39a690e5af
database.py   c8068bb991771fe017d4e60821336d2c3c597cb8c958bbb016c2040a9bff1c09
service.py    85438fc5cca3b4871456def5830e1d9f13799be95501cc8ff1a6c800109cd937
```

## 阶段二 Golden A Core 证据

### 合同与持久化

- Sidecar schema V2 新增通用 `formal_records` 与追加式 `formal_audit_events`；没有创建或修改 Host 核心表。
- `/formal-records` 可创建 unlocked ScriptVersion、DirectorUnit、CoverageLink、VisualLockSet、AssetBinding、GenerationPackage；`/script-versions/lock` 原子创建新 locked ScriptVersion 与 ScriptDecision；PromptDraft/Provenance、GenerationAttemptEvidence/Candidate 分别由领域 API 原子成对写入。
- 普通 ScriptVersion 不能直接声明 locked。Script Lock 只允许 human actor，以新的 Film UUIDv4 保存不可变 locked 版本并保留 source ID/text hash；DirectorUnit 同时校验 locked ScriptVersion guard 和指向其当前聚合 hash 的 ScriptDecision guard。Agent lock、过期 source guard、错配 decision 均 fail closed。
- 所有创建目标使用 `target_id=null + expected_version=0 + expected_content_hash=<64 位零哈希>`；所有来源引用使用当前 Film UUIDv4、`expected_version>=1` 与记录聚合 `expected_content_hash`。来源 version 或 hash 不一致返回 409，事务不产生部分记录或审计。
- DirectorUnit 同时保存 `director_ir_text` 与 `sha256(raw director_ir_text)`；VisualLockSet 同时保存 `visual_lock_text` 与 `sha256(raw visual_lock_text)`。`ref.content_hash` 始终是 canonical record body 聚合 hash，没有与裸内容 hash 混用。
- AssetBinding 同时保存正式记录聚合 hash 与 Host 资产版本/来源 `asset_content_hash`；正文仅含 opaque Host ID、role、priority、hash，不包含媒体、路径、URL 或二进制。
- `/prompts/compile` 实际查询 Project、Shot、DirectorUnit、VisualLockSet 和每个 AssetBinding，逐项校验聚合 guard、Host 映射及 raw/source hash；Provenance 同时固定这两层 hash。

### 候选、审查与人工批准

- GenerationPackage 固定 `submission_state=NOT_SUBMITTED`，Core 没有 Provider 网络提交、上传或积分调用代码。
- `/manual-results/import` 记录 provider/task/receipt/parameter/prompt/input hash、人工来源、授权证据与 Core 生成的 representation UUIDv4；外部结果只创建 `Candidate`，状态为 pending 而非 approved。
- 参数与人工导入元数据拒绝 secret/API key/token/Cookie/password/credential 字段，以及 data/blob/file URL、绝对路径和 HTTP(S) URL。
- `/reviews` 只创建独立 Review；`/approvals` 只允许 `actor_kind=human`，要求 passed Review 的 target 与 target hash 同时命中当前 Candidate。Approval 是独立 UUIDv4 记录，Candidate ID、output hash 与状态不被改写。
- `/continuity/check` 查询当前/前一 Shot 的 version+hash，持久化结构化 blocker；不把 UI gate 或 TODO 冒充检查结果。

### 实际 API 状态

```text
IMPLEMENTED (16)
GET  /health
GET  /projects/{hostProjectId}/context
GET  /units/{hostUnitId}
GET  /shots/{hostShotId}
GET  /entities/{filmEntityId}
GET  /formal-records/{filmEntityId}
POST /formal-records
POST /script-versions/lock
POST /prompts/compile
POST /manual-results/import
POST /reviews
POST /approvals
POST /continuity/check
POST /commands/preview
POST /commands/apply
GET  /audit-events

PLANNED (1)
GET  /impacts/{entityId}
```

`/entities/{id}` 仍只服务既有三类扩展；所有新增正式记录通过 `/formal-records/{id}` 读取。共享 OpenAPI 对每个 operation 标明 `x-implementation-state`。

### 阶段二验证

```bash
cd film-core
PYTHONPATH=src /tmp/filmos-core-venv-02/bin/python -m film_production_core.contracts
/tmp/filmos-core-venv-02/bin/pytest -q
python3 ../tests/film-contract/validate_contracts.py
/tmp/filmos-core-venv-02/bin/python -m compileall -q src tests
git diff --check
```

结果：Film Core `21 passed`；合同验证 `schema=0.2.0 paths=17 implemented=16 planned=1 axes=6`；compileall 与 diff check 均通过。Golden 专项覆盖 14 种正式记录的共享 JSON Schema 实例校验、Script Lock/Decision、双层 hash、错误 hash 零部分写入、人工批准边界、Manual Import 敏感材料拒绝、Continuity blocker 和正式审计 trigger。

```text
openapi.json      194448a55419d012d1ae303f5820aedfaedb2f197bb739c5c4d972b791188036
core.schema.json  508ce8a1b2a4a3c30b6b6214bfb19d877ffef5520a1bd0d08d7fcac67457eb66
database.py       30a72ce247c130ce6d5b80b97dff1dccdd6d638b8b51b11f19ba9fe84c0731f7
formal_service.py 064f4280151c25edea3493636e684d13deacdf588ab5cb97f1d6673f25bb63b6
```

阶段二实现提交稳定点：`dd9848ac`。

## Known gaps

- `GET /impacts/{entityId}`、ImpactEdge 写入和精准 STALE 传播仍为 planned；本阶段未建空表或伪路由。
- Sidecar 对已持久化 Film/Host 映射做 current version/hash 与 Host ID 一致性校验，但未通过 Host Bridge 在线确认 Host 对象仍存在、当前用户所有权或 Host 删除事件。
- Sidecar 本身未实现身份认证；`actor_kind=human` 需要本地桌面 Host/Agent Gateway 提供可信身份边界，不能直接暴露为公网批准接口。
- PromptTemplate/Provider capability 是输入快照，Core 当前只校验安全形状与哈希，不在线查询其他 Track 注册表；跨 Track 集成由阶段二集成分支验证。
- 未生成 TypeScript Client；OpenAPI 已提供生成输入，由消费 Track 在集成分支生成或绑定。
- 未运行 Yingce Host 全量 Go/Web/Canvas Agent 测试，因为本提交未修改这些路径；阶段二集成分支应运行全量与浏览器 Golden。

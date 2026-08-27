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

## 合同 V0 缺口与裁决

1. 原 `openapi.json` 没有 health 路径，且成功/冲突响应都是无约束 `object`，无法做跨 Track 合同测试。本轨改为由 FastAPI/Pydantic 实际导出。
2. 原 Command 强制客户端传 `target_id`，与“Film Core 生成 UUIDv4”冲突。V0 将创建命令限定为 `target_id=null` + `expected_version=0`，apply 时由 Core 生成 ID；更新命令必须传 UUIDv4 和当前版本。
3. 原合同声明 impacts/reviews/prompt/continuity，但本轨 V0 没有对应生产实现。为保留 V6.1 目标工具面，这些 operation 在 OpenAPI 中标为可机读 `x-implementation-state: planned`；Sidecar 不注册这些路由，不用 501 占位冒充实现。
4. V0 只写 `FilmProjectExtension`、`ContentUnitExtension`、`ShotExtension` 的 Film 扩展字段；Host 标题、正文、媒体、任务与归属仍由 Yingce Host 权威提供。

## 实施证据

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

## Known gaps

- `GET /impacts/{entityId}`、`POST /reviews`、`POST /prompts/compile`、`POST /continuity/check` 是 `planned` 目标合同，本次未实现且运行时不注册。
- ImpactEdge 写入、精准 STALE 传播、Review/Approval、PromptDraft、ScriptVersion、DirectorUnit 等业务语义留给后续切片/所有 Track。
- Sidecar 当前只验证 Host ID 形状和唯一映射，未通过 Host Bridge 在线确认 Host 对象存在、当前用户所有权或 Host 删除事件。
- V0 未实现身份验证/授权；预期由本地桌面 Host/Agent Gateway 在接入时提供可信 actor 与权限边界。
- 未生成 TypeScript Client；OpenAPI 已稳定提供生成输入，由消费 Track 在所有路径中生成。
- 未运行 Yingce Host 全量 Go/Web/Canvas Agent 测试，因本提交未修改这些路径；集成分支应由 Track 13 运行全量套件。

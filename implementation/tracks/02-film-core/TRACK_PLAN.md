# Track 02｜Film Core、共享合同与审计

TRACK: `02-film-core`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

## 1. 本轨目标

在 `film-core/` 建立不修改 Yingce Host 核心表的 SQLite Sidecar，交付 Film Core V0 最小可运行切片：稳定 UUIDv4、六状态轴、显式 Host 映射、`expected_version` 乐观并发、追加式 `AuditEvent`、真实 preview/apply 命令与只读上下文。

## 2. 已核查的真实源码、数据库、测试与 UI 合同

- 总令与边界：根 `AGENTS.md`、V6.1 全文、V6.2 全文。
- 共享合同：`film-contracts/README.md`、`film-contracts/稳定ID.md`、`film-contracts/schemas/core.schema.json`、`film-contracts/openapi.json`。
- Host Models：`backend/internal/model/models.go`、`models_project.go`、`models_task.go`。
- Host Schema：`backend/internal/database/schema.go`、`schema_test.go`、`schema_postgres_test.go`。
- Host Repository：`backend/internal/repository/repository.go` 中 Project/Unit/Canvas/Asset/Shot/Workflow/Task 读写、事务与删除路径。
- Host Service：`backend/internal/service/project.go`、`project_shot.go`、`project_asset.go`、`project_workflow.go`。
- Host Tests：`backend/internal/service/project_delete_test.go`、`project_asset_folder_test.go`，以及 schema 测试。
- Web API：`web/src/services/api/projects.ts` 中 Project/Unit/Shot/Asset/Workflow DTO 与路由。
- Canvas Agent：`canvas-agent/src/schemas.ts` 中 `project_*` 工具与 `canvas_apply_ops` 并发守卫。

详细证据和结论记录在同目录 `EVIDENCE.md`。

## 3. Host 已存在能力

- `Project` 是 Host 聚合根，具有所有权、状态和 `Revision`；Project 写路径会递增 revision。
- `ProjectUnit` 已有稳定 ID、`parentId`、kind、position、导入/重排，但没有独立 revision。
- `Shot`、`ShotAssetReference`、`Asset`、`AssetVersion`、`AssetRepresentation`、`ProjectAssetCandidate` 已是 Host 通用真值；不得在 Sidecar 重建它们的标题、媒体或任务数据。
- `WorkflowInstance` 有 `Revision`，步骤转移和成功 Task 产物登记为 Host 事务写路径。
- `Task` 已包含 Provider 请求、租约、恢复、取消、计费和产物字段；Film Core V0 不实现外部生成或第二套 Task。
- Canvas Agent 已有 `expectedRevision`/`expectedStateHash` 画布写入守卫；这是 Canvas 并发合同，不是 Film Core 正式实体版本。

## 4. Fit-Gap

| 结论 | 范围 |
| --- | --- |
| `REUSE` | Host Project/Unit/Shot/Asset/Workflow/Task 和现有 Web/Agent 工具面；只保存它们的显式 ID 引用。 |
| `EXTEND` | 以 `FilmProjectExtension`/`ContentUnitExtension`/`ShotExtension` 映射 Host；不对 Host 原表加列。 |
| `BUILD` | FastAPI + Pydantic + SQLite WAL Sidecar、schema migration、六轴状态、Film revision、命令 preview/apply、追加式审计、合同导出与不变量测试。 |
| `DEFER` | Host 存在性/所有权在线校验、不可逆迁移、外部生成、Review/Prompt/Continuity 业务实现、Impact/STALE 写入与传播算法、Remote/Hybrid 同步。 |

## 5. 本次最小修改范围

- `film-core/`：独立 Python 包、SQLite migration/repository/service/FastAPI、合同导出器、测试和运行文档。
- `film-contracts/openapi.json`：从实际 FastAPI/Pydantic 导出，增加 health、实体读取、审计读取和精确 command schema。
- `film-contracts/schemas/core.schema.json`：仅在实际响应无法通过时做最小修正，不删除其他 Track 已声明的领域对象。
- `implementation/tracks/02-film-core/`：计划与证据。

## 6. 明确不做

- 不修改 `backend/`、`web/`、`canvas-agent/` 或 Host DB/schema。
- 不复制 Host Project/ProjectUnit/Shot/Asset/Task 正文或媒体。
- 不调用 Provider，不创建生成 Task，不上传任何资产。
- 不实现其他 Track 所有的 Story/Director/Prompt/Asset/Agent/Remote 模块。
- 不执行不可逆数据迁移，不修改稳定 ID 规则。

## 7. 受影响文件与数据对象

- 文件：仅限第 5 节路径。
- Sidecar 表：`schema_migrations`、`film_entities`、`audit_events`。Impact/STALE 按 V0 收口留作 planned contract，本切片不建空表冒充实现。
- V0 可写对象：FilmProjectExtension、ContentUnitExtension、ShotExtension 的映射、六轴状态与 Film revision。
- V0 审计对象：每次 apply 在同一 SQLite 事务追加 AuditEvent。

## 8. 测试计划

- Pydantic/JSON Schema：UUIDv4、六轴必填与枚举、Host 映射必填、响应符合 `core.schema.json`。
- Repository/Service：preview 零写入、Film ID 创建后不变、映射唯一、`expected_version` 冲突不覆盖、审计与实体原子提交、审计表禁止 update/delete。
- API：health DB round-trip、context/read、preview/apply/409、audit read、OpenAPI 与已提交合同一致。

## 9. 回滚方式

停止 Film Core 进程/关闭 `film.production_core`，保留或移除明确的 Sidecar SQLite 文件即可。Host DB 和 Host 业务表从未改动，无 Host 回滚迁移。

## 10. 其他 Track 依赖

- Track 00：Host 版本/API 差异信号；本切片不越界修改 Host Bridge。
- Track 03/05/08：消费 Film Core OpenAPI 的 context/read/command 工具面。
- Track 13：继续扩展 Contract/Golden/Recovery 测试；本轨先提供最小不变量测试。

STATUS: `V0_IMPLEMENTED_LOCAL_VERIFIED`

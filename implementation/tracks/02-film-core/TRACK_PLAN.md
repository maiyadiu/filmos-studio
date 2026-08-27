# Track 02｜Film Core、合同与审计

TRACK: `02-film-core`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 本轨目标：建立隔离 Film Core 真值、OpenAPI/JSON Schema、版本写入、审计和 STALE。
2. 已核查：`backend/internal/model/models.go`、`models_project.go`、`models_task.go`、`database/schema.go`、`service/project.go`、`project_workflow.go`、`web/src/services/api/projects.ts`、`canvas-agent/src/schemas.ts`。
3. 已有能力：Project/Unit/Shot/Asset/Workflow/Task 与 revision；Canvas 写入已有 expectedRevision/stateHash。
4. Fit-Gap：`REUSE` Host 通用对象；`EXTEND` 显式 Host 映射；`BUILD` Film 语义、合同、审计、Impact/STALE；`DEFER` 不可逆迁移。
5. 最小修改：`film-core/`、`film-contracts/`、生成 Client 槽位。
6. 不做：不复制 Project/Shot/Asset/Task；不改 Host 核心表。
7. 数据对象：FilmProjectExtension、ContentUnitExtension、ScriptVersion、DirectorUnit、ShotExtension、PromptDraft、Review、Approval、AuditEvent、ImpactEdge。
8. 测试：JSON 合同、OpenAPI 路径、expected_version 冲突、审计追加、STALE 精准传播。
9. 回滚：关闭 `film.production_core`；隔离 Sidecar DB/目录，不触碰 Host DB。
10. 依赖：Track 00、13；向其他全部 Track 提供合同。

STATUS: `READY_TO_IMPLEMENT_V0`


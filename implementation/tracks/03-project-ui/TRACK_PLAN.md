# Track 03｜项目管理与动态 ContentUnit

TRACK: `03-project-ui`

MODEL: `GPT-5.6 Sol`

REASONING: `High`

STATUS: `FIRST_SLICE_COMPLETE_PENDING_INTEGRATION`

## 1. 本轨目标

在影策上游项目工作台之上建立 Film ContentUnit 的隔离投影层，复用现有项目单元列表、排序、导入、Shot 和 Canvas 链接，不另建 Project Hub，不固定集数，不重写虚拟列表。

## 2. 已核查的真实实现

- Host 数据：`backend/internal/model/models.go`、`models_project.go`。
- Host 请求链：`backend/internal/handler/project.go` → `service/project.go` / `project_shot.go` → `repository/repository.go`。
- 前端合同：`web/src/services/api/projects.ts`。
- 项目 UI：`web/src/pages/projects/detail.tsx` 与 `detail/` 下概览、章节、画布、资产、设置及相邻 helper。
- 工作台投影：`web/src/lib/project-workbench.ts`。
- 分镜链：`project-chapter-storyboard.ts` → 本地/远端画布创建或更新 → `linkCanvasUnit` → CanvasUnitLink。
- 共享 Film 合同：`film-contracts/schemas/core.schema.json` 中 ContentUnit kind 与六轴 FormalStateAxes。

证据与精确位置见同目录 `EVIDENCE.md`。

## 3. Host 已存在能力

- `ProjectUnit` 模型已有稳定 `id`、`parentId`、`kind`、`position`、单一 Host `status`。
- API 已有新增、整批导入、编辑、删除、全量重排和单元详情读取。
- 章节页已有搜索、虚拟列表、拖拽重排、指定位置移动、小说拆章和按需正文读取。
- `CanvasUnitLink` 已有 Project/Canvas/Unit 三元唯一关系与 role；章节分镜可写入新画布或已有画布。
- `Shot` 已按 `unitId` 关联，概览可从 Host 事实投影分镜覆盖。

## 4. 真实 Fit-Gap

| 能力 | 分类 | 裁决 |
| --- | --- | --- |
| Project 基础信息、项目详情与原工作台导航 | REUSE | 不新建 Project Hub。 |
| 单元列表、搜索、虚拟化、导入和排序 | REUSE | 第一切片不改章节页实现。 |
| Shot 与 CanvasUnitLink 关联 | REUSE | Film 投影只消费现有链接和 Shot，不建平行关系。 |
| Host `parentId/kind/position` 模型字段 | REUSE（模型）/ GAP（服务） | 模型真实存在；详情摘要漏选 `parent_id`，创建/更新 DTO 不接受 `parentId`，service 只允许 chapter/episode。不得写成动态种类已完成。 |
| Film ContentUnit kind 与六轴状态 adapter | BUILD | 在 `web/src/film/project/` 建立隔离合同形状、Host adapter 和可缺省的 sidecar 投影；不伪造缺失状态。 |
| 动态单元概览 | EXTEND | Feature Flag 打开时显示 Host 可证实统计及 Film 多轴接入覆盖；默认关闭。 |
| special/trailer/extra/film/season/arc/volume Host 写入 | DEFER | 需 Host owner 修改 service/API；见 `CR-03-001`。 |
| 层级新增/改父级 | DEFER | Host DTO 与摘要未贯通，需归属与环检测；见 `CR-03-001`。 |
| 拆分、合并、复制方案、归档 | DEFER | 缺少命令合同、引用迁移和回滚语义；本切片不做破坏性猜测。 |
| Script/DirectorUnit/关键帧/视频/SceneTwin 指标 | DEFER | 当前 ProjectDetail 和已合入 Film API 不提供相应事实；概览不得显示伪造百分比。 |

## 5. 第一切片修改范围

- `web/src/film/project/`：Film ContentUnit kinds、六轴状态、Host adapter、排序/链接/默认生产画布解析、概览投影和 Feature Flag。
- `web/src/pages/projects/detail/overview.tsx`：增加一个由 `film.dynamic_content_units` 控制、默认关闭的只读概览入口。
- 本目录：计划、证据和专项测试记录。
- `implementation/CHANGE_REQUESTS/`：Host 合同缺口 RFC；不直接修改非本轨 Host 文件。

## 6. 明确不做

- 不新建 Project Hub；不固定 60 集。
- 不重写章节虚拟列表、小说导入、重排或 CanvasUnitLink。
- 不修改 backend、`web/src/services/api/projects.ts`、共享 Film 合同或其他 Track 目录。
- 不把 Host `status` 映射成六轴正式状态，不把“没有数据”写成 0% 完成。
- 不实现未定义引用迁移语义的拆分/合并。

## 7. 数据与边界

- Host 继续权威持有 ProjectUnit 基础字段、Shot、Canvas 和 CanvasUnitLink。
- Film adapter 接受共享合同形状的 ContentUnitExtension；缺失 sidecar 时 `states = null`。
- 同一 Host 单元出现多个扩展版本时按最高 `ref.version` 投影；项目 ID 或 Host unit ID 不匹配的扩展不绑定。
- 默认生产画布只做确定性导航选择：`production` role 优先，其次 `storyboard`，再按画布更新时间和稳定 ID 选择一个；不写回关系。

## 8. 测试结果

- Host 单元按 position / createdAt / id 稳定排序，未知 kind 不被伪装。
- sidecar kind 与六轴状态正确投影，错误项目/错误 Host 引用被忽略，最高版本胜出。
- Canvas 链接去重，默认生产画布唯一且优先级确定。
- 概览仅统计可证实的动态种类、分镜/画布覆盖与六轴接入；缺 sidecar 时明确 unavailable。
- Feature Flag 默认关闭，仅接受显式 true/1/on/yes。
- `bun test ./src/film/project/project-adapter.test.ts`：6 pass / 0 fail。
- `bun run typecheck`：通过。
- `bun run build`：通过；仅出现既有的 Vite 大 chunk 警告。
- 未启动 dev server，未把静态构建写成浏览器 UI 验收；明暗主题和实际路由显示留给 Track 13 / integration。

## 9. 回滚

- 构建/部署时关闭 `film.dynamic_content_units`（当前 Web 映射为 `VITE_FILM_DYNAMIC_CONTENT_UNITS`）即可恢复原项目概览。
- 删除隔离的 `web/src/film/project/` 接线和概览条件块，不涉及 Host 数据迁移。

## 10. 依赖

- Track 02：共享 ContentUnitExtension / FormalStateAxes 合同；本切片只消费已合入 V0 形状，不依赖未合入实现。
- Track 05：未来提供 Production Canvas role/默认关系的正式写合同；当前仅只读解析 Host 链接。
- Track 13：后续 Golden 与 UI 浏览器验收。
- Program Integrator / Host owner：处理 `CR-03-001` 后才能开放完整动态种类和 parentId 写路径。

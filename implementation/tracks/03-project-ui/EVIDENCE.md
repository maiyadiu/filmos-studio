# Track 03 证据

观测时间：`2026-08-28T02:50:28+08:00`

基线：`f3a1bc92`

状态定义：`VERIFIED` 仅表示源码事实已核查，不表示 Film 动态 ContentUnit 已完成。

| ID | 来源 | 方法 | 发现 | 状态 |
| --- | --- | --- | --- | --- |
| T03-E01 | `backend/internal/model/models_project.go:184` | 源码阅读 | ProjectUnit 模型已有 `ParentID`、`Kind`、`Position`。 | VERIFIED |
| T03-E02 | `backend/internal/model/models.go:138` | 源码阅读 | Host 枚举仅声明 chapter/episode；单一 status 仅 draft/ready/completed。 | VERIFIED |
| T03-E03 | `backend/internal/service/project.go:414` | 源码阅读 | `newProjectUnit` 明确拒绝 chapter/episode 以外 kind；Create DTO 无 parentId。 | VERIFIED |
| T03-E04 | `backend/internal/repository/repository.go:1151` | 源码阅读 | 项目详情使用的摘要 SELECT 未读取 `parent_id`，但排序复用 `position asc, created_at asc`。 | VERIFIED |
| T03-E05 | `web/src/services/api/projects.ts:38` | 源码阅读 | ProjectUnit 前端类型没有 parentId；CRUD/导入/排序/Canvas link 客户端已存在。 | VERIFIED |
| T03-E06 | `web/src/pages/projects/detail/chapters.tsx:101` | 源码阅读 | 已有稳定顺序投影、搜索、虚拟列表、拖拽、指定位置移动和小说导入；无需重写。 | VERIFIED |
| T03-E07 | `web/src/lib/canvas/project-chapter-storyboard.ts:10` | 源码阅读 | Shot 按 unitId 投影为 Storyboard rows；更新时保留现有行状态并清理失效托管连接。 | VERIFIED |
| T03-E08 | `web/src/pages/projects/detail/chapters.tsx:280` | 源码阅读 | 分镜可写入现有/新画布，之后复用 `linkCanvasUnit(..., role=storyboard)` 建立关系。 | VERIFIED |
| T03-E09 | `backend/internal/service/project.go:462` | 源码阅读 | CanvasUnitLink 写入校验用户项目、画布和单元归属，并为项目 revision 加一。 | VERIFIED |
| T03-E10 | `film-contracts/schemas/core.schema.json:40` | 合同阅读 | 正式状态必须分 creative/execution/review/lock/delivery/stale 六轴。 | VERIFIED |
| T03-E11 | `film-contracts/schemas/core.schema.json:72` | 合同阅读 | ContentUnitExtension kind 为 chapter/episode/special/trailer/extra/film/season/arc/volume。 | VERIFIED |
| T03-E12 | `implementation/FEATURE_FLAGS.yaml` | 配置阅读 | `film.dynamic_content_units` 默认 false，关闭时必须保留原影策流程。 | VERIFIED |
| T03-E13 | `web/src/film/project/project-adapter.test.ts` | `bun test ./src/film/project/project-adapter.test.ts` | Host 稳定排序、sidecar 版本/项目绑定、未知 kind、Canvas 链接去重、唯一默认生产画布、概览事实与默认关闭 flag：6 pass / 0 fail。 | PASSED |
| T03-E14 | `web/` | `bun run typecheck` | TypeScript 无错误。 | PASSED |
| T03-E15 | `web/` | `bun run build` | Canvas bridge、TypeScript 与 Vite production build 通过；仅有既有的大 chunk 警告。 | PASSED |

## 调用链

```text
项目详情 GET /projects/:id
  -> handler.RegisterProjectRoutes
  -> Service.ProjectDetail
  -> ProjectUnitSummaries + ProjectShots + ProjectCanvasUnitLinks
  -> web getProject
  -> detail.tsx / overview.tsx / chapters.tsx

章节历史 Shot
  -> upsertProjectChapterStoryboard
  -> 本地画布更新或 createCanvasProjectWithRemoteSync
  -> POST /projects/:id/canvas-links
  -> Service.LinkCanvasUnit
  -> Repository.UpsertCanvasUnitLink
```

## 尚未验证

- 默认关闭和显式开启的 UI 浏览器验证由集成/QA Track 继续执行；本轨不自行启动 dev server。

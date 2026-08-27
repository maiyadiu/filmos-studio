# Track 06｜Asset Studio、Local Media 与 VisualLock

TRACK: `06-assets`
MODEL: `GPT-5.6 Sol`
REASONING: `XHigh`
STATUS: `FIRST_SLICE_TESTED_AWAITING_INTEGRATION`

## 1. 本轨目标

在 Yingce Upstream 已有 `Asset / AssetVersion / AssetRepresentation / Resource / ShotAssetReference` 之上，建立 FilmOS 的影视语义投影、Binding Purpose、候选/批准隔离、媒体来源与授权证据、VisualLock hash 和精准 STALE 计算。Host 继续唯一持有通用资产与媒体记录，本轨不复制 Host 表或媒体对象。

需求编号：`ASSET-001`（Host 资产投影）、`ASSET-002`（用途绑定）、`ASSET-003`（候选/批准）、`MEDIA-001`（内容寻址与来源）、`LOCK-001`（VisualLock）、`LOCK-002`（精准 STALE）。

## 2. 核查过的真实源码、数据、测试与 UI

- `backend/internal/model/models_project.go`：`Resource`、`Asset`、`ProjectAssetLink`、`ProjectAssetFolder`、`ProjectAssetCandidate`、`AssetVersion`、`AssetRepresentation`、`VoiceProfile`、`CharacterVoiceBinding`、`StyleProfile`、`ShotAssetReference`。
- `backend/internal/model/models.go`：资产分类和 `draft / review / confirmed / archived` 版本状态。
- `backend/internal/service/project_asset.go`、`backend/internal/repository/repository.go`：项目资产关联、版本、候选确认、Shot 用途统计与事务边界。
- `backend/internal/service/project_character.go`、`backend/internal/repository/project_character.go`：角色表现、声音绑定和保留历史的新版本写入。
- `backend/internal/service/project_shot.go`：Shot 只接受 Host 既有的六类粗粒度用途，且按项目校验 AssetVersion。
- `backend/internal/service/resource_delete.go`、`backend/internal/repository/resource_reference.go`、相邻删除测试：删除前扫描项目、画布、风格、任务、表现和直接引用；数据库提交后通过 outbox 清理物理对象。
- `web/src/pages/projects/detail/assets.tsx`、`web/src/services/api/projects.ts`：现有项目资产页、分类/文件夹/版本/候选/角色图片和声音绑定 UI/API。
- `web/src/stores/use-asset-store.ts`、`web/src/lib/asset-storage-revision.ts`、`web/src/services/project-asset-sync.ts`：用户 scope 的 localforage 持久化、revision/tombstone 合并、Host 项目关联。
- `web/src/services/resource-blob-cache.ts`：按 `userScope + resourceId` 隔离的有界 LRU 媒体缓存。
- `web/src/lib/canvas/style-profile.ts` 与相邻测试：项目保存 StyleProfile 快照，风格资产保留 license/source 信息。

本轨开始前 `git status --short` 为空；主工作树同样为空。

## 3. 影策上游已存在能力

- 通用 Asset 身份、版本、表现资源、项目链接、项目候选和 Shot 版本引用均已存在。
- 角色设定、图片表现和声音绑定通过新 AssetVersion 留存历史，不需要第二套角色资产表。
- 项目资产解除引用会阻止仍被角色画布或 Shot 使用的资产；资源物理删除已有引用扫描与可恢复 outbox 边界。
- StyleProfile 已使用项目快照，适合作为 VisualLock 的一个上游组成，而非由 FilmOS 复制。
- 浏览器缓存已有用户隔离、容量上限、LRU 与稳定 Resource ID；缓存是可再生副本，不是正式事实源。

## 4. Fit-Gap

- `REUSE`：Host Asset/AssetVersion/Representation/Resource/ShotAssetReference、项目资产页、角色版本、StyleProfileSnapshot、资源删除保护、用户隔离缓存。
- `EXTEND`：用 Film 隔离投影补齐角色/场景/道具/服化/声音语义和完整 Binding Purpose；只保存 Host ID、版本与 hash。
- `BUILD`：默认关闭的纯领域首切片，包含候选创建、显式审查批准、expected_version、防越权批准、来源/授权检查、VisualLock 规范化 hash、按依赖键精准 STALE、审计事件输出。
- `DEFER`：Sidecar 持久化/API、桌面 Managed Copy 与安全书签、文件监听、UI 接线、ImpactGraph 正式写入及 VisualLock 审批工作流；待 Track 01/02 的运行合同集成，不在本轨修改共享合同。

## 5. 本次最小修改范围

- `web/src/film/assets/**`：存储无关、无副作用、默认关闭的资产语义投影与单元测试。
- `implementation/tracks/06-assets/TRACK_PLAN.md`、`EVIDENCE.md`：证据、边界、测试和回滚记录。

## 6. 明确不做

- 不修改 Host 表、`film-contracts/**`、Film Core 共享运行时或其他 Track 文件。
- 不上传、复制、删除或迁移任何媒体，不调用 Provider，不外部生成，不消费积分。
- 不把绝对路径、URL、Cookie、Key 或凭据写入业务投影。
- 不把 Candidate 自动提升为 Approved；批准必须有 review、actor、expected_version 和授权/内容完整性证据。
- 不接管 Host `confirmed` 状态；Host 通用状态不等同 Film 审批状态。

## 7. 受影响文件与数据对象

受影响文件只在本轨所有权内。新增投影只引用：`host_project_id`、`host_asset_id`、`host_asset_version_id`、可选 `host_resource_id` 和 `content_hash`；不创建 Host 资产副本，不改变用户数据。

## 8. 测试计划

- Binding Purpose 与影视语义校验。
- SHA-256 格式、来源定位器和授权边界。
- Feature Flag 默认关闭。
- Candidate 与 Approved 不可混同；审批要求 QC/review、expected_version，且不原地改写候选。
- VisualLock 稳定 canonical hash（键序不影响）与组件变化检测。
- 只有声明依赖发生变化的消费者进入精准 STALE。
- 投影序列化不出现绝对路径或媒体 payload。

最小命令：`cd web && bun test src/film/assets/asset-layer.test.ts`，再执行 `bun x tsc --noEmit` 验证全量类型边界（若耗时或上游基线失败，将如实分开记录）。

## 9. Feature Flag 与回滚

Feature Flag：`film.asset_lock`，总控默认值已是 `false`。本切片的入口还要求调用方显式传入 `enabled: true`；未接线时不会改变 Yingce Upstream 行为。

回滚：关闭 `film.asset_lock` 即停用；删除本轨新增隔离目录即可完整回到 Host 原流程。没有数据库迁移、媒体复制或 Host 表变化。

## 10. 与其他 Track 的依赖

- Track 01：提供 Managed Copy 对象 ID、Linked External File 安全书签 ID 与外链状态观察，Film 对象不接收绝对路径。
- Track 02：未来持久化 Film AssetBinding/VisualLock/Audit/Impact；本轨不自行修改共享合同。
- Track 05/09：提供 Shot/Director/SceneTwin/Camera/Blocking/Composition 版本引用。
- Track 13：将本轨单测纳入 Golden B/C 和恢复测试。

当前无共享合同修改请求；若集成要求新增 OpenAPI/Schema，将通过 `implementation/CHANGE_REQUESTS/` 交由 Program Integrator 与 Track 02 裁决。

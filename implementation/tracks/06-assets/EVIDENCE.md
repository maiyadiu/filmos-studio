# Track 06 证据

## 状态

`FIRST_SLICE_TESTED_AWAITING_INTEGRATION`

本轨已完成资产语义与 VisualLock 的存储无关首切片；尚未接入 UI、Film Core 持久化或 Golden，因此不得表述为 FilmOS Asset Studio 已完成，也不得表述为用户资产已迁移或已批准。

## 核查证据

| ID        | 事实                                                                                                                                               | 位置                                                                                                         | 裁决                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| TR06-E001 | Host 已有 `Resource / Asset / ProjectAssetLink / ProjectAssetCandidate / AssetVersion / AssetRepresentation / StyleProfile / ShotAssetReference`。 | `backend/internal/model/models_project.go:7,52,65,88,102,114,168,218`                                        | `REUSE`，不复制 Host 表。                      |
| TR06-E002 | 项目资产已有链接、解除引用保护、草稿版本和候选确认路径；Host `confirmed` 是通用状态，不是 Film QC/Approval。                                       | `backend/internal/service/project_asset.go:96,159,264,311`                                                   | `REUSE + EXTEND`，Film 审批保持独立。          |
| TR06-E003 | 角色图片、声音或设定变化通过新 AssetVersion 保存，历史表现和声音引用被复制到新版本。                                                               | `backend/internal/service/project_character.go:352`                                                          | `REUSE` 角色资产版本；不建第二套角色表。       |
| TR06-E004 | Shot 会校验项目内 AssetVersion，但 Host 用途只有 `reference/start_frame/end_frame/keyframe/storyboard/output`。                                    | `backend/internal/service/project_shot.go:128,198`                                                           | `EXTEND` 完整影视 Binding Purpose。            |
| TR06-E005 | 资产删除先收集资源引用，数据库事务提交后再通过删除任务清理物理对象。                                                                               | `backend/internal/service/resource_delete.go:22`、`backend/internal/repository/resource_reference.go:82,230` | `REUSE` 删除保护；本轨不改删除路径。           |
| TR06-E006 | StyleProfile 已形成项目快照；资源缓存按用户 scope 和 Resource ID 隔离并有 2 GiB 上限。                                                             | `web/src/lib/canvas/style-profile.ts:35`、`web/src/services/resource-blob-cache.ts:24,150-157`               | `REUSE` 快照和可再生缓存；缓存不作为正式来源。 |

## 已实施

- `web/src/film/assets/asset-layer.ts`
  - 默认关闭：调用必须显式传入 `enabled: true`，并与总控 `film.asset_lock: false` 一致。
  - 只投影 Host Asset/Version/Representation/Resource ID 与小写 SHA-256，不复制媒体 payload 或 Host 资产表。
  - 覆盖角色、场景、道具、服化、声音、风格、建筑、灯光和运动语义，以及 V6.1 的 13 类 Binding Purpose。
  - `CandidateAssetBinding` 与 `ApprovedAssetBinding` 是不同对象；批准需要新 ID、`expected_version`、Review、QC pass、actor、授权和媒体 hash 完整性。
  - Managed Copy、Linked External、Host Resource 与 Regenerable Cache 只保存不含路径/URL的稳定定位器；缓存不能作为唯一 Approved 来源。
  - 输出冻结的审计事件，由 Track 02 未来负责追加持久化；本轨没有假称已建立审计数据库。
  - VisualLock 覆盖 Style/Architecture/SceneTwin/Character/Costume/Prop/Lighting/Camera/Blocking/Composition/Continuity/ReferenceRoleMap，使用 canonical SHA-256。
  - 集成复核补强：VisualLock、组件实体/版本、Review、QC 与下游消费者只接受 Film Core UUIDv4；Host 引用必须是无路径分隔符/URL 的 opaque ID，Film target 与 Host target 分别校验。
  - 同时生成组件级与叶子级 dependency hash，只有声明依赖命中的消费者进入 STALE。
- `web/src/film/assets/asset-layer.test.ts`
  - 运行验证默认关闭、稳定引用、路径/URL剥离、Host Resource 一致性、Candidate/Approved、审批门禁、稳定 hash、精准 STALE 和非 Approved 锁拒绝。

首切片内容 hash：

- `asset-layer.ts`：`sha256:9a8de04f0d64e72b3e3ce5df32c27b7b6e9bdca1e95dc6a4c96a6cb0882c4278`
- `asset-layer.test.ts`：`sha256:a6cae8ae8462f7bc0e825dcae073a551f92b5d013bd1a72b8b7572b725c52ca7`

## 验证结果

| 命令                                                                                                                       | 结果                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cd web && bun test src/film/assets/asset-layer.test.ts`                                                                   | `10 pass / 0 fail`。                                                                               |
| `cd web && bun x tsc --noEmit`                                                                                             | 通过，无 TypeScript 错误。                                                                         |
| `cd backend && GOPROXY=https://goproxy.cn,direct go test ./internal/service -run 'Asset\|Resource\|StyleProfile' -count=1` | 通过，`ok infinite-canvas/backend/internal/service`。仅验证相邻 Host 基线，本轨未改 Host Go 代码。 |
| `git diff --check`                                                                                                         | 通过。                                                                                             |
| 主工作树 `git status --short`                                                                                              | 空；本轨没有污染主工作树。                                                                         |

测试使用现有依赖缓存；未启动 dev server，未访问用户项目数据，未上传或生成媒体，未调用 Provider，未消费积分。

## 未实施与风险

- `DEFER`：Sidecar 表、OpenAPI、AuditEvent/ImpactGraph 正式持久化。共享合同归 Track 02，本轨未越权修改。
- `DEFER`：Managed Copy、外链安全书签与文件监听。依赖 Track 01 桌面 Workspace 合同。
- `DEFER`：Asset Studio UI 与 Host API 接线。Feature Flag 仍关闭，当前代码没有运行时入口。
- `DEFER`：VisualLock 审批工作流、跨 Shot Continuity、Golden B/C 与恢复测试。
- 当前 `not_required` 授权状态只允许在提供明确原因时通过纯领域门禁；正式写入时仍应由权限/审计策略裁决。

## 回滚

关闭 `film.asset_lock` 即保持现有 Yingce Upstream 流程。若需代码级回滚，只移除 `web/src/film/assets/**` 与本轨证据文件；没有数据库迁移、Host 表变化、媒体复制或用户数据变更。

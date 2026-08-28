# Track 06 证据

## 状态

`THIRD_STAGE_READONLY_SLICE_TESTED`

本轨已完成资产语义、VisualLock、默认关闭 Host 只读投影、本地媒体安全检查与 Golden B 本地 fixture 首切片；尚未接入 Host 通用版本详情 API 或 Film Core 持久化，因此不得表述为 FilmOS Asset Studio 已完成，也不得表述为用户资产已迁移或已批准。

## 核查证据

| ID        | 事实                                                                                                                                                    | 位置                                                                                                         | 裁决                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| TR06-E001 | Host 已有 `Resource / Asset / ProjectAssetLink / ProjectAssetCandidate / AssetVersion / AssetRepresentation / StyleProfile / ShotAssetReference`。      | `backend/internal/model/models_project.go:7,52,65,88,102,114,168,218`                                        | `REUSE`，不复制 Host 表。                                          |
| TR06-E002 | 项目资产已有链接、解除引用保护、草稿版本和候选确认路径；Host `confirmed` 是通用状态，不是 Film QC/Approval。                                            | `backend/internal/service/project_asset.go:96,159,264,311`                                                   | `REUSE + EXTEND`，Film 审批保持独立。                              |
| TR06-E003 | 角色图片、声音或设定变化通过新 AssetVersion 保存，历史表现和声音引用被复制到新版本。                                                                    | `backend/internal/service/project_character.go:352`                                                          | `REUSE` 角色资产版本；不建第二套角色表。                           |
| TR06-E004 | Shot 会校验项目内 AssetVersion，但 Host 用途只有 `reference/start_frame/end_frame/keyframe/storyboard/output`。                                         | `backend/internal/service/project_shot.go:128,198`                                                           | `EXTEND` 完整影视 Binding Purpose。                                |
| TR06-E005 | 资产删除先收集资源引用，数据库事务提交后再通过删除任务清理物理对象。                                                                                    | `backend/internal/service/resource_delete.go:22`、`backend/internal/repository/resource_reference.go:82,230` | `REUSE` 删除保护；本轨不改删除路径。                               |
| TR06-E006 | StyleProfile 已形成项目快照；资源缓存按用户 scope 和 Resource ID 隔离并有 2 GiB 上限。                                                                  | `web/src/lib/canvas/style-profile.ts:35`、`web/src/services/resource-blob-cache.ts:24,150-157`               | `REUSE` 快照和可再生缓存；缓存不作为正式来源。                     |
| TR06-E007 | 当前 `ProjectDetail.assets` 只含 Asset ID、primaryVersionId、versionCount、storageKey；完整 content hash/通用 representation metadata/授权/来源未返回。 | `web/src/services/api/projects.ts:50-64,181-191`                                                             | `EXTEND + DEFER`：只展示已知事实，缺口不补造，等待 Host 详情 API。 |
| TR06-E008 | 角色摘要已返回 AssetVersion ID/number 与 Representation ID/Resource ID/mediaType/role，可安全复用为部分只读投影。                                       | `web/src/services/api/projects.ts:77-105`                                                                    | `REUSE`，不新增请求。                                              |

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
- `web/src/film/assets/host-inventory.ts`、`host-inventory-panel.tsx`
  - 独立 `VITE_FILM_HOST_ASSET_READONLY` 只接受显式 `true`；关闭时在读取 detail 前返回 `null`，无 DOM/请求。
  - 完整 fixture 展示 Asset/AssetVersion/AssetRepresentation/Resource opaque ID、version/content hash、representation metadata、授权和来源。
  - 当前真实 `ProjectDetail` 只投影已知 Host 字段，缺少的 hash/metadata/authorization/provenance 明确标为事实缺口。
  - Host `confirmed` 与 Film `Approved` 分离；Candidate/Approved 用途 binding 使用不同数组，绑定仍携带 version ID 与 source hash。
- `web/src/film/assets/local-media.node.ts`
  - 仅 Node 本地 adapter 使用；`realpath` 后验证 canonical workspace containment，拒绝 `..` 和 symlink escape。
  - 只读计算 SHA-256，输出 workspace-relative canonical path；拒绝 URL/data URL、secret/locator metadata 与 hash drift，不上传、不复制、不删除媒体。
- `web/src/film/assets/fixtures/golden-b.json`、`golden-b.node.ts`
  - 可重放本地四层 Host fixture；回执固定 `prepared=true`、`persisted=false`、`externalProviderCalls=0`、`hostOwnsMedia=true`。
- `web/src/pages/projects/detail/assets.tsx`
  - 仅增加只读入口组件；既有角色、素材、版本、下载和写路径未改。

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

第三阶段验证：

| 命令                                                                                                                                                                                   | 结果                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cd web && bun test src/film/assets/asset-layer.test.ts src/film/assets/host-inventory.test.ts src/film/assets/host-inventory-panel.test.tsx src/film/assets/local-media.node.test.ts` | `21 pass / 0 fail`。首轮唯一失败为 camelCase `sourceUrl` 未命中 locator key，修复后全绿。 |
| `cd web && bun src/film/assets/golden-b.node.ts`                                                                                                                                       | `PASSED_LOCAL_FIXTURE`；`prepared=true`、`persisted=false`、外部调用 0。                  |
| `cd web && bun run typecheck`                                                                                                                                                          | 通过。                                                                                    |
| `cd web && bun run build`                                                                                                                                                              | 通过；仅既有 Vite 大 chunk 警告。                                                         |

测试使用现有依赖缓存；未启动 dev server，未访问用户项目数据，未上传或生成媒体，未调用 Provider，未消费积分。

## 未实施与风险

- `DEFER`：Sidecar 表、OpenAPI、AuditEvent/ImpactGraph 正式持久化。共享合同归 Track 02，本轨未越权修改。
- `DEFER`：Managed Copy、外链安全书签与文件监听。依赖 Track 01 桌面 Workspace 合同。
- `DEFER`：Host 通用 AssetVersion/Representation/Resource 详情读取 API；当前 ProjectDetail 的部分投影不会伪造缺失字段。
- `DEFER`：VisualLock 审批工作流、跨 Shot Continuity、Golden B 真 Core 纵向持久化与恢复测试；本批仅本地可重放 fixture。
- 当前 `not_required` 授权状态只允许在提供明确原因时通过纯领域门禁；正式写入时仍应由权限/审计策略裁决。

## 回滚

关闭 `VITE_FILM_HOST_ASSET_READONLY` 后页面不产生第三阶段 Film DOM/请求，既有 Yingce 资产流程保持原样；关闭 `film.asset_lock` 停用原领域门禁。若需代码级回滚，移除本批 `host-inventory*`、`local-media.node*`、Golden B fixture/adapter 与 `assets.tsx` 单行入口即可；没有数据库迁移、Host 表变化、媒体复制或用户数据变更。

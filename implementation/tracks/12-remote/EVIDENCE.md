# Track 12 证据

## 交付状态

`LOCAL_HOST_UI_AND_RECEIPT_WIRED_REMOTE_EXECUTION_DEFERRED`

本轨已将纯本地 Preview / Manifest 接入 Host 项目概览，增加 Human 二次确认、manifest version/hash guard、
用户/项目隔离的 localforage 会话、幂等本地回执和恢复重算。仍无 Host HTTP/API 或后端接线，没有执行网络请求、
远端发布、资源上传、代理生成、远端任务或积分消费。

## 现状核查

| 对象 | 代码证据 | 判定 |
| --- | --- | --- |
| User Data 登录同步 | `web/src/services/user-data-sync.ts:24-51` | 登录后远端快照替换浏览器项目/资产，是 Remote-first 恢复语义，不等于 Film Local Authority。 |
| User Data 自动保存 | `web/src/services/user-data-sync.ts:53-62,167-199` | Store 变化会调度批量 upsert/delete，缺少 Film version/hash 冲突合同。 |
| 本地媒体处理 | `web/src/services/user-data-sync.ts:201-267` | 本地 `storageKey` 与 data URL 会调用资源上传；禁止直接复用于 Film 选择性发布。 |
| User Data API | `web/src/services/api/user-data.ts:20-53` | 可复用 Host 资产/画布 opaque ID 和未来传输入口；当前 API 仅按 Host ID upsert/delete。 |
| 后端 User Data | `backend/internal/service/user_data.go:62-100,189-228,264-300` | 已有用户归属、配额和 JSON 存储；尚无 Film UUID/version/hash 的正式冲突协议。 |
| Resource / Task | `backend/internal/model/models_project.go:7-28`、`backend/internal/model/models_task.go:5-47` | 已有资源与远端任务载体；本切片不调用、不创建。 |
| Canvas Share | `backend/internal/service/canvas_share.go:20-35,62-128,270-298` | 已有 token 化只读分享与资源白名单，但没有 Film 发布选择、冲突或本地批准语义。 |
| Agent Workspace | `canvas-agent/src/config.ts:38,126-143` | 现有 workspace 是本机路径配置，不是 Remote Film Workspace。 |
| 部署协调 | `docker-compose.deploy.yml:1-60` | PostgreSQL/Redis 可作为未来持久与协调层；本切片没有启动服务。 |
| Feature flag | `implementation/FEATURE_FLAGS.yaml` | `film.remote_sync` 当前为 `false`，首切片保持默认关闭。 |

## 本轨文件

- `web/src/film/sync/authority.ts`：三种 Authority Mode、默认关闭策略、网络/隐式上传硬拒绝。
- `web/src/film/sync/publish-plan.ts`：正式引用校验、权威选择、冲突阻断、代理任务、Candidate-only 回收和 manifest hash。
- `web/src/film/sync/local-session.ts`：Human 确认、expected manifest version/hash 重算、幂等本地回执、localforage 用户 scope 持久化和 STALE 恢复。
- `web/src/film/sync/index.ts`：本轨公开导出。
- `web/src/pages/projects/detail/remote-sync-entry.tsx`：默认不渲染的 Host 项目 UI，只接受用户选择的本地 JSON，二次 Human 确认仅写本地回执。
- `web/src/pages/projects/detail/overview.tsx`：接入 Remote/Hybrid 本地入口；Flag off 时不产生 Film DOM。
- `web/test/fixtures/film-remote-plan.json`：固定 UUID/version/hash/Host opaque ID 的离线 fixture。
- `web/test/film-remote-sync.test.ts`：权威矩阵、安全边界、引用校验、确定性 hash、零写入 guard、幂等回执和恢复测试。
- `web/test/film-remote-entry.test.tsx`：Host UI 默认关闭、显式入口和零网络本地预演测试。

## 验证结果

### 专项测试

命令：`cd web && bun test test/film-remote-sync.test.ts test/film-remote-entry.test.tsx`

结果：`15 pass / 0 fail / 84 expect()`。

覆盖：

- 默认关闭、本地权威、无网络动作；
- `LOCAL_ONLY` 仅创建本地代理任务且 `upload_intent=NONE`；
- Film ID/entity type/version/hash 分歧全部显式阻断；
- Remote Authority 缺远端事实时禁止静默回退；
- 远端结果 Candidate-only，必须本地批准；
- UUIDv4/version/SHA-256/无路径 Host opaque ID、Candidate 类型与资产 availability 绑定校验；
- 运行时拒绝开启网络与隐式上传；
- 相同输入生成相同 manifest hash。
- Flag off 不读本地存储、不产生 Remote DOM；Host 项目 ID 不匹配零写入。
- Human 未确认、version/hash 漂移、Preview blocker、持久化失败都不返回本地成功回执。
- 同 `confirmationId` 幂等返回原回执；恢复时重算漂移只返回 `STALE_MANIFEST`。

### 类型检查

命令：`cd web && bun run typecheck`

结果：通过，`tsc --noEmit` 退出码 `0`。

### 生产构建

命令：`cd web && bun run build`

结果：通过，`12706 modules transformed`、`built in 2.44s`；仅保留仓库既有的 chunk-size 警告。

### 固定清单抽样

以 fixture 和仅用于离线测试的 `enabled=true / LOCAL_AUTHORITY` 策略生成 Preview：

- `execution_state=PREVIEW_ONLY`
- `manifest_version=1`
- `manifest_hash=d36e09d9d6efa0b3916515b72dca164cf3e282cee778814893267fdff3e3948b`
- `network.executed=false`
- `network.actions=[]`
- 远端结果为 `CANDIDATE_ONLY / REQUIRED / can_auto_promote=false`

## 未完成与阻断边界

- `publishable_after_explicit_execution=true` 只表示本地清单在显式执行前没有 blocker，绝不表示已经发布。
- `proxy_jobs.state=NOT_GENERATED` 只表示需要本地代理，不表示代理已生成。
- 本切片没有共享 Film Contract、OpenAPI、Host 核心表或现有 User Data Sync 改动；不导入 `installRemoteUserDataAutoSync` / `ensureRemoteResourceReferences`。
- 后续接线必须先通过 CR，由对应 Owner 实施，并重新校验 manifest hash、用户授权、对象归属和 Film version/hash。
- Program Integrator 已统一 Host opaque ID 为无路径/无 URL 形式，并补充 Remote Resource、Candidate 类型、重复选择和严格 UTC 时间门禁。
- 真实 Remote 执行器、Host 权限二次校验、部分失败/重试、远端追加审计、上传授权和可核验 publication receipt 仍未实现，不得将本地 receipt 宣称为远端发布成功。

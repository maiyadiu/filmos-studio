# Track 12 证据

## 交付状态

`OFFLINE_PREVIEW_IMPLEMENTED_NOT_WIRED`

本轨已实现纯本地合同、Preview / Manifest 生成器、fixture 与专项测试。没有 UI/API/后端接线，
没有执行网络请求、远端发布、资源上传、代理生成、远端任务或积分消费。

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
- `web/src/film/sync/index.ts`：本轨公开导出。
- `web/test/fixtures/film-remote-plan.json`：固定 UUID/version/hash/Host opaque ID 的离线 fixture。
- `web/test/film-remote-sync.test.ts`：权威矩阵、安全边界、引用校验和确定性 hash 测试。

## 验证结果

### 专项测试

命令：`cd web && bun test test/film-remote-sync.test.ts`

结果：`8 pass / 0 fail / 46 expect()`。

覆盖：

- 默认关闭、本地权威、无网络动作；
- `LOCAL_ONLY` 仅创建本地代理任务且 `upload_intent=NONE`；
- Film ID/entity type/version/hash 分歧全部显式阻断；
- Remote Authority 缺远端事实时禁止静默回退；
- 远端结果 Candidate-only，必须本地批准；
- UUIDv4/version/SHA-256/Host opaque ID 校验；
- 运行时拒绝开启网络与隐式上传；
- 相同输入生成相同 manifest hash。

### 类型检查

命令：`cd web && bun run typecheck`

结果：通过，`tsc --noEmit` 退出码 `0`。

### 固定清单抽样

以 fixture 和仅用于离线测试的 `enabled=true / LOCAL_AUTHORITY` 策略生成 Preview：

- `execution_state=PREVIEW_ONLY`
- `manifest_hash=0aa29e242a9a433e3da504252c6c08686ee83feb263b5dc2cf71ade1ba2316db`
- `network.executed=false`
- `network.actions=[]`
- 远端结果为 `CANDIDATE_ONLY / REQUIRED / can_auto_promote=false`

## 未完成与阻断边界

- `publishable_after_explicit_execution=true` 只表示本地清单在显式执行前没有 blocker，绝不表示已经发布。
- `proxy_jobs.state=NOT_GENERATED` 只表示需要本地代理，不表示代理已生成。
- 本切片没有共享 Film Contract、OpenAPI、Host 核心表或现有 User Data Sync 改动。
- 后续接线必须先通过 CR，由对应 Owner 实施，并重新校验 manifest hash、用户授权、对象归属和 Film version/hash。

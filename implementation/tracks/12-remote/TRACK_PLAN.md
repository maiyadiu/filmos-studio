# Track 12｜Remote / Hybrid 与协作

TRACK: `12-remote`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

## 当前目标

在 Local-first 不受损的前提下，建立默认关闭的 `LOCAL_AUTHORITY`、
`REMOTE_AUTHORITY`、`HYBRID_LOCAL_AUTHORITY` 合同，以及仅生成本地 Preview / Manifest
和可恢复本地确认回执的选择性发布安全切片。

## 现状核查与 Fit-Gap

| 分类 | 结论 |
| --- | --- |
| `REUSE` | 复用 Host 既有 opaque ID，不解释、不改写；复用 `json-canonicalize` 生成确定性 manifest hash；PostgreSQL、Redis、Resource、Task、User Data、Canvas Share 只作为未来传输与持久层候选。 |
| `EXTEND` | Film Remote 在 `web/src/film/sync/` 保持独立适配层；Host 项目概览仅在 `VITE_FILM_REMOTE_SYNC=true` 时显示本地 JSON 导入和二次 Human 确认。 |
| `BUILD` | 权威模式、正式引用校验、冲突阻断、选中资产清单、Candidate-only 回收、manifest version/hash guard、用户隔离 localforage 会话、幂等确认回执与恢复时重算。 |
| `DEFER` | HTTP/API、后端 `filmhost` 持久化、评论/审阅、代理生成、资源上传、远端任务、冲突解决、正式发布执行器与远端回执全部延期。 |

现有 `user-data-sync` 不能直接承担 Film Local Authority：它在登录时以远端快照替换本地项目/资产，
并在自动保存时遍历本地 `storageKey` 与内嵌媒体、调用资源上传。Film Remote 必须使用显式选择清单，
不得复用这条自动上传写链。

## 首切片边界

1. 默认 `enabled=false`、`LOCAL_AUTHORITY`、`conflict_policy=BLOCK`。
2. `allow_network` 与 `allow_implicit_local_asset_upload` 固定为 `false`；传入 `true` 直接拒绝。
3. 正式引用必须同时包含 Film UUIDv4、正整数 version、小写 SHA-256 和 Host opaque ID。
4. Local/Remote 的 Film ID、entity type、version 或 hash 不一致时，生成显式 blocker，禁止自动选择。
5. `LOCAL_ONLY` 资产只生成本地代理任务，`upload_intent=NONE`，原件与代理均不上传。
6. 远端返回只标记为 `CANDIDATE_ONLY`，必须本地批准，不得自动晋级。
7. 输出始终 `PREVIEW_ONLY`、`network.executed=false`，不包含网络 action、上传记录或发布回执。
8. Host 项目 UI 只导入当前项目的 1 MiB 以内本地 JSON；项目 ID 不一致立即拒绝。
9. 本地确认前重算 manifest；`expectedManifestVersion/hash` 漂移、blocker、存储失败均零回执。
10. 会话按 Host user/project scope 写入 localforage，恢复时重算 manifest；异常只标记 `STALE_MANIFEST`。

## 验证

- `cd web && bun test test/film-remote-sync.test.ts test/film-remote-entry.test.tsx`
- `cd web && bun run typecheck`
- `cd web && bun run build`

## 回滚与依赖

- 回滚：保持 `film.remote_sync=false` / 不设 `VITE_FILM_REMOTE_SYNC=true`；Host 项目 UI 不渲染，原影策流程不受影响，既有本地回执仅保留可恢复。
- 依赖：Track 01、02、06、13；共享接线见 `implementation/CHANGE_REQUESTS/CR-12-001-同步接线.md`。

STATUS: `LOCAL_HOST_UI_AND_RECEIPT_WIRED_REMOTE_EXECUTION_DEFERRED`

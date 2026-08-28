# Film Production Core V0.3

FilmOS Studio 的隔离 Film Core Sidecar。它只保存影视扩展语义、显式 Host ID 映射、Film 版本和审计，不读写 Yingce Host 数据库，不复制 Project、ProjectUnit、Shot、Asset 或 Task 正文。

## 运行

```bash
cd film-core
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
FILMOS_CORE_DB_PATH="$PWD/.local/film-core.sqlite" .venv/bin/filmos-core
```

默认监听 `127.0.0.1:8091`。应用挂载到 FilmOS Studio 时，OpenAPI 的 server base 是 `/film`；直接运行 Sidecar 时路由从 `/health` 开始。若不设 `FILMOS_CORE_DB_PATH`，数据写入当前目录的 `.local/film-core.sqlite`。

## 写入合同

- `entity.create`：`target_id` 必须为 `null`，`expected_version` 必须为 `0`；Film Core 生成 UUIDv4。
- `entity.set_states`：必须提供已存在的 UUIDv4 和精确 `expected_version`；冲突返回 HTTP 409，不覆盖。
- preview 只读；apply 在同一 `BEGIN IMMEDIATE` SQLite 事务中更新实体并追加 `AuditEvent`。
- `audit_events` 有 SQLite trigger 阻止 UPDATE/DELETE。

兼容写入仍只服务 `film_project_extension`、`content_unit_extension`、`shot_extension`。Golden A 的新记录走 `POST /formal-records` 或明确的领域 API：

- 新目标必须携带 `target_id=null`、`expected_version=0` 和 64 位零哈希；ID 始终由 Core 生成 UUIDv4。
- 所有被引用的 Core/Host 映射记录必须携带当前 `expected_version` 与聚合 `expected_content_hash`；任一不一致即 409，且不产生部分记录或审计。
- 普通 ScriptVersion 只能以 unlocked 创建；`POST /script-versions/lock` 仅接受 human actor，并原子创建新的 locked ScriptVersion UUIDv4 与 `approve_for_lock` ScriptDecision。DirectorUnit 必须同时守卫该 locked ScriptVersion 和绑定其当前聚合 hash 的 Decision。
- `DirectorUnit.director_ir_hash` 与 `VisualLockSet.visual_lock_hash` 是裸文本 SHA-256；它们与记录聚合 hash 分开保存和校验。`AssetBinding.asset_content_hash` 保存 Host 资产版本/来源 hash。
- `AssetBinding` 只保存 Film/Host opaque ID、role、priority 与来源 hash，不保存媒体、路径、URL 或二进制。
- Manual Import 只接受安全的本地回执元数据，不包含 Provider 网络执行面；结果先成为 `Candidate`。
- `Review` 不创建 `Approval`；只有声明为 human 的独立批准写入，且必须引用命中当前 Candidate hash 的 passed Review。Candidate 记录本身不改写。

正式记录保存在 Sidecar `formal_records`，对应 `formal_audit_events` 由数据库 trigger 保证追加式。ScriptStructureMap、ImpactEdge、传播 receipt 与 Impact 审计分别使用隔离的 V3 表，均有不可变或追加式 trigger。`film-contracts/openapi.json` 使用 `x-implementation-state` 声明实际状态；V0.3 没有 planned operation。

## Golden A API

```text
GET  /formal-records/{filmEntityId}
POST /formal-records
POST /script-versions/lock
POST /prompts/compile
POST /manual-results/import
POST /reviews
POST /approvals
POST /continuity/check
GET  /script-structure-maps/{filmEntityId}
POST /script-structure-maps
GET  /impacts/{entityId}
POST /impacts
POST /impacts/propagate-stale
```

`/entities/{filmEntityId}` 继续只读取原有三类扩展，避免把兼容读面隐式扩成任意正式记录查询。

## Golden B Impact/STALE 边界

- `ScriptStructureMap` 是 ScriptVersion 的 companion：只保存稳定 section/cue UUIDv4、speaker、顺序、section 范围和 cue 文本 hash；剧本文本仍只在 ScriptVersion。Map 必须绑定当前 ScriptVersion version 与聚合 hash。
- Impact owner 仅允许当前 `ScriptVersion`、`VisualLockSet` 或 `AssetBinding`。每条边固定 owner/source/target 的声明 version+聚合 hash，以及一个 exact `dependency_key + dependency_content_hash + scope`。
- scope 只有 `script_cue`、`script_section`、`visual_lock_component`、`asset_binding_source`。Script cue 使用 `cue_text_hash`；section 使用按 cue order 排序的 canonical `{section_id,start_order,end_order,cues:[{cue_id,cue_text_hash,order}]}` SHA-256；VisualLock 使用 `locks.dependencyHashes`，AssetBinding 使用 `asset_content_hash`。所得 raw/source hash 保存为 edge 的 `dependency_content_hash`，不替代聚合 guard。
- `POST /impacts/propagate-stale` 在一个 `BEGIN IMMEDIATE` 事务内重查 owner/map guard、遍历 exact scope、仅更新命中后代的 `stale_state`、追加审计并保存幂等 receipt。creative/review/lock 等其他轴保持原值。
- 相同 idempotency key 与相同请求只回放既有结果；同 key 不同请求返回 409。图必须无环，遍历上限为 1000 节点、64 层。
- 没有可传播边的 change 进入 `unresolved_changes`，不触发自动 STALE；`replayed=true` 时 unresolved 集保持不变。

## 浏览器 CORS 边界

Film Core 默认只向带显式有效端口的 loopback HTTP Origin 返回 CORS 授权：`http://127.0.0.1:<port>`、`http://localhost:<port>`，以及解析后严格等于 IPv6 `::1` 的合法括号形式。远端、HTTPS、无端口、其他 `127/8` 地址和非 loopback IPv6 不获得授权；不使用 `*`，也不开放 credentials。

预检只允许 `GET`、`POST`、`OPTIONS` 和 `Accept`、`Content-Type`。可用逗号分隔的 `FILMOS_CORE_CORS_ORIGINS` 将默认动态 loopback 范围收窄为精确 Origin；变量中的每一项仍必须是合法 loopback HTTP Origin，非法值会在数据库初始化前令启动失败。

## 验证与合同导出

```bash
cd film-core
.venv/bin/pytest
PYTHONPATH=src .venv/bin/python -m film_production_core.contracts
git diff --exit-code ../film-contracts/openapi.json
python3 ../tests/film-contract/validate_contracts.py
```

必须从当前源码导出；若复用其他 checkout 安装的 console script，可能读取错误 worktree。

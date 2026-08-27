# Film Production Core V0

FilmOS Studio 的隔离 Film Core Sidecar。它只保存影视扩展语义、显式 Host ID 映射、Film 版本和审计，不读写 Yingce Host 数据库，不复制 Project、ProjectUnit、Shot、Asset 或 Task 正文。

## 运行

```bash
cd film-core
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
FILMOS_CORE_DB_PATH="$PWD/.local/film-core.sqlite" .venv/bin/filmos-core
```

默认监听 `127.0.0.1:8091`。应用挂载到 FilmOS Studio 时，OpenAPI 的 server base 是 `/film`；直接运行 Sidecar 时路由从 `/health` 开始。若不设 `FILMOS_CORE_DB_PATH`，数据写入当前目录的 `.local/film-core.sqlite`。

## V0 写入合同

- `entity.create`：`target_id` 必须为 `null`，`expected_version` 必须为 `0`；Film Core 生成 UUIDv4。
- `entity.set_states`：必须提供已存在的 UUIDv4 和精确 `expected_version`；冲突返回 HTTP 409，不覆盖。
- preview 只读；apply 在同一 `BEGIN IMMEDIATE` SQLite 事务中更新实体并追加 `AuditEvent`。
- `audit_events` 有 SQLite trigger 阻止 UPDATE/DELETE。

V0 可写扩展类型为 `film_project_extension`、`content_unit_extension`、`shot_extension`。`film-contracts/openapi.json` 使用 `x-implementation-state` 区分 `implemented` 与 `planned`；Review、Impact/STALE、Prompt compile 和 Continuity 仅是目标合同，当前 Sidecar 没有对应路由，不调用任何外部生成 Provider。

## 验证与合同导出

```bash
cd film-core
.venv/bin/pytest
.venv/bin/filmos-core-export-contracts
git diff --exit-code ../film-contracts/openapi.json
```

# 稳定 ID V0

1. `film_entity_id` 是 Film Core 生成的标准 UUIDv4，创建后不可变。
2. 不得从标题、路径、集数、顺序、内容哈希或 Host ID 派生 Film ID。
3. Host 引用用显式列保存：`host_project_id`、`host_unit_id`、`host_shot_id`、`host_asset_id`、`host_asset_version_id`、`host_canvas_id`、`host_resource_id`。
4. `FilmEntityRef.content_hash` 是 canonical record body 的小写 SHA-256 聚合哈希，用于记录相等、并发守卫与生产血缘，不是实体身份。裸导演 IR、视觉锁文本和 Host 资产来源分别使用 `director_ir_hash`、`visual_lock_hash`、`asset_content_hash`，不得拿它们替代记录聚合哈希。
5. 正式来源引用必须同时携带 `expected_version` 与当前聚合 `expected_content_hash`；任一不匹配都返回冲突，不静默覆盖。
6. 禁止复用已删除实体的 Film ID；审计事件永久保留原 ID。
7. `entity.create` 命令必须传 `target_id: null` 和 `expected_version: 0`；只有 Film Core 可在 apply 时生成 Film ID，客户端不得预选身份。
8. ScriptVersion 是不可变版本对象。Human Script Lock 必须为锁定版生成新的 Film UUIDv4，并用 ScriptDecision 固定 source ID、locked ID 与 locked record hash；不得把原 ScriptVersion 就地改成 locked。

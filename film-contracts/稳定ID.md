# 稳定 ID V0

1. `film_entity_id` 是 Film Core 生成的标准 UUIDv4，创建后不可变。
2. 不得从标题、路径、集数、顺序、内容哈希或 Host ID 派生 Film ID。
3. Host 引用用显式列保存：`host_project_id`、`host_unit_id`、`host_shot_id`、`host_asset_id`、`host_asset_version_id`、`host_canvas_id`、`host_resource_id`。
4. `content_hash` 是小写 SHA-256，用于内容相等与生产血缘，不是实体身份。
5. 正式写入必须携带 `expected_version`；不匹配时返回冲突，不静默覆盖。
6. 禁止复用已删除实体的 Film ID；审计事件永久保留原 ID。


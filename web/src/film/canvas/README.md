# Production Canvas

本目录提供默认关闭的 Film Production Canvas 投影、导航和 Host 正式创建边界。

- Canvas 只持久化 Film 实体 ID、关系、布局和正式快照版本标记，不复制剧本、导演意图、Shot 或审批事实。
- 同一 ContentUnit 只接受一个 `role=production` 的默认画布；发现重复关联时返回冲突，不静默选择。
- 新建正式画布必须二次 Human 确认，携带 `confirmationId`、`expectedRevision` 与当前 Host `SourceText` 的小写 SHA-256。
- 服务端重读 `SourceText` 验哈希；Canvas payload 不保存、不裁决 Film 正式 hash 或状态。
- `CanvasProject` 与 `CanvasUnitLink` 仍是 Host 对象；隔离 companion 只做唯一守卫与追加审计回执。
- Provider 生成结果只能创建 `candidate`；`approved` 必须来自 Film Core 的正式审批链。
- Web 双开关和 Host `CANVAS_FILM_PRODUCTION_CANVAS_WRITE_ENABLED` 均默认关闭。

# Production Canvas 首切片

本目录提供默认关闭的 Film Production Canvas 纯投影和导航决策层。

- Canvas 只持久化 Film 实体 ID、关系、布局和正式快照版本标记，不复制剧本、导演意图、Shot 或审批事实。
- 同一 ContentUnit 只接受一个 `role=production` 的默认画布；发现重复关联时返回冲突，不静默选择。
- 新建正式画布命令必须携带 `expectedRevision` 与小写 SHA-256 `expectedContentHash`。
- Provider 生成结果只能创建 `candidate`；`approved` 必须来自 Film Core 的正式审批链。
- `FILM_PRODUCTION_CANVAS_DEFAULT_ENABLED=false`；共享 Host API 完成并发与唯一性约束前，不接入现有项目 UI。

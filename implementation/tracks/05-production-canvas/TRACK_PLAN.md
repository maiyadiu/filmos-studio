# Track 05｜Production Canvas、DirectorUnit 与 Shot

TRACK: `05-production-canvas`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 目标：每个 ContentUnit 一张可重开复用的生产画布，分离导演意图轨和 Shot 轨。
2. 已核查：CanvasUnitLink、章节画布创建、Storyboard upsert、节点注册、Shot API、Canvas Agent。
3. Fit-Gap：
   - REUSE：现有 CanvasProject、本地/远端同步、`CanvasUnitLink`、Shot API、Storyboard 投影、节点注册和 Canvas Agent 工作流。
   - EXTEND：Film 专用纯投影、五泳道、production 画布复用/冲突导航、revision/hash 写入意图。
   - BUILD：Film Core DirectorUnit/Coverage 正式读写、Host 幂等默认 production 关联、Inspector UI。
   - DEFER：共享 Host 表/API 和 Track 03 页面接入，见 `CR-05-001`；外部生成、上传和审批不在本切片执行。
4. 最小修改：`web/src/film/canvas/` 仅保存 Film 实体 ID、关系、布局和快照标记；默认关闭。
6. 不做：不换画布引擎，不把审批事实写入 Canvas JSON。
7. 影响：见 `FILE_OWNERSHIP.yaml#production_canvas`。
8. 测试：默认关闭、单 Unit 唯一默认画布、重开复用、重复冲突、投影重建、DirectorUnit/Shot 非 1:1、Candidate 边界。
9. 回滚：关闭 `film.production_canvas`。
10. 依赖：Track 02、03、09、13。

STATUS: `FIRST_SLICE_IMPLEMENTED_PENDING_INTEGRATION`

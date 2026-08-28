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
   - DONE：`CR-05-001` Host 专用取得或创建端点、隔离唯一 guard、Human 确认、原子 audit 回执与项目页二次确认 UI。
   - DEFER：外部生成、上传和审批不在本切片执行。
4. 最小修改：复用 Host `CanvasProject`/`CanvasUnitLink`；`ProductionCanvasGuard` 只做唯一性和审计 companion，画布 JSON 不保存 Film 正式真值。
6. 不做：不换画布引擎，不把审批事实写入 Canvas JSON。
7. 影响：见 `FILE_OWNERSHIP.yaml#production_canvas`。
8. 测试：默认关闭、归属、hash/revision 冲突零写入、并发同 ID、重复历史精确 ID、audit 失败无 orphan、重开复用、投影重建和 Candidate 边界。
9. 回滚：先关闭 Web 双开关和 `CANVAS_FILM_PRODUCTION_CANVAS_WRITE_ENABLED`；保留既有 Canvas/Link/Audit 可读，不自动删除。
10. 依赖：Track 02、03、09、13。

STATUS: `FORMAL_CREATE_BOUNDARY_IMPLEMENTED_PENDING_GOLDEN_C`

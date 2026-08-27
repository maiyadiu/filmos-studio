# Track 05｜Production Canvas、DirectorUnit 与 Shot

TRACK: `05-production-canvas`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 目标：每个 ContentUnit 一张可重开复用的生产画布，分离导演意图轨和 Shot 轨。
2. 待核查：CanvasUnitLink、章节画布创建、Storyboard upsert、节点注册、Shot API、Canvas Agent。
3. 已知线索：`project-chapter-storyboard.ts` 已把 Host Shot 投影为 storyboard row，须本轨复核调用链。
4. Fit-Gap：核查后记录。
5. 最小修改：Film 节点和 Inspector 放扩展目录；Canvas 仅存 ID/布局。
6. 不做：不换画布引擎，不把审批事实写入 Canvas JSON。
7. 影响：见 `FILE_OWNERSHIP.yaml#production_canvas`。
8. 测试：单 Unit 唯一默认画布、重开幂等、投影重建、DirectorUnit/Shot 非 1:1。
9. 回滚：关闭 `film.production_canvas`。
10. 依赖：Track 02、03、09、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


# Track 09｜SceneTwin 与导演台

TRACK: `09-director`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：用 SceneTwin 和独立机位/调度/姿态/构图版本维持空间连续性。
2. 已核查：影策 3D 导演台调用链、Tigerowo 全景/Camera/Timeline/关键帧、Blender 边界和相邻测试。
3. Fit-Gap：
   - REUSE：影策 Three.js Director、对象/演员/骨骼/姿态、Camera/Light、关键帧/Sequencer、Beauty/Clay/Depth/Normal、本地画布与资产绑定。
   - EXTEND：默认关闭的 DirectorUnit/Shot Coverage、Blocking/Camera/Continuity 领域门禁与纯投影描述。
   - BUILD：Film Core SceneTwin/DirectorUnit 正式合同、ObjectID pass、ApprovedViewFamily、正式审查链。
   - DEFER：Tigerowo iframe/全景/Camera profile 的选择性移植，Blender R4 执行和共享合同改动；见 `CR-09-001`。
4. 差异矩阵与源码证据：见本轨 `EVIDENCE.md`。
5. 最小修改：不改现有导演台；仅在 `web/src/film/director/` 增加纯本地域门禁，SceneTwin 正式真值仍待 Film Core Owner。
6. 不做：不整仓合并 Tigerowo，不锁定未经人审的空间。
7. 影响：见 `FILE_OWNERSHIP.yaml#director`。
8. 测试：UUID/version/hash、DirectorUnit/Shot 多对多、脚/躯干/脸/视线/手/道具链、轴线、RGB/Depth/Normal/ObjectID 投影和 R0-R4。
9. 回滚：关闭 `film.scene_twin`，保留影策导演台原状。
10. 依赖：Track 02、05、06、13。

STATUS: `FIRST_SLICE_IMPLEMENTED_PENDING_INTEGRATION`

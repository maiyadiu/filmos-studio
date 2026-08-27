# Track 09｜SceneTwin 与导演台

TRACK: `09-director`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：用 SceneTwin 和独立机位/调度/姿态/构图版本维持空间连续性。
2. 待核查：影策 3D 导演台调用链、Tigerowo 全景/Camera/Timeline/关键帧、Blender 桥、相邻测试。
3. 已有能力：`UNVERIFIED`。
4. Fit-Gap：必须输出影策/Tigerowo 差异矩阵后决定。
5. 最小修改：仅移植缺口；SceneTwin 用 Sidecar 真值。
6. 不做：不整仓合并 Tigerowo，不锁定未经人审的空间。
7. 影响：见 `FILE_OWNERSHIP.yaml#director`。
8. 测试：坐标系、门/固定道具、人物方位、视线/轴线、RGB/Depth/Normal/ObjectID、R0-R4。
9. 回滚：关闭 `film.scene_twin`，保留影策导演台原状。
10. 依赖：Track 02、05、06、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


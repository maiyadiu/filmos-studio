# Track 06｜Asset Studio、Local Media 与 VisualLock

TRACK: `06-assets`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：在 Host Asset/Version/Representation 上建立用途绑定、VisualLock 和本地媒体血缘。
2. 待核查：Asset 页、模型/服务/测试、StyleProfile、Resource、ShotAssetReference、本地/远端存储。
3. 已知线索：Host 有 AssetVersion/Representation、ProjectAssetLink、Style 快照，须本轨复核。
4. Fit-Gap：核查后记录。
5. 最小修改：用 Sidecar 表达 Binding Purpose/VisualLockSet；媒体内容寻址。
6. 不做：不复制媒体，不在业务对象暴露绝对路径，不自动提升 Candidate。
7. 影响：见 `FILE_OWNERSHIP.yaml#assets`。
8. 测试：SHA-256、外链失效、VisualLock hash、精准 STALE、资产不复制。
9. 回滚：关闭 `film.asset_lock`，保留 Host Asset。
10. 依赖：Track 01、02、09、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


# Track 12｜Remote / Hybrid 与协作

TRACK: `12-remote`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：在 Local-first 不受损的前提下建立 LOCAL/REMOTE/HYBRID 权威模式和选择性发布。
2. 待核查：Remote Sync、PostgreSQL/Redis、Resource 对象存储、Canvas 同步、评论/共享。
3. 已有能力：`UNVERIFIED`。
4. Fit-Gap：核查后记录。
5. 最小修改：权威模式合同和 Publish Plan Preview，不执行上传。
6. 不做：未发布本地资产不自动上传；不静默解决冲突。
7. 影响：见 `FILE_OWNERSHIP.yaml#remote`。
8. 测试：权威矩阵、选择性发布、代理文件、冲突、本地批准。
9. 回滚：关闭 `film.remote_sync`，默认 Local Authority。
10. 依赖：Track 01、02、06、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


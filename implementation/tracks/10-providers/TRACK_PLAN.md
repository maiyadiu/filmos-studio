# Track 10｜CLI、Provider 与 Flova

TRACK: `10-providers`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：Manual/Dreamina/Flova/API/ComfyUI/Blender 进入统一 GenerationAttempt 生命周期。
2. 待核查：Dreamina Runtime、Task 恢复/取消/重试、Comfy Bridge、Flova CLI 真实能力、Provider tests。
3. 已知线索：Host Task 有 provider request/cancel/poll/lease/recovery 字段，须本轨复核服务链。
4. Fit-Gap：核查后记录。
5. 最小修改：先做 ManualWebProvider 打包/导入与 Mock 生命周期。
6. 不做：不外部生成、不消费积分、不让 Flova 成为本地事实源。
7. 影响：见 `FILE_OWNERSHIP.yaml#providers`。
8. 测试：prepare/submit/query/cancel/resume/collect，幂等，回执归一，Candidate-only。
9. 回滚：各 Provider Feature Flag 独立关闭。
10. 依赖：Track 02、07、08、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


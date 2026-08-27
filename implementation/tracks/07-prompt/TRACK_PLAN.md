# Track 07｜Prompt Translation & Learning Kernel

TRACK: `07-prompt`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 目标：导演 IR 编译为模型特定 Prompt/参考图职责，并生成约束覆盖报告。
2. 待核查：Prompt Optimizer/Template/Customization、ModelCapability、StyleExecutionPlan 与旧系统案例。
3. 已有能力：`UNVERIFIED`。
4. Fit-Gap：核查后记录。
5. 最小修改：模型无关 IR、一个手动 Provider 编译出口、覆盖报告。
6. 不做：不用 Prompt 文字代替 VisualLock，不绕过正式生成包。
7. 影响：见 `FILE_OWNERSHIP.yaml#prompt`。
8. 测试：IR 无损、模型能力降级、覆盖报告、Prompt/content/input hash。
9. 回滚：关闭 `film.prompt_kernel`。
10. 依赖：Track 02、06、09、10、13。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


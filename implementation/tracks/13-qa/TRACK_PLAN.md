# Track 13｜QA、Golden、性能与观测

TRACK: `13-qa`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

1. 目标：从第一天建立 Native/Contract/MCP/Golden/Recovery 验收。
2. 待核查：`web/package.json`、`backend/go.mod`、`canvas-agent/package.json`、锁文件、GitHub workflows、相邻测试。
3. 已有能力：已建合同测试和 Golden A 规格骨架，尚未运行。
4. Fit-Gap：`REUSE` 影策原生测试命令；`EXTEND` Film 合同/MCP；`BUILD` Golden/Recovery/观测夹具；`DEFER` 外部真实生成。
5. 最小修改：基线测试清单、Contract Test、Golden A Mock 链。
6. 不做：不删原测试，不跳过 Golden，不把静态阅读写成运行通过。
7. 影响：见 `FILE_OWNERSHIP.yaml#qa`。
8. 测试：测试自测、Mock Provider、恢复、投影重建、纵向血缘与状态门。
9. 回滚：测试/夹具独立，删除新增 Film 测试即可，不改生产数据。
10. 依赖：所有 Track；当前先依赖 Track 00/02。

STATUS: `VERIFY_REQUIRED_BEFORE_CODE`


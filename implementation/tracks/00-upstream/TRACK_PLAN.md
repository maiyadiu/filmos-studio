# Track 00｜上游基线与兼容

TRACK: `00-upstream`  
MODEL: `GPT-5.6 Sol`  
REASONING: `XHigh`

1. 本轨目标：固定稳定 Release，自动发现、差异、候选验证和回滚上游变化。
2. 核查过的真实源：GitHub Release API；`upstream-yingce/main`；`reference-tigerowo/main`；`reference-basket/main`；根 `AGENTS.md`。
3. 已有能力：Git tags/Release，影策上游主干，两个参考仓。
4. Fit-Gap：`REUSE` Git/Release；`BUILD` 差异脚本与兼容报告；`DEFER` 自动合并未通过的 Candidate。
5. 本次最小修改：`scripts/upstream/`、兼容工作流和报告。
6. 明确不做：不合并上游 `main`；不整仓合并参考仓。
7. 影响文件：见 `implementation/FILE_OWNERSHIP.yaml#upstream`。
8. 测试：Release 解析、API/Model/Migration/Canvas/MCP diff，无网络降级，基线哈希校验。
9. 回滚：删除 Track 新增脚本/工作流，回到 `filmos-upstream-v1.2.1`。
10. 依赖：Program Integrator、Track 13。

STATUS: `READY_TO_IMPLEMENT`


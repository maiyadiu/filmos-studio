# Track 13｜QA、Golden、性能与观测

TRACK: `13-qa`  
MODEL: `GPT-5.6 Sol`  
REASONING: `High`

## 1. 本轨目标

从第一批建立可重复的 Native / Contract / MCP / Golden / Recovery 验收面，先记录影策上游真实基线，再为 Golden A 建立不跨外部 Provider 的可执行 Mock 合同。测试状态与业务对象状态分轴记录，不把单元测试或 Mock 通过写成真实产品已批准。

## 2. 已核查的真实现状

- 规则与验收：根 `AGENTS.md`、V6.1 Track 13 / 每日集成 / 节奏 / Definition of Done、V6.2 总令和 Track 强制模板。
- 前端：`web/package.json`、`web/bun.lock`、`web/pnpm-lock.yaml`、`web/test/`。
- 后端：`backend/go.mod`、`backend/go.sum`、75 个 `_test.go` 文件。
- Canvas Agent：`canvas-agent/package.json`、`README.md`、`bun.lock`、26 个测试文件。
- CI：`.github/workflows/quality.yml` 运行后端格式/测试与前端格式/类型/测试，当前未运行 Canvas Agent、Film Contract 或 Golden。
- Film 测试：`tests/film-contract/validate_contracts.py`、`tests/film-golden/README.md`、`golden-a.json`。
- 治理：`implementation/FILE_OWNERSHIP.yaml#qa` 限定本轨为 Golden 测试与测试报告路径。

## 3. 当前已有能力

- `go test ./...`、`bun run test`、`bun run build`、`npm test`、`npm run build` 都有原生命令。
- 前端原生脚本已显式列出 58 个测试文件；Canvas Agent 使用 Node Test Runner 串行执行。
- Film Contract 验证器已检查 Schema V0.1.0、六状态轴、稳定 ID、九条 OpenAPI 路径与 `expected_version`。
- Golden A 原有链路清单和五条不变量，但开工前只是 `NOT_RUN` 静态规格。

## 4. Fit-Gap

- `REUSE`：影策原生后端/前端/Canvas Agent 命令、Bun/Go 锁文件、Film Contract 验证器。
- `EXTEND`：Golden A 规格的状态分轴、观测字段、版本写入门与离线运行回执。
- `BUILD`：Golden A 标准库 Mock、反例状态门测试、本轨证据和原生基线报告。
- `DEFER`：外部真实生成、真实 UI/DB/MCP 纵向链、Golden B/C、恢复/迁移/上游升级演练、性能预算批准。

## 5. 本次最小修改范围

- `implementation/tracks/13-qa/TRACK_PLAN.md`
- `implementation/tracks/13-qa/EVIDENCE.md`
- `implementation/test-reports/基线.md`
- `tests/film-golden/`

## 6. 明确不做

- 不修改 `web/src/`、`backend/`、`canvas-agent/src/` 或其他 Track 所有路径。
- 不删除、跳过、改名原测试；不启动 dev server。
- 不写真实 `.env`、密钥、账号、项目数据库或上传结果。
- 不将 `PASSED` 测试状态与 `Candidate` / `Approved` 业务状态混用。

## 7. 受影响对象

只有测试规格、离线 Mock、测试报告和本轨文档。没有数据库、API、前端、Agent 运行时或公共合同变更。

## 8. 测试计划

1. 每次集成先执行 Film Contract，再运行后端、前端、Canvas Agent 原生命令。
2. Golden A 离线快速门验证链路、分离 ID、`expected_version`、Candidate 门和观测字段。
3. 只将当次实际命令回执记为 `PASSED`；签入规格保持 `NOT_RUN`。
4. 第二批与 Track 02/05/08/09/10 接入真实 Film Core、Canvas Projection、MCP 和 Manual Provider 导入后，再提升为真实 Golden A。
5. 后续单独建立恢复、性能预算、Golden B/C 和上游兼容矩阵。

## 9. 回滚方式

回退本轨单一提交，即可恢复原 `NOT_RUN` Golden A 静态骨架。不需要数据迁移、服务停机或项目数据恢复。本地 `node_modules/`、`dist/` 与 Go 模块缓存为未追踪/已忽略验证产物，不在提交中。

## 10. 与其他 Track 的依赖

- Track 00：上游基线与兼容演练输入。
- Track 02：Film Contract、稳定 ID、正式状态和审计语义。
- Track 05/09：Production Canvas、DirectorUnit/Shot、Scene/Projection 真实实现。
- Track 08：MCP 读写权限和幂等验收。
- Track 10：Manual Provider / Candidate 统一导入。
- Track 11/12：恢复、迁移和 Local/Remote/Hybrid 权威验收。

## 首批完成度

- 原生后端、前端、Canvas Agent 测试/构建已实际执行，结果见 `implementation/test-reports/基线.md`。
- Film Contract 已实际通过。
- Golden A 离线 Mock 本次运行已 `PASSED`，但签入规格仍为 `NOT_RUN`，真实纵向 Golden A 仍 `DEFERRED`。

STATUS: `FIRST_BASELINE_COMPLETE_GOLDEN_A_MOCK_PASSED`

# Film Golden

Golden 是真实纵向链验收，不把单元测试通过写成产品已批准。

- Golden A：故事到关键帧，第一条必通链。
- Golden B：多人长对话，验证 DirectorUnit 与 Shot 非 1:1、Blocking、轴线、视线和视觉锁。
- Golden C：复杂空间和视频，验证 SceneTwin、机位、表演调度、构图、预演和空间连续性。

生成成功只能将结果记为 Candidate。`Approved` 必须有 QC Review 和独立 Approval 记录。

## Golden A 离线基线

`golden-a.json` 是签入仓库的可执行规格，其 `execution.test_status` 固定保持
`NOT_RUN`，不将过去某次执行伪装成当前验收。每次运行单独输出 `PASSED`
或失败；业务对象状态则始终使用 `Candidate` 和 `Approved`。

执行时不启动服务，不读写项目数据，不调用外部 Provider：

```bash
python3 tests/film-golden/test_golden_a.py
python3 tests/film-golden/run_golden_a.py
```

离线 Mock 验证：DirectorUnit 与 Shot 分离、所有正式写入携带
`expected_version`、手动结果首先产生 Candidate、未有 Review 和 Approval 时
禁止进入 Approved，以及 10 个观测字段完整。该骨架是首批合同验收，
不代表真实 UI、数据库、MCP 或 Provider 纵向链已通。

## Golden A 真实 Sidecar 入口

`run_golden_a_real.py` 会启动临时端口与临时 SQLite 的真实 Film Core HTTP
Sidecar，读取其 `/openapi.json`，并要求 D-0005 裁定的正式操作全部存在：

- `POST /formal-records`、`GET /formal-records/{filmEntityId}`；
- `POST /prompts/compile`、`POST /manual-results/import`；
- `POST /reviews`、`POST /approvals`、`POST /continuity/check`。

如果当前 Core 分支尚未提供任一操作，运行结果必须是
`BLOCKED_MISSING_CORE_OPERATION`，并分别报告 `prepared/persisted/reviewed/approved`
均为 `false`、外部调用为 `0`、`fallback_mock_used=false`。它不会退回离线
Mock，也不会把本地准备写成已持久化或已批准。

`golden_a_local.ts` 是真实本地域段：直接复用 Production Canvas 投影、
`compilePromptDraft`、`prepareSubmissionPackage` 和
`importManualProviderResult`。它只能报告 `prepared=true`、`persisted=false`，
ManualImport 结果保持 `Candidate/pending/not_approved`，外部调用固定为 0。
只有完整 Sidecar HTTP 的 Review 与 Human Approval 回执才能改变后续状态。

```bash
FILMOS_CORE_PYTHON="$PWD/film-core/.venv/bin/python" \
  python3 tests/film-golden/test_golden_a_real.py
FILMOS_CORE_PYTHON="$PWD/film-core/.venv/bin/python" \
  python3 tests/film-golden/run_golden_a_real.py
```

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
